"""Simulation runner - orchestrates OASIS, narrative engine, and memory system.

This is the main loop that:
1. Advances the narrative arc (fires events, updates phases)
2. Updates agent emotional states based on narrative
3. Pushes situational context into OASIS agent prompts
4. Steps OASIS to let agents act
5. Records interactions in the memory system
6. Queries the OASIS DB for analysis
"""

from __future__ import annotations

import logging
import random
import sqlite3
from datetime import datetime
from typing import Any

from nexus_social.core.memory import MemorySystem
from nexus_social.core.models import AgentProfile
from nexus_social.core.narrative import NarrativeEngine, NarrativeEvent
from nexus_social.oasis_engine.bridge import OASISBridge

logger = logging.getLogger(__name__)


class SimulationRunner:
    """Orchestrates the full simulation: OASIS + narrative + memory."""

    def __init__(self, bridge: OASISBridge, narrative: NarrativeEngine,
                 memory: MemorySystem):
        self.bridge = bridge
        self.narrative = narrative
        self.memory = memory
        self.tick_count = 0
        self.tick_log: list[dict] = []

    async def initialize(self, agents: list[AgentProfile]):
        """Seed agents into OASIS and initialize all systems."""
        # Seed OASIS
        self.bridge.seed_agents(agents)
        await self.bridge.initialize()

        # Register agents in memory system
        for agent in agents:
            persona = getattr(agent, "_persona", None)
            trust_baseline = persona.trust_baseline if persona else 0.5
            self.memory.register_agent(agent.id, agent.name, trust_baseline)

        # Apply baked-in tensions from narrative
        if self.narrative.arc:
            for tension_key, tension_desc in self.narrative.arc.baked_tensions.items():
                # Parse "Name1 vs Name2" format
                parts = tension_key.split(" vs ")
                if len(parts) == 2:
                    name1, name2 = parts[0].strip(), parts[1].strip()
                    id1 = self._find_agent_id_by_name(name1)
                    id2 = self._find_agent_id_by_name(name2)
                    if id1 and id2:
                        self.memory.record_interaction(
                            0, id1, id2, name2, "baked_tension",
                            f"Pre-existing tension: {tension_desc}",
                            tension_delta=0.3, trust_delta=-0.2,
                        )
                        self.memory.record_interaction(
                            0, id2, id1, name1, "baked_tension",
                            f"Pre-existing tension: {tension_desc}",
                            tension_delta=0.3, trust_delta=-0.2,
                        )

        logger.info("Simulation runner initialized")

    async def tick(self) -> dict:
        """Run one simulation tick. Returns tick summary."""
        self.tick_count += 1

        # 1. Advance narrative
        narrative_events = self.narrative.tick(self.tick_count)

        # 2. Process narrative events
        for evt in narrative_events:
            await self._process_narrative_event(evt)

        # 3. Update agent contexts from narrative + memory
        self._update_agent_contexts()

        # 4. Decide which agents are active this tick
        active_ids = self._select_active_agents()

        # 5. Step OASIS
        if active_ids:
            await self.bridge.step_all_llm(active_ids)

        # 6. Record what happened in memory (query OASIS DB)
        new_activity = self._scan_new_activity()

        # 7. Build tick summary
        summary = {
            "tick": self.tick_count,
            "narrative_events": [e.name for e in narrative_events],
            "active_agents": len(active_ids),
            "phase": self.narrative.current_phase.name if self.narrative.current_phase else "none",
            "tension": self.narrative.tension_level,
            "new_posts": new_activity.get("new_posts", 0),
            "new_comments": new_activity.get("new_comments", 0),
        }
        self.tick_log.append(summary)

        logger.info(
            f"Tick {self.tick_count}: {len(narrative_events)} events, "
            f"{len(active_ids)} active agents, "
            f"{new_activity.get('new_posts', 0)} new posts"
        )
        return summary

    async def _process_narrative_event(self, event: NarrativeEvent):
        """Process a narrative event - update agents and optionally inject posts."""
        # Broadcast to memory system
        self.memory.broadcast_event(
            self.tick_count,
            event.description,
            emotional_impact=event.morale_impact - event.stress_impact,
            salience=0.8,
        )

        # Update persona stress/morale
        for agent_id, persona in self.bridge._persona_map.items():
            profile = self.bridge.get_profile(agent_id)
            if not profile:
                continue

            # Check if event targets this agent
            if event.target_orgs and profile.org.name not in event.target_orgs:
                continue
            if event.target_roles and profile.role.value not in event.target_roles:
                continue

            persona.stress_level = max(0.0, min(1.0,
                persona.stress_level + event.stress_impact))
            persona.morale = max(0.0, min(1.0,
                persona.morale + event.morale_impact))

            # Check if stress triggers hit
            for trigger in persona.stress_triggers:
                if trigger.lower() in event.description.lower():
                    persona.stress_level = min(1.0, persona.stress_level + 0.15)
                    break

        # Inject a system post about the event (from "SITUATION REPORT")
        # Pick a random commander/leader type to post about it
        leaders = [
            aid for aid, p in self.bridge._profile_map.items()
            if p.role.value in ("commander", "executive", "strategist", "diplomat")
        ]
        if leaders:
            poster_id = random.choice(leaders)
            profile = self.bridge.get_profile(poster_id)
            persona = self.bridge.get_persona(poster_id)
            if profile and persona:
                # Use a verbal tic if available
                prefix = random.choice(persona.verbal_tics) + " " if persona.verbal_tics else ""
                await self.bridge.inject_post(
                    poster_id,
                    f"{prefix}{event.description}"
                )

    def _update_agent_contexts(self):
        """Push current narrative + memory state into each agent's OASIS profile."""
        for agent_id, profile in self.bridge._profile_map.items():
            persona = self.bridge.get_persona(agent_id)
            if not persona:
                continue

            # Build situation from narrative
            narrative_ctx = self.narrative.get_context_for_agent(
                profile.name, profile.role.value, profile.org.name
            )

            # Build memory context
            mem = self.memory.get(agent_id)
            memory_ctx = mem.build_context_string(self.tick_count) if mem else ""

            # Combine
            situation = f"{narrative_ctx} | {memory_ctx}" if memory_ctx else narrative_ctx
            if not situation:
                situation = "Normal operations."

            # Push to OASIS agent
            self.bridge.update_agent_situation(
                agent_id, situation,
                persona.stress_level, persona.morale,
            )

    def _select_active_agents(self) -> list[str]:
        """Select which agents act this tick based on persona + narrative."""
        active = []
        urgency = self.narrative.urgency_level

        for agent_id, persona in self.bridge._persona_map.items():
            # Base chance from persona posting frequency
            base_chance = persona.posting_frequency

            # Urgency increases activity for everyone
            chance = base_chance + urgency * 0.3

            # Stress modifies behavior
            if persona.stress_level > 0.7:
                if persona.stress_response.value in ("withdraw", "avoidant"):
                    chance *= 0.4  # go quiet under stress
                elif persona.stress_response.value in ("lash_out", "overwork"):
                    chance *= 1.5  # post MORE under stress

            # Power posters and debaters always more likely
            from nexus_social.core.personas import SocialMediaBehavior
            if persona.social_media_behavior in (SocialMediaBehavior.POWER_POSTER,
                                                  SocialMediaBehavior.DEBATER):
                chance *= 1.3

            if random.random() < min(chance, 0.95):
                active.append(agent_id)

        return active

    def _scan_new_activity(self) -> dict:
        """Query OASIS DB for new posts/comments and record in memory."""
        stats = {"new_posts": 0, "new_comments": 0}

        try:
            conn = sqlite3.connect(self.bridge.db_path)
            conn.row_factory = sqlite3.Row

            # Get recent posts
            posts = conn.execute(
                "SELECT * FROM post ORDER BY created_at DESC LIMIT 20"
            ).fetchall()

            for post in posts:
                stats["new_posts"] += 1

            # Get recent comments
            comments = conn.execute(
                "SELECT * FROM comment ORDER BY created_at DESC LIMIT 20"
            ).fetchall()

            for comment in comments:
                stats["new_comments"] += 1

            conn.close()
        except Exception as e:
            logger.debug(f"DB scan: {e}")

        return stats

    def _find_agent_id_by_name(self, name: str) -> str | None:
        """Find an agent ID by partial name match."""
        for aid, profile in self.bridge._profile_map.items():
            if name.lower() in profile.name.lower():
                return aid
        return None

    async def run(self, ticks: int, callback=None) -> list[dict]:
        """Run multiple ticks. Optional callback(tick_summary) after each."""
        results = []
        for _ in range(ticks):
            summary = await self.tick()
            results.append(summary)
            if callback:
                callback(summary)
        return results

    async def shutdown(self):
        """Clean shutdown."""
        await self.bridge.close()
