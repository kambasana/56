"""Agent memory and relationship tracking system.

Gives agents persistent memory of events, opinions about other agents,
and evolving relationship dynamics that influence their behavior.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any


class RelationshipType(Enum):
    TRUST = "trust"
    RIVALRY = "rivalry"
    MENTORSHIP = "mentorship"
    RESENTMENT = "resentment"
    ALLIANCE = "alliance"
    SUSPICION = "suspicion"
    RESPECT = "respect"
    INDIFFERENCE = "indifference"


@dataclass
class MemoryEntry:
    """A single memory - something the agent experienced or observed."""

    tick: int
    event_type: str  # "saw_post", "was_mentioned", "received_dm", "narrative_event", etc.
    summary: str  # human-readable description of what happened
    about_agent: str | None = None  # agent ID this memory is about
    emotional_impact: float = 0.0  # -1 (negative) to +1 (positive)
    salience: float = 0.5  # 0-1, how important/memorable this is
    timestamp: datetime | None = None


@dataclass
class Relationship:
    """How one agent feels about another, tracked over time."""

    target_id: str
    target_name: str
    # Core dimensions
    trust: float = 0.5  # 0-1
    respect: float = 0.5  # 0-1
    warmth: float = 0.5  # 0-1, personal liking
    tension: float = 0.0  # 0-1, accumulated friction
    # Qualitative
    tags: list[str] = field(default_factory=list)  # "ally", "rival", "mentor", etc.
    last_interaction_tick: int = 0
    interaction_count: int = 0
    # What they think about this person (evolves)
    opinion: str = ""

    @property
    def overall_sentiment(self) -> float:
        """Composite sentiment toward this person, -1 to 1."""
        return (self.trust + self.respect + self.warmth - self.tension * 2) / 3 - 0.5

    @property
    def dominant_type(self) -> RelationshipType:
        """Determine the dominant relationship dynamic."""
        if self.tension > 0.7:
            return RelationshipType.RIVALRY if self.respect > 0.5 else RelationshipType.RESENTMENT
        if self.trust > 0.7 and self.warmth > 0.6:
            return RelationshipType.ALLIANCE
        if self.trust < 0.3:
            return RelationshipType.SUSPICION
        if self.respect > 0.7 and self.warmth < 0.4:
            return RelationshipType.RESPECT
        if self.interaction_count < 3:
            return RelationshipType.INDIFFERENCE
        return RelationshipType.TRUST

    def to_dict(self) -> dict:
        return {
            "target_id": self.target_id,
            "target_name": self.target_name,
            "trust": round(self.trust, 2),
            "respect": round(self.respect, 2),
            "warmth": round(self.warmth, 2),
            "tension": round(self.tension, 2),
            "tags": self.tags,
            "overall_sentiment": round(self.overall_sentiment, 2),
            "dominant_type": self.dominant_type.value,
            "opinion": self.opinion,
            "interaction_count": self.interaction_count,
        }


class AgentMemory:
    """Memory system for a single agent. Tracks events and relationships."""

    def __init__(self, agent_id: str, agent_name: str, trust_baseline: float = 0.5):
        self.agent_id = agent_id
        self.agent_name = agent_name
        self.trust_baseline = trust_baseline
        self.memories: list[MemoryEntry] = []
        self.relationships: dict[str, Relationship] = {}  # target_id -> Relationship
        self._max_memories = 200  # cap to prevent unbounded growth

    def remember(self, tick: int, event_type: str, summary: str,
                 about_agent: str | None = None, emotional_impact: float = 0.0,
                 salience: float = 0.5, timestamp: datetime | None = None):
        """Record a new memory."""
        entry = MemoryEntry(
            tick=tick,
            event_type=event_type,
            summary=summary,
            about_agent=about_agent,
            emotional_impact=emotional_impact,
            salience=salience,
            timestamp=timestamp,
        )
        self.memories.append(entry)
        # Prune low-salience memories if over cap
        if len(self.memories) > self._max_memories:
            self.memories.sort(key=lambda m: m.salience, reverse=True)
            self.memories = self.memories[:self._max_memories]

    def get_relationship(self, target_id: str, target_name: str = "") -> Relationship:
        """Get or create relationship with another agent."""
        if target_id not in self.relationships:
            self.relationships[target_id] = Relationship(
                target_id=target_id,
                target_name=target_name,
                trust=self.trust_baseline,
                respect=0.5,
                warmth=0.4,
            )
        return self.relationships[target_id]

    def update_relationship(self, target_id: str, target_name: str, tick: int,
                            event: str, *,
                            trust_delta: float = 0.0,
                            respect_delta: float = 0.0,
                            warmth_delta: float = 0.0,
                            tension_delta: float = 0.0):
        """Update relationship based on an interaction."""
        rel = self.get_relationship(target_id, target_name)
        rel.trust = max(0.0, min(1.0, rel.trust + trust_delta))
        rel.respect = max(0.0, min(1.0, rel.respect + respect_delta))
        rel.warmth = max(0.0, min(1.0, rel.warmth + warmth_delta))
        rel.tension = max(0.0, min(1.0, rel.tension + tension_delta))
        rel.last_interaction_tick = tick
        rel.interaction_count += 1

        # Auto-generate opinion based on current state
        rel.opinion = self._generate_opinion(rel, event)

    def _generate_opinion(self, rel: Relationship, recent_event: str) -> str:
        """Generate a qualitative opinion string based on relationship state."""
        rt = rel.dominant_type
        opinions = {
            RelationshipType.ALLIANCE: [
                f"I trust {rel.target_name}. We see things the same way.",
                f"{rel.target_name} has my back. That's rare.",
                f"Solid operator. {rel.target_name} delivers.",
            ],
            RelationshipType.RIVALRY: [
                f"{rel.target_name} is competent but we clash on approach.",
                f"Respect {rel.target_name}'s skill, not their judgment.",
                f"We push each other. Not always productively.",
            ],
            RelationshipType.RESENTMENT: [
                f"{rel.target_name} has made things harder for everyone.",
                f"Don't trust {rel.target_name}'s motives.",
                f"The less I deal with {rel.target_name}, the better.",
            ],
            RelationshipType.SUSPICION: [
                f"Something's off about {rel.target_name}. Can't pin it down.",
                f"I'm watching {rel.target_name}. Not convinced yet.",
                f"{rel.target_name} says the right things. Too right.",
            ],
            RelationshipType.RESPECT: [
                f"{rel.target_name} knows their stuff. We're not close, but I respect the work.",
                f"Professional relationship with {rel.target_name}. That's sufficient.",
            ],
            RelationshipType.INDIFFERENCE: [
                f"Don't know {rel.target_name} well enough to have an opinion.",
                f"{rel.target_name} - haven't worked together much.",
            ],
            RelationshipType.TRUST: [
                f"{rel.target_name} is reliable. Good to work with.",
                f"I can count on {rel.target_name} when it matters.",
            ],
            RelationshipType.MENTORSHIP: [
                f"I've learned from {rel.target_name}. Important relationship.",
            ],
        }
        return random.choice(opinions.get(rt, [f"Working relationship with {rel.target_name}."]))

    def get_recent_memories(self, n: int = 10, event_type: str | None = None,
                            about_agent: str | None = None) -> list[MemoryEntry]:
        """Get recent memories, optionally filtered."""
        filtered = self.memories
        if event_type:
            filtered = [m for m in filtered if m.event_type == event_type]
        if about_agent:
            filtered = [m for m in filtered if m.about_agent == about_agent]
        return filtered[-n:]

    def get_salient_memories(self, n: int = 5) -> list[MemoryEntry]:
        """Get the most important memories (highest salience)."""
        return sorted(self.memories, key=lambda m: m.salience, reverse=True)[:n]

    def get_emotional_state_summary(self) -> str:
        """Summarize recent emotional trajectory."""
        recent = self.memories[-10:]
        if not recent:
            return "calm and settled"
        avg_impact = sum(m.emotional_impact for m in recent) / len(recent)
        if avg_impact > 0.3:
            return "energized and positive"
        if avg_impact > 0.1:
            return "cautiously optimistic"
        if avg_impact < -0.3:
            return "stressed and on edge"
        if avg_impact < -0.1:
            return "uneasy and watchful"
        return "steady, focused"

    def build_context_string(self, tick: int) -> str:
        """Build a context string for content generation - what this agent
        knows, feels, and remembers right now."""
        parts = []

        # Emotional state
        parts.append(f"Current state: {self.get_emotional_state_summary()}")

        # Recent significant memories
        salient = self.get_salient_memories(3)
        if salient:
            parts.append("Key memories: " + "; ".join(m.summary for m in salient))

        # Recent events
        recent = self.get_recent_memories(3)
        if recent:
            recent_strs = [m.summary for m in recent if m.tick >= tick - 3]
            if recent_strs:
                parts.append("Recent: " + "; ".join(recent_strs))

        # Key relationships
        strong_rels = sorted(
            self.relationships.values(),
            key=lambda r: abs(r.overall_sentiment),
            reverse=True,
        )[:3]
        if strong_rels:
            rel_strs = [f"{r.target_name}: {r.opinion}" for r in strong_rels if r.opinion]
            if rel_strs:
                parts.append("Relationships: " + "; ".join(rel_strs))

        return " | ".join(parts)

    def to_dict(self) -> dict:
        return {
            "agent_id": self.agent_id,
            "memory_count": len(self.memories),
            "relationships": {
                tid: r.to_dict() for tid, r in self.relationships.items()
            },
            "emotional_state": self.get_emotional_state_summary(),
            "recent_memories": [
                {"tick": m.tick, "type": m.event_type, "summary": m.summary}
                for m in self.memories[-5:]
            ],
        }


class MemorySystem:
    """Manages memories for all agents in the simulation."""

    def __init__(self):
        self.agents: dict[str, AgentMemory] = {}

    def register_agent(self, agent_id: str, agent_name: str,
                       trust_baseline: float = 0.5):
        """Register an agent in the memory system."""
        self.agents[agent_id] = AgentMemory(agent_id, agent_name, trust_baseline)

    def get(self, agent_id: str) -> AgentMemory | None:
        return self.agents.get(agent_id)

    def record_interaction(self, tick: int, actor_id: str, target_id: str,
                           target_name: str, interaction_type: str,
                           summary: str, *,
                           emotional_impact: float = 0.0,
                           salience: float = 0.5,
                           trust_delta: float = 0.0,
                           respect_delta: float = 0.0,
                           warmth_delta: float = 0.0,
                           tension_delta: float = 0.0):
        """Record an interaction and update both memory and relationship."""
        mem = self.get(actor_id)
        if mem:
            mem.remember(tick, interaction_type, summary,
                         about_agent=target_id,
                         emotional_impact=emotional_impact,
                         salience=salience)
            mem.update_relationship(
                target_id, target_name, tick, interaction_type,
                trust_delta=trust_delta, respect_delta=respect_delta,
                warmth_delta=warmth_delta, tension_delta=tension_delta,
            )

    def broadcast_event(self, tick: int, summary: str,
                        emotional_impact: float = 0.0,
                        salience: float = 0.7):
        """Record a narrative event in all agents' memories."""
        for mem in self.agents.values():
            mem.remember(tick, "narrative_event", summary,
                         emotional_impact=emotional_impact,
                         salience=salience)

    def to_dict(self) -> dict:
        return {
            agent_id: mem.to_dict()
            for agent_id, mem in self.agents.items()
        }
