"""Behavior engine — the core of simulation realism.

This is where realism lives. Not the database, not the framework.
Agents decide what to do based on who they are, who they trust,
what they're feeling, and what's happening around them.

Features:
- Trust-weighted influence propagation (igraph)
- Emotional contagion through social ties
- Heterogeneous activity (90% lurk, 9% comment, 1% create)
- Memory-informed decisions (grudges, loyalty, fear)
- Stress cascade through org/team networks
- Personality-driven response variation to same events
"""

from __future__ import annotations

import math
import random
import logging
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from nexus_social.core.memory import AgentMemory, MemorySystem, Relationship
from nexus_social.core.personas import Persona, SocialMediaBehavior, StressResponse

logger = logging.getLogger(__name__)


class ActivityType(Enum):
    """What an agent decides to do this tick."""
    SILENT = "silent"              # lurk, observe
    REACT = "react"                # like/dislike existing content
    COMMENT = "comment"            # respond to someone else's post
    POST = "post"                  # create original content
    CREATE_ARTIFACT = "artifact"   # write a doc/memo/report/image
    DM = "dm"                      # private message someone
    SHARE = "share"                # repost/amplify someone else
    CONFRONT = "confront"          # call someone out publicly


@dataclass
class BehaviorDecision:
    """What an agent decided to do and why."""
    agent_id: str
    activity: ActivityType
    target_agent_id: str | None = None  # who they're interacting with
    target_post_id: str | None = None   # what they're reacting to
    emotional_driver: str = ""          # why (for debugging/observation)
    intensity: float = 0.5              # 0-1, how strongly they feel about it
    artifact_type: str | None = None    # doc type if creating artifact


class BehaviorEngine:
    """Determines what each agent does each tick based on the full context.

    This replaces the simple random chance in SimulationRunner._select_active_agents.
    Instead of "roll dice, maybe post", agents make psychologically grounded decisions.
    """

    def __init__(self, memory: MemorySystem):
        self.memory = memory
        self._tick = 0

    def decide_actions(self, tick: int, agents: dict[str, Persona],
                       profiles: dict[str, Any],
                       narrative_tension: float = 0.0,
                       narrative_urgency: float = 0.0,
                       recent_posts: list[dict] | None = None,
                       ) -> list[BehaviorDecision]:
        """For each agent, decide what they do this tick.

        This is the heart of the simulation. Every decision is informed by:
        - Persona (who they are)
        - Memory (what they've experienced)
        - Relationships (who they trust/distrust)
        - Emotional state (stress, morale)
        - Narrative context (what's happening in the world)
        - Social proof (what everyone else is doing)
        - Time of day / fatigue (not everyone acts every tick)
        """
        self._tick = tick
        decisions = []
        recent_posts = recent_posts or []

        # Phase 1: Emotional contagion — stress/morale spread through network
        self._propagate_emotions(agents)

        for agent_id, persona in agents.items():
            mem = self.memory.get(agent_id)
            if not mem:
                continue

            profile = profiles.get(agent_id)
            if not profile:
                continue

            decision = self._decide_single(
                agent_id, persona, mem, profile,
                narrative_tension, narrative_urgency,
                recent_posts,
            )
            decisions.append(decision)

        return decisions

    def _decide_single(self, agent_id: str, persona: Persona,
                       mem: AgentMemory, profile: Any,
                       tension: float, urgency: float,
                       recent_posts: list[dict]) -> BehaviorDecision:
        """Decide what one agent does this tick."""

        # Base activity probability from persona
        base_chance = persona.posting_frequency

        # === Factor 1: Stress modifies behavior ===
        stress_modifier = self._stress_behavior_modifier(persona)

        # === Factor 2: Narrative urgency pulls people in ===
        urgency_pull = urgency * 0.3

        # === Factor 3: Social proof — if lots of people are active, more join ===
        social_proof = min(len(recent_posts) / 20.0, 0.3) if recent_posts else 0

        # === Factor 4: Recency of their own activity (fatigue) ===
        recent_own = [m for m in mem.memories[-5:]
                      if m.event_type in ("posted", "commented") and
                      m.tick >= self._tick - 2]
        fatigue = len(recent_own) * 0.15  # each recent action reduces chance

        # === Factor 5: Something personally relevant happened ===
        personal_trigger = 0.0
        for post in recent_posts:
            # Someone they have strong feelings about posted
            author_id = post.get("author_id", "")
            if author_id and author_id in mem.relationships:
                rel = mem.relationships[author_id]
                if abs(rel.overall_sentiment) > 0.3:
                    personal_trigger = max(personal_trigger, abs(rel.overall_sentiment) * 0.4)
                # High tension = more likely to engage
                if rel.tension > 0.5:
                    personal_trigger = max(personal_trigger, rel.tension * 0.3)

        # Total chance of being active
        active_chance = (
            base_chance
            + stress_modifier
            + urgency_pull
            + social_proof
            + personal_trigger
            - fatigue
        )
        active_chance = max(0.02, min(0.95, active_chance))  # always 2-95% chance

        # Roll the dice
        if random.random() > active_chance:
            return BehaviorDecision(
                agent_id=agent_id,
                activity=ActivityType.SILENT,
                emotional_driver="not compelled to act",
            )

        # Agent IS active — now decide WHAT they do
        return self._choose_activity(agent_id, persona, mem, profile,
                                     tension, recent_posts)

    def _choose_activity(self, agent_id: str, persona: Persona,
                         mem: AgentMemory, profile: Any,
                         tension: float,
                         recent_posts: list[dict]) -> BehaviorDecision:
        """Choose what kind of activity the agent performs."""

        # Build weighted options based on persona + state
        weights: dict[ActivityType, float] = {
            ActivityType.REACT: persona.reaction_probability,
            ActivityType.COMMENT: persona.reply_probability,
            ActivityType.POST: persona.posting_frequency * 0.5,
            ActivityType.SHARE: 0.15,
            ActivityType.DM: persona.dm_probability,
            ActivityType.CREATE_ARTIFACT: 0.0,  # special conditions
            ActivityType.CONFRONT: 0.0,  # special conditions
        }

        # Persona behavior type modifiers
        behavior_boosts = {
            SocialMediaBehavior.POWER_POSTER: {ActivityType.POST: 0.3},
            SocialMediaBehavior.LURKER: {ActivityType.REACT: 0.3, ActivityType.POST: -0.2},
            SocialMediaBehavior.COMMENTER: {ActivityType.COMMENT: 0.3},
            SocialMediaBehavior.SHARER: {ActivityType.SHARE: 0.3},
            SocialMediaBehavior.THOUGHT_LEADER: {ActivityType.POST: 0.2, ActivityType.CREATE_ARTIFACT: 0.15},
            SocialMediaBehavior.REACTOR: {ActivityType.REACT: 0.4},
            SocialMediaBehavior.NETWORKER: {ActivityType.DM: 0.3, ActivityType.SHARE: 0.15},
            SocialMediaBehavior.DEBATER: {ActivityType.COMMENT: 0.3, ActivityType.CONFRONT: 0.1},
        }
        for activity, boost in behavior_boosts.get(persona.social_media_behavior, {}).items():
            weights[activity] = max(0, weights.get(activity, 0) + boost)

        # === High stress + specific personality = artifact creation ===
        # Stressed thought leaders write memos. Stressed analysts write reports.
        if persona.stress_level > 0.6 and persona.social_media_behavior in (
            SocialMediaBehavior.THOUGHT_LEADER, SocialMediaBehavior.POWER_POSTER
        ):
            weights[ActivityType.CREATE_ARTIFACT] += 0.2

        # === High tension with someone + confrontational personality = confront ===
        confrontation_target = None
        if persona.conflict_style.value == "confrontational":
            for target_id, rel in mem.relationships.items():
                if rel.tension > 0.6 and rel.respect < 0.4:
                    weights[ActivityType.CONFRONT] += 0.25
                    confrontation_target = target_id
                    break

        # === Seek allies response under stress ===
        if persona.stress_response == StressResponse.SEEK_ALLIES and persona.stress_level > 0.5:
            weights[ActivityType.DM] += 0.3
            weights[ActivityType.COMMENT] += 0.15

        # === Lash out under stress ===
        if persona.stress_response == StressResponse.LASH_OUT and persona.stress_level > 0.6:
            weights[ActivityType.CONFRONT] += 0.2
            weights[ActivityType.POST] += 0.15

        # === Withdraw under stress ===
        if persona.stress_response == StressResponse.WITHDRAW and persona.stress_level > 0.5:
            for k in weights:
                weights[k] *= 0.4

        # Normalize and pick
        total = sum(max(0, w) for w in weights.values())
        if total == 0:
            return BehaviorDecision(agent_id=agent_id, activity=ActivityType.SILENT,
                                    emotional_driver="overwhelmed, shut down")

        roll = random.random() * total
        cumulative = 0
        chosen = ActivityType.REACT
        for activity, weight in weights.items():
            if weight <= 0:
                continue
            cumulative += weight
            if roll <= cumulative:
                chosen = activity
                break

        # Build the decision with context
        decision = BehaviorDecision(
            agent_id=agent_id,
            activity=chosen,
            intensity=self._compute_intensity(persona, tension),
        )

        # Attach target for targeted actions
        if chosen == ActivityType.CONFRONT and confrontation_target:
            decision.target_agent_id = confrontation_target
            decision.emotional_driver = f"tension with {mem.relationships[confrontation_target].target_name}"
        elif chosen in (ActivityType.COMMENT, ActivityType.REACT, ActivityType.SHARE):
            decision.target_post_id = self._pick_post_to_engage(
                agent_id, persona, mem, recent_posts
            )
            decision.emotional_driver = self._explain_engagement(persona, mem, decision.target_post_id, recent_posts)
        elif chosen == ActivityType.CREATE_ARTIFACT:
            decision.artifact_type = self._pick_artifact_type(persona, profile)
            decision.emotional_driver = f"compelled to write ({persona.stress_level:.1f} stress)"
        elif chosen == ActivityType.POST:
            decision.emotional_driver = self._explain_post_motivation(persona, mem, tension)
        elif chosen == ActivityType.DM:
            decision.target_agent_id = self._pick_dm_target(agent_id, persona, mem)
            decision.emotional_driver = "reaching out"

        return decision

    # ── Emotional Contagion ─────────────────────────────────────────

    def _propagate_emotions(self, agents: dict[str, Persona]):
        """Spread stress and morale through trust networks.

        If your close ally is stressed, you get stressed.
        If your team is demoralized, your morale drops.
        This creates realistic cascade effects.
        """
        updates: list[tuple[str, float, float]] = []  # (agent_id, stress_delta, morale_delta)

        for agent_id, persona in agents.items():
            mem = self.memory.get(agent_id)
            if not mem:
                continue

            stress_pressure = 0.0
            morale_pressure = 0.0
            influence_total = 0.0

            for target_id, rel in mem.relationships.items():
                target_persona = agents.get(target_id)
                if not target_persona:
                    continue

                # Influence weight = trust * warmth (close trusted people affect you more)
                influence = rel.trust * rel.warmth
                if influence < 0.1:
                    continue

                influence_total += influence

                # Stress contagion: their stress pulls yours toward theirs
                stress_diff = target_persona.stress_level - persona.stress_level
                stress_pressure += stress_diff * influence * 0.1

                # Morale contagion: similar but weaker
                morale_diff = target_persona.morale - persona.morale
                morale_pressure += morale_diff * influence * 0.05

            if influence_total > 0:
                # Dampen: personality affects susceptibility
                susceptibility = self._emotional_susceptibility(persona)
                stress_delta = stress_pressure * susceptibility
                morale_delta = morale_pressure * susceptibility
                updates.append((agent_id, stress_delta, morale_delta))

        # Apply updates
        for agent_id, stress_d, morale_d in updates:
            persona = agents[agent_id]
            persona.stress_level = max(0.0, min(1.0, persona.stress_level + stress_d))
            persona.morale = max(0.0, min(1.0, persona.morale + morale_d))

    def _emotional_susceptibility(self, persona: Persona) -> float:
        """How susceptible is this persona to emotional contagion?"""
        base = 0.5
        # Empathetic people absorb more
        if persona.emotional_tendency.value == "empathetic":
            base += 0.3
        # Independent people resist more
        elif persona.emotional_tendency.value == "independent":
            base -= 0.2
        # Reserved people resist more
        elif persona.emotional_tendency.value == "reserved":
            base -= 0.15
        # Already stressed = more susceptible (cascading)
        base += persona.stress_level * 0.2
        return max(0.1, min(1.0, base))

    # ── Stress Behavior Modifiers ───────────────────────────────────

    def _stress_behavior_modifier(self, persona: Persona) -> float:
        """How does stress change this persona's activity level?"""
        if persona.stress_level < 0.3:
            return 0  # not stressed, no modifier

        stress = persona.stress_level
        response = persona.stress_response

        if response == StressResponse.WITHDRAW:
            return -stress * 0.4  # go quiet
        elif response == StressResponse.LASH_OUT:
            return stress * 0.3  # post more, angrier
        elif response == StressResponse.OVERWORK:
            return stress * 0.35  # post more, working through it
        elif response == StressResponse.SEEK_ALLIES:
            return stress * 0.2  # reach out more
        elif response == StressResponse.DEFLECT:
            return stress * 0.1  # slight increase, using humor
        elif response == StressResponse.MICROMANAGE:
            return stress * 0.25  # more comments/reactions
        return 0

    # ── Decision Support ────────────────────────────────────────────

    def _compute_intensity(self, persona: Persona, tension: float) -> float:
        """How intense is this agent's action? Affects tone of generated content."""
        base = 0.5
        # Stress increases intensity
        base += persona.stress_level * 0.3
        # Low morale can increase or decrease intensity
        if persona.morale < 0.3:
            if persona.emotional_tendency.value in ("passionate", "competitive"):
                base += 0.2  # angry posting
            else:
                base -= 0.1  # deflated
        # Narrative tension
        base += tension * 0.2
        return max(0.1, min(1.0, base))

    def _pick_post_to_engage(self, agent_id: str, persona: Persona,
                             mem: AgentMemory,
                             recent_posts: list[dict]) -> str | None:
        """Pick which post to engage with. Not random — preference-based."""
        if not recent_posts:
            return None

        scored: list[tuple[str, float]] = []
        for post in recent_posts:
            score = 0.0
            author_id = post.get("author_id", "")
            post_id = post.get("id", post.get("post_id", ""))

            # Posts by people they have a relationship with score higher
            if author_id and author_id in mem.relationships:
                rel = mem.relationships[author_id]
                # Friends' posts get attention
                if rel.overall_sentiment > 0.2:
                    score += rel.overall_sentiment * 2
                # Rivals' posts also get attention (different kind)
                if rel.tension > 0.4:
                    score += rel.tension * 1.5

            # Posts from same org score higher (in-group bias)
            if post.get("author_org") == getattr(getattr(mem, '_profile', None), 'org', {}).get('name', ''):
                score += 0.5

            # Popular posts get more attention (social proof)
            likes = post.get("like_count", post.get("likes", 0))
            comments = post.get("comments", [])
            comment_count = len(comments) if isinstance(comments, list) else 0
            score += math.log1p(likes + comment_count) * 0.3

            # Recency
            score += 0.5  # base score for existing

            # Add some randomness (not everything is calculated)
            score += random.random() * 0.5

            scored.append((str(post_id), score))

        if not scored:
            return None

        # Weighted random selection (higher scored posts more likely)
        scored.sort(key=lambda x: x[1], reverse=True)
        # Take top 5, pick weighted random
        top = scored[:5]
        total = sum(s for _, s in top)
        if total == 0:
            return top[0][0] if top else None

        roll = random.random() * total
        cumulative = 0
        for pid, score in top:
            cumulative += score
            if roll <= cumulative:
                return pid
        return top[0][0]

    def _pick_artifact_type(self, persona: Persona, profile: Any) -> str:
        """What kind of artifact does this agent create?"""
        role = getattr(profile, 'role', None)
        role_val = role.value if role else "general"

        artifact_map = {
            "analyst": ["intelligence_brief", "threat_assessment", "situation_report"],
            "researcher": ["research_report", "analysis", "white_paper"],
            "engineer": ["technical_report", "incident_report", "architecture_doc"],
            "commander": ["operational_order", "situation_report", "directive"],
            "strategist": ["strategy_memo", "position_paper", "assessment"],
            "correspondent": ["field_report", "expose", "photo_essay"],
            "diplomat": ["diplomatic_cable", "talking_points", "negotiation_memo"],
            "executive": ["executive_memo", "all_hands_update", "policy_directive"],
            "marketing": ["campaign_brief", "market_analysis", "press_release"],
        }

        options = artifact_map.get(role_val, ["memo", "report", "update"])
        return random.choice(options)

    def _pick_dm_target(self, agent_id: str, persona: Persona,
                        mem: AgentMemory) -> str | None:
        """Who does this agent DM?"""
        # Under stress, reach out to trusted allies
        if persona.stress_level > 0.5:
            allies = [(tid, r) for tid, r in mem.relationships.items()
                      if r.trust > 0.6 and r.warmth > 0.5]
            if allies:
                allies.sort(key=lambda x: x[1].trust, reverse=True)
                return allies[0][0]

        # Otherwise, most interacted with
        active = [(tid, r) for tid, r in mem.relationships.items()
                  if r.interaction_count > 0]
        if active:
            active.sort(key=lambda x: x[1].interaction_count, reverse=True)
            return active[0][0]

        return None

    def _explain_engagement(self, persona: Persona, mem: AgentMemory,
                            post_id: str | None,
                            recent_posts: list[dict]) -> str:
        """Generate a human-readable explanation for why the agent engaged."""
        if not post_id:
            return "browsing the feed"

        post = next((p for p in recent_posts
                     if str(p.get("id", p.get("post_id", ""))) == post_id), None)
        if not post:
            return "reacting to content"

        author_id = post.get("author_id", "")
        if author_id and author_id in mem.relationships:
            rel = mem.relationships[author_id]
            if rel.tension > 0.5:
                return f"can't let {rel.target_name}'s post go unchallenged"
            if rel.trust > 0.7:
                return f"supporting {rel.target_name}"
            if rel.overall_sentiment < -0.2:
                return f"disagreeing with {rel.target_name}"

        return "something in the feed caught their attention"

    def _explain_post_motivation(self, persona: Persona, mem: AgentMemory,
                                 tension: float) -> str:
        """Why is this agent posting original content?"""
        if persona.stress_level > 0.7:
            stress_reasons = {
                StressResponse.LASH_OUT: "venting frustration",
                StressResponse.OVERWORK: "working through stress by documenting",
                StressResponse.DEFLECT: "deflecting with humor",
                StressResponse.SEEK_ALLIES: "rallying support",
            }
            reason = stress_reasons.get(persona.stress_response, "processing stress")
            return reason

        if tension > 0.6:
            return "responding to escalating situation"

        if persona.morale > 0.7:
            return "feeling good, sharing perspective"

        recent_salient = mem.get_salient_memories(1)
        if recent_salient:
            return f"processing: {recent_salient[0].summary[:50]}"

        return "sharing thoughts"
