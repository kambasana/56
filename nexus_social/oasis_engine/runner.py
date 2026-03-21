"""Simulation runner — orchestrates the full stack.

The main loop that ties together:
- OASIS (LLM agent actions)
- Behavior engine (trust propagation, emotional contagion, activity decisions)
- Observer agent (emergent pattern detection)
- Narrative engine (story arcs, events, phases)
- Counterfactual engine (mid-simulation injection)
- GraphRAG (knowledge graph context)
- SurrealDB (persistence, graph queries)
- igraph (algorithms: PageRank, communities, centrality)
- Memory system (agent memories, relationships)
"""

from __future__ import annotations

import logging
import random
from collections import Counter
from typing import Any, Callable

from nexus_social.core.behavior import ActivityType, BehaviorDecision, BehaviorEngine
from nexus_social.core.counterfactual import CounterfactualEngine
from nexus_social.core.memory import MemorySystem
from nexus_social.core.models import AgentProfile
from nexus_social.core.narrative import NarrativeEngine, NarrativeEvent
from nexus_social.core.observer import ObserverAgent
from nexus_social.documents.graphrag import GraphRAGProcessor
from nexus_social.oasis_engine.bridge import OASISBridge
from nexus_social.storage.graph import GraphAnalytics
from nexus_social.storage.surrealdb import SurrealStorage

logger = logging.getLogger(__name__)


class SimulationRunner:
    """Orchestrates the full simulation stack.

    Two input modes:
    1. Scenario mode: narrative arcs drive the simulation, agents generate artifacts
    2. Document mode: uploaded documents feed a knowledge graph, agents react

    Both modes share the same engine underneath.
    """

    def __init__(self, bridge: OASISBridge, narrative: NarrativeEngine,
                 memory: MemorySystem,
                 storage: SurrealStorage | None = None,
                 graph: GraphAnalytics | None = None,
                 graphrag: GraphRAGProcessor | None = None):
        self.bridge = bridge
        self.narrative = narrative
        self.memory = memory
        self.storage = storage
        self.graph = graph or (GraphAnalytics(storage) if storage else None)
        self.graphrag = graphrag

        # Sub-engines
        self.behavior = BehaviorEngine(memory)
        self.observer = ObserverAgent(window_size=10)
        self.counterfactual = CounterfactualEngine()

        # State
        self.tick_count = 0
        self.tick_log: list[dict] = []
        self._last_post_count = 0
        self._last_comment_count = 0

    async def initialize(self, agents: list[AgentProfile]):
        """Seed agents into OASIS, SurrealDB, memory, and relationship graph."""
        # Seed OASIS + SurrealDB (bridge.seed_agents is now async)
        await self.bridge.seed_agents(agents)
        await self.bridge.initialize()

        # Register agents in memory system
        for agent in agents:
            persona = getattr(agent, "_persona", None)
            trust_baseline = persona.trust_baseline if persona else 0.5
            self.memory.register_agent(agent.id, agent.name, trust_baseline)

        # Apply baked-in tensions from narrative
        if self.narrative.arc:
            for tension_key, tension_desc in self.narrative.arc.baked_tensions.items():
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
                        # Sync to SurrealDB
                        if self.storage:
                            rel1 = self.memory.get(id1).relationships.get(id2)
                            if rel1:
                                await self.storage.update_relationship(id1, id2, rel1.to_dict())
                            rel2 = self.memory.get(id2).relationships.get(id1)
                            if rel2:
                                await self.storage.update_relationship(id2, id1, rel2.to_dict())

        # Generate initial network topology (realistic structure)
        if self.graph and len(agents) > 2:
            edges = GraphAnalytics.generate_realistic_topology(
                len(agents), topology="barabasi_albert"
            )
            agent_ids = [a.id for a in agents]
            for source_idx, target_idx in edges:
                if source_idx < len(agent_ids) and target_idx < len(agent_ids):
                    source_id = agent_ids[source_idx]
                    target_id = agent_ids[target_idx]
                    if source_id != target_id:
                        if self.storage:
                            await self.storage.follow(source_id, target_id)

        logger.info("Simulation runner initialized (full stack)")

    async def tick(self) -> dict:
        """Run one simulation tick through the full pipeline.

        Pipeline:
        1. Apply pending counterfactual injections
        2. Advance narrative (fire events, update phases)
        3. Process narrative events (update stress/morale, inject posts)
        4. Behavior engine decides what each agent does
        5. Execute decisions through OASIS
        6. Scan new activity, record in memory + SurrealDB
        7. Observer agent detects emergent patterns
        8. Build and return tick summary
        """
        self.tick_count += 1

        # 1. Apply counterfactual injections due this tick
        injections = self.counterfactual.get_due_injections(self.tick_count)
        injection_results = []
        for injection in injections:
            result = self.counterfactual.apply_injection(
                injection,
                agents=self.bridge._persona_map,
                memory_system=self.memory,
                bridge=self.bridge,
            )
            injection_results.append(result)
            # If injection has a document, process through GraphRAG
            if injection.document_content and self.graphrag:
                self.graphrag.extract_rule_based(
                    injection.document_content, f"injection_{injection.id}"
                )
                if self.storage:
                    await self.graphrag.write_to_surrealdb(self.storage)
            # If injection has a narrative event, inject as post
            if injection.narrative_event:
                leaders = [
                    aid for aid, p in self.bridge._profile_map.items()
                    if p.role.value in ("commander", "executive", "strategist", "correspondent")
                ]
                if leaders:
                    await self.bridge.inject_post(
                        random.choice(leaders), injection.narrative_event
                    )

        # 2. Advance narrative
        narrative_events = self.narrative.tick(self.tick_count)

        # 3. Process narrative events
        for evt in narrative_events:
            await self._process_narrative_event(evt)

        # 4. Update agent contexts (narrative + memory + GraphRAG)
        await self._update_agent_contexts()

        # 5. Get recent posts for behavior engine context
        recent_posts = []
        if self.storage:
            recent_posts = await self.storage.get_feed(limit=20)

        # 6. Behavior engine decides what each agent does
        decisions = self.behavior.decide_actions(
            tick=self.tick_count,
            agents=self.bridge._persona_map,
            profiles=self.bridge._profile_map,
            narrative_tension=self.narrative.tension_level,
            narrative_urgency=self.narrative.urgency_level,
            recent_posts=recent_posts,
        )

        # 7. Execute decisions through OASIS
        await self._execute_decisions(decisions)

        # 8. Scan new activity, record in memory
        new_activity = await self._scan_new_activity()

        # 9. Sync relationships to SurrealDB
        await self._sync_relationships()

        # 10. Observer agent detects patterns
        tick_data = self._build_observer_data(decisions, new_activity)
        new_patterns = self.observer.observe(self.tick_count, tick_data)

        # 11. Build tick summary
        active_decisions = [d for d in decisions if d.activity != ActivityType.SILENT]
        activity_breakdown = Counter(d.activity.value for d in decisions)

        summary = {
            "tick": self.tick_count,
            "narrative_events": [e.name for e in narrative_events],
            "active_agents": len(active_decisions),
            "total_agents": len(decisions),
            "phase": self.narrative.current_phase.name if self.narrative.current_phase else "none",
            "tension": self.narrative.tension_level,
            "urgency": self.narrative.urgency_level,
            "new_posts": new_activity.get("new_posts", 0),
            "new_comments": new_activity.get("new_comments", 0),
            "activity_breakdown": dict(activity_breakdown),
            "emergent_patterns": [p.to_dict() for p in new_patterns],
            "injections_applied": len(injection_results),
            "decisions": [
                {
                    "agent": d.agent_id,
                    "activity": d.activity.value,
                    "driver": d.emotional_driver,
                    "intensity": round(d.intensity, 2),
                }
                for d in active_decisions
            ],
        }
        self.tick_log.append(summary)

        logger.info(
            f"Tick {self.tick_count}: "
            f"{len(active_decisions)}/{len(decisions)} active, "
            f"{new_activity.get('new_posts', 0)} posts, "
            f"{len(new_patterns)} patterns detected"
        )
        return summary

    async def _process_narrative_event(self, event: NarrativeEvent):
        """Process a narrative event — update agents, inject posts, record memories."""
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

            if event.target_orgs and profile.org.name not in event.target_orgs:
                continue
            if event.target_roles and profile.role.value not in event.target_roles:
                continue

            persona.stress_level = max(0.0, min(1.0,
                persona.stress_level + event.stress_impact))
            persona.morale = max(0.0, min(1.0,
                persona.morale + event.morale_impact))

            # Personal stress triggers
            for trigger in persona.stress_triggers:
                if trigger.lower() in event.description.lower():
                    persona.stress_level = min(1.0, persona.stress_level + 0.15)
                    break

            # Sync to SurrealDB
            if self.storage:
                await self.storage.update_agent(agent_id, {
                    "stress": persona.stress_level,
                    "morale": persona.morale,
                })

        # A leader posts about the event
        leaders = [
            aid for aid, p in self.bridge._profile_map.items()
            if p.role.value in ("commander", "executive", "strategist", "diplomat")
        ]
        if leaders:
            poster_id = random.choice(leaders)
            persona = self.bridge.get_persona(poster_id)
            if persona:
                prefix = random.choice(persona.verbal_tics) + " " if persona.verbal_tics else ""
                await self.bridge.inject_post(poster_id, f"{prefix}{event.description}")

        # Store event in SurrealDB
        if self.storage:
            import uuid
            await self.storage.db.create(f"sim_event:{uuid.uuid4().hex[:8]}", {
                "event_type": "narrative",
                "description": event.description,
                "tick": self.tick_count,
                "participants": [],
                "metadata": {
                    "stress_impact": event.stress_impact,
                    "morale_impact": event.morale_impact,
                    "target_orgs": event.target_orgs,
                    "target_roles": event.target_roles,
                    "tags": event.tags,
                },
            })

    async def _update_agent_contexts(self):
        """Push narrative + memory + GraphRAG context into each agent's OASIS profile."""
        for agent_id, profile in self.bridge._profile_map.items():
            persona = self.bridge.get_persona(agent_id)
            if not persona:
                continue

            # Narrative context
            narrative_ctx = self.narrative.get_context_for_agent(
                profile.name, profile.role.value, profile.org.name
            )

            # Memory context
            mem = self.memory.get(agent_id)
            memory_ctx = mem.build_context_string(self.tick_count) if mem else ""

            # GraphRAG knowledge context (if document mode is active)
            graphrag_ctx = ""
            if self.graphrag:
                graphrag_ctx = self.graphrag.get_context_for_agent(
                    profile.org.name,
                    profile.role.value,
                    profile.expertise if hasattr(profile, 'expertise') else [],
                )

            # Combine all context
            parts = [p for p in [narrative_ctx, memory_ctx, graphrag_ctx] if p]
            situation = " | ".join(parts) if parts else "Normal operations."

            # Push to OASIS agent (now async)
            await self.bridge.update_agent_situation(
                agent_id, situation,
                persona.stress_level, persona.morale,
            )

    async def _execute_decisions(self, decisions: list[BehaviorDecision]):
        """Execute behavior engine decisions through OASIS.

        Maps BehaviorDecision types to OASIS actions:
        - POST, CREATE_ARTIFACT → LLMAction (agent generates content via LLM)
        - COMMENT → LLMAction (agent sees feed, responds)
        - REACT → LLMAction (agent likes/dislikes)
        - SHARE → LLMAction (agent reposts)
        - CONFRONT → LLMAction (agent posts, high intensity)
        - DM → LLMAction (future: ManualAction for DMs)
        - SILENT → skip
        """
        active_ids = []
        for decision in decisions:
            if decision.activity == ActivityType.SILENT:
                continue

            # For artifact creation, update the agent's prompt to include artifact instruction
            if decision.activity == ActivityType.CREATE_ARTIFACT:
                persona = self.bridge.get_persona(decision.agent_id)
                profile = self.bridge.get_profile(decision.agent_id)
                if persona and profile:
                    artifact_instruction = (
                        f"You feel compelled to write a {decision.artifact_type or 'document'}. "
                        f"Write it as a social media post sharing your professional analysis. "
                        f"Reason: {decision.emotional_driver}."
                    )
                    current_situation = persona.to_dict().get("situation", "")
                    await self.bridge.update_agent_situation(
                        decision.agent_id,
                        f"{current_situation} | WRITE: {artifact_instruction}",
                        persona.stress_level, persona.morale,
                    )

            # For confrontations, heighten the agent's prompt
            if decision.activity == ActivityType.CONFRONT and decision.target_agent_id:
                persona = self.bridge.get_persona(decision.agent_id)
                if persona:
                    target_name = ""
                    mem = self.memory.get(decision.agent_id)
                    if mem and decision.target_agent_id in mem.relationships:
                        target_name = mem.relationships[decision.target_agent_id].target_name
                    await self.bridge.update_agent_situation(
                        decision.agent_id,
                        f"You need to address concerns about {target_name}. "
                        f"Driver: {decision.emotional_driver}.",
                        persona.stress_level, persona.morale,
                    )

            active_ids.append(decision.agent_id)

        # Step OASIS with all active agents
        if active_ids:
            await self.bridge.step_all_llm(active_ids)

    @staticmethod
    def _extract_id(record_ref) -> str:
        """Extract clean agent ID from SurrealDB record reference."""
        s = str(record_ref)
        if ":" in s:
            return s.split(":", 1)[1]
        return s

    async def _scan_new_activity(self) -> dict:
        """Scan for new activity, record in memory, and build relationships.

        When Bob comments on Alice's post, this:
        1. Records in both agents' memory
        2. Updates their relationship (warmth, interaction count)
        3. The relationship change affects future behavior decisions

        This is the compounding loop that makes simulations realistic.
        """
        stats = {"new_posts": 0, "new_comments": 0, "posts": [], "comments": []}

        if self.storage:
            try:
                # Count posts and comments
                post_rows = self.storage._rows(await self.storage.db.query(
                    "SELECT count() AS cnt FROM post GROUP ALL"
                ))
                comment_rows = self.storage._rows(await self.storage.db.query(
                    "SELECT count() AS cnt FROM comment GROUP ALL"
                ))
                current_posts = post_rows[0]["cnt"] if post_rows else 0
                current_comments = comment_rows[0]["cnt"] if comment_rows else 0

                stats["new_posts"] = max(0, current_posts - self._last_post_count)
                stats["new_comments"] = max(0, current_comments - self._last_comment_count)
                self._last_post_count = current_posts
                self._last_comment_count = current_comments

                # --- Process new posts ---
                if stats["new_posts"] > 0:
                    new_posts = await self.storage.get_feed(limit=stats["new_posts"])
                    stats["posts"] = new_posts

                    for post in new_posts:
                        author_id = self._extract_id(post.get("author", ""))
                        content = post.get("content", "")[:100]
                        author_name = post.get("author_name", "someone")

                        # Author remembers posting
                        mem = self.memory.get(author_id)
                        if mem:
                            mem.remember(
                                self.tick_count, "posted",
                                f"Posted: {content}",
                                salience=0.4,
                            )

                        # Others see it (not everyone — simulates feed algorithm)
                        for agent_id in self.bridge._persona_map:
                            if agent_id == author_id:
                                continue
                            other_mem = self.memory.get(agent_id)
                            if not other_mem:
                                continue
                            # Followers see it 60% of the time, others 15%
                            is_follower = author_id in other_mem.relationships
                            see_chance = 0.6 if is_follower else 0.15
                            if random.random() < see_chance:
                                other_mem.remember(
                                    self.tick_count, "saw_post",
                                    f"Saw {author_name} post: {content}",
                                    about_agent=author_id,
                                    salience=0.3,
                                )

                # --- Process new comments (build relationships) ---
                if stats["new_comments"] > 0:
                    new_comments = self.storage._rows(await self.storage.db.query(
                        "SELECT *, author AS commenter, post.author AS poster, "
                        "author.name AS commenter_name, post.author.name AS poster_name "
                        "FROM comment ORDER BY created_at DESC LIMIT $limit",
                        {"limit": stats["new_comments"]}
                    ))
                    stats["comments"] = new_comments

                    for comment in new_comments:
                        commenter_id = self._extract_id(comment.get("commenter", ""))
                        poster_id = self._extract_id(comment.get("poster", ""))
                        commenter_name = comment.get("commenter_name", "someone")
                        poster_name = comment.get("poster_name", "someone")
                        content = comment.get("content", "")[:80]

                        if not commenter_id or not poster_id or commenter_id == poster_id:
                            continue

                        # Commenter remembers commenting
                        c_mem = self.memory.get(commenter_id)
                        if c_mem:
                            c_mem.remember(
                                self.tick_count, "commented",
                                f"Commented on {poster_name}'s post: {content}",
                                about_agent=poster_id,
                                salience=0.4,
                            )

                        # Poster remembers being commented on
                        p_mem = self.memory.get(poster_id)
                        if p_mem:
                            p_mem.remember(
                                self.tick_count, "received_comment",
                                f"{commenter_name} commented on my post: {content}",
                                about_agent=commenter_id,
                                emotional_impact=0.1,
                                salience=0.5,
                            )

                        # Update relationship: commenting builds warmth and interaction
                        self.memory.record_interaction(
                            self.tick_count, commenter_id, poster_id,
                            poster_name, "comment",
                            f"Commented on {poster_name}'s post",
                            warmth_delta=0.05, respect_delta=0.02,
                        )
                        # Poster also gets a relationship update with commenter
                        self.memory.record_interaction(
                            self.tick_count, poster_id, commenter_id,
                            commenter_name, "received_comment",
                            f"{commenter_name} engaged with my post",
                            warmth_delta=0.03, respect_delta=0.01,
                        )

            except Exception as e:
                logger.error(f"Error scanning SurrealDB activity: {e}")
        else:
            # Fallback: OASIS SQLite
            try:
                import sqlite3
                conn = sqlite3.connect(self.bridge.db_path)
                conn.row_factory = sqlite3.Row
                posts = conn.execute(
                    "SELECT * FROM post ORDER BY created_at DESC LIMIT 20"
                ).fetchall()
                stats["new_posts"] = len(posts)
                comments = conn.execute(
                    "SELECT * FROM comment ORDER BY created_at DESC LIMIT 20"
                ).fetchall()
                stats["new_comments"] = len(comments)
                conn.close()
            except Exception as e:
                logger.debug(f"DB scan fallback: {e}")

        return stats

    async def _sync_relationships(self):
        """Sync memory system relationships to SurrealDB."""
        if not self.storage:
            return

        for agent_id, mem in self.memory.agents.items():
            for target_id, rel in mem.relationships.items():
                # Only sync relationships that changed this tick
                if rel.last_interaction_tick == self.tick_count:
                    await self.storage.update_relationship(
                        agent_id, target_id, rel.to_dict()
                    )

    def _build_observer_data(self, decisions: list[BehaviorDecision],
                             new_activity: dict) -> dict:
        """Build the data dict the observer agent expects."""
        # Agent state
        agents_data = {}
        for agent_id, persona in self.bridge._persona_map.items():
            profile = self.bridge.get_profile(agent_id)
            agents_data[agent_id] = {
                "name": persona.name,
                "org": profile.org.name if profile else "unknown",
                "team": profile.team.name if profile else "unknown",
                "stress": persona.stress_level,
                "morale": persona.morale,
            }

        # Post counts per agent and org
        agent_post_counts = Counter()
        org_post_counts = Counter()
        for d in decisions:
            if d.activity in (ActivityType.POST, ActivityType.CREATE_ARTIFACT):
                agent_post_counts[d.agent_id] += 1
                profile = self.bridge.get_profile(d.agent_id)
                if profile:
                    org_post_counts[profile.org.name] += 1

        # Cross-org interactions
        cross_org = []
        for d in decisions:
            if d.activity in (ActivityType.COMMENT, ActivityType.CONFRONT) and d.target_post_id:
                # Find the post author's org
                for post in new_activity.get("posts", []):
                    post_id = str(post.get("id", post.get("post_id", "")))
                    if post_id == d.target_post_id:
                        commenter_profile = self.bridge.get_profile(d.agent_id)
                        poster_org = post.get("author_org", "")
                        if commenter_profile and poster_org and commenter_profile.org.name != poster_org:
                            cross_org.append({
                                "agent1": d.agent_id,
                                "org1": commenter_profile.org.name,
                                "agent2": post.get("author_id", ""),
                                "org2": poster_org,
                            })

        # Org interaction matrix (who talks to who)
        org_matrix: dict[str, dict[str, int]] = {}
        for d in decisions:
            if d.activity == ActivityType.SILENT:
                continue
            profile = self.bridge.get_profile(d.agent_id)
            if not profile:
                continue
            org = profile.org.name
            if org not in org_matrix:
                org_matrix[org] = {}
            # Self-interaction for posts
            if d.activity in (ActivityType.POST, ActivityType.CREATE_ARTIFACT):
                org_matrix[org][org] = org_matrix[org].get(org, 0) + 1

        for item in cross_org:
            org1, org2 = item["org1"], item["org2"]
            if org1 not in org_matrix:
                org_matrix[org1] = {}
            org_matrix[org1][org2] = org_matrix[org1].get(org2, 0) + 1

        return {
            "agents": agents_data,
            "agent_post_counts": dict(agent_post_counts),
            "org_post_counts": dict(org_post_counts),
            "cross_org_interactions": cross_org,
            "org_interaction_matrix": org_matrix,
            "new_posts": new_activity.get("new_posts", 0),
            "new_comments": new_activity.get("new_comments", 0),
        }

    def _find_agent_id_by_name(self, name: str) -> str | None:
        """Find an agent ID by partial name match."""
        for aid, profile in self.bridge._profile_map.items():
            if name.lower() in profile.name.lower():
                return aid
        return None

    # ── Public API ──────────────────────────────────────────────────

    async def run(self, ticks: int,
                  callback: Callable[[dict], Any] | None = None) -> list[dict]:
        """Run multiple ticks. Optional async or sync callback after each."""
        results = []
        for _ in range(ticks):
            summary = await self.tick()
            results.append(summary)
            if callback:
                result = callback(summary)
                # Support async callbacks
                if hasattr(result, '__await__'):
                    await result
        return results

    async def inject(self, injection_type: str, description: str,
                     tick: int | None = None, **kwargs) -> dict:
        """Convenience method for injecting counterfactuals.

        Usage:
            await runner.inject("news_break", "Cyber attack detected",
                                target_orgs=["NovaTech"])
            await runner.inject("leak", "Classified memo leaked",
                                leaked_content="...", source_agent="agent_id")
        """
        from nexus_social.core.counterfactual import CounterfactualEngine, InjectionType

        target_tick = tick or (self.tick_count + 1)

        builders = {
            "news_break": CounterfactualEngine.news_break,
            "crisis_event": CounterfactualEngine.crisis_event,
            "leak": CounterfactualEngine.leak,
            "agent_defection": CounterfactualEngine.agent_defection,
        }

        builder = builders.get(injection_type)
        if builder:
            injection = builder(target_tick, description, **kwargs)
        else:
            from nexus_social.core.counterfactual import Injection
            injection = Injection(
                injection_type=InjectionType.CUSTOM,
                description=description,
                tick=target_tick,
                narrative_event=description,
                **kwargs,
            )

        self.counterfactual.queue_injection(injection)
        return injection.to_dict()

    async def ingest_document(self, text: str, doc_id: str,
                              use_llm: bool = False) -> dict:
        """Document mode: ingest a document into the knowledge graph.

        The knowledge graph gets written to SurrealDB and agents use it
        as context on subsequent ticks.
        """
        if not self.graphrag:
            self.graphrag = GraphRAGProcessor(llm_extract=use_llm)

        if use_llm:
            # Returns the prompt — caller needs to send to LLM and call parse
            prompt = self.graphrag.build_llm_extraction_prompt(text)
            return {"mode": "llm", "prompt": prompt, "doc_id": doc_id}
        else:
            kg = self.graphrag.extract_rule_based(text, doc_id)
            if self.storage:
                await self.graphrag.write_to_surrealdb(self.storage)
            return {
                "mode": "rule_based",
                "entities": len(kg.entities),
                "relations": len(kg.relations),
                "topics": kg.topics,
            }

    def get_observer_summary(self) -> dict:
        """Get the observer agent's current analysis."""
        return self.observer.get_summary()

    def get_all_patterns(self) -> list[dict]:
        """Get all detected emergent patterns."""
        return self.observer.get_all_patterns()

    async def get_influence_rankings(self) -> list[dict]:
        """Get agent influence rankings via igraph PageRank."""
        if self.graph:
            return await self.graph.pagerank()
        return []

    async def get_communities(self) -> list[dict]:
        """Get detected communities via igraph."""
        if self.graph:
            return await self.graph.community_summary()
        return []

    async def shutdown(self):
        """Clean shutdown of all systems."""
        await self.bridge.close()
        if self.storage:
            await self.storage.close()
