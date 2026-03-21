"""Counterfactual injection — mid-simulation variable manipulation.

MiroFish lets users inject new variables and watch divergence.
We go further: structured injection types with cascading effects
through the behavior engine.

Example injections:
- "What if this news breaks?" → inject as document + narrative event
- "What if this agent defects?" → modify trust/relationships
- "What if supply lines are cut?" → inject stress + resource event
- "What if two orgs merge?" → restructure graph
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any

logger = logging.getLogger(__name__)


class InjectionType(Enum):
    """Types of counterfactual injections."""
    NEWS_BREAK = "news_break"           # new information enters the system
    AGENT_DEFECTION = "agent_defection" # an agent switches allegiance
    RESOURCE_SHOCK = "resource_shock"   # supply/resource disruption
    LEADERSHIP_CHANGE = "leadership_change"  # leader replaced
    ALLIANCE_SHIFT = "alliance_shift"   # org relationship changes
    CRISIS_EVENT = "crisis_event"       # emergency event
    LEAK = "leak"                       # confidential info becomes public
    TECHNOLOGY_CHANGE = "technology_change"  # new capability introduced
    CUSTOM = "custom"                   # user-defined


@dataclass
class Injection:
    """A counterfactual injection into the simulation."""
    injection_type: InjectionType
    description: str
    tick: int  # when it takes effect
    id: str = field(default_factory=lambda: str(uuid.uuid4())[:8])
    created_at: datetime = field(default_factory=datetime.utcnow)

    # Effects
    stress_impact: dict[str, float] = field(default_factory=dict)   # agent_id -> delta
    morale_impact: dict[str, float] = field(default_factory=dict)   # agent_id -> delta
    trust_impact: list[dict] = field(default_factory=list)          # [{from, to, delta}]
    narrative_event: str | None = None  # description of what happened
    document_content: str | None = None  # document that gets created
    target_orgs: list[str] = field(default_factory=list)
    target_agents: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "type": self.injection_type.value,
            "description": self.description,
            "tick": self.tick,
            "target_orgs": self.target_orgs,
            "target_agents": self.target_agents,
            "narrative_event": self.narrative_event,
            "has_document": self.document_content is not None,
        }


class CounterfactualEngine:
    """Manages counterfactual injections into the simulation.

    Injections are queued and applied at the specified tick.
    Each injection type has structured effects that propagate
    through the behavior engine and social network.
    """

    def __init__(self):
        self.pending: list[Injection] = []
        self.applied: list[Injection] = []
        self.snapshots: dict[int, dict] = {}  # tick -> state snapshot before injection

    def queue_injection(self, injection: Injection):
        """Queue an injection for future application."""
        self.pending.append(injection)
        self.pending.sort(key=lambda i: i.tick)
        logger.info(f"Queued injection: {injection.injection_type.value} at tick {injection.tick}")

    def get_due_injections(self, tick: int) -> list[Injection]:
        """Get all injections due at this tick."""
        due = [i for i in self.pending if i.tick <= tick]
        self.pending = [i for i in self.pending if i.tick > tick]
        return due

    def apply_injection(self, injection: Injection,
                        agents: dict[str, Any],
                        memory_system: Any,
                        bridge: Any) -> dict[str, Any]:
        """Apply an injection's effects to the simulation state.

        Returns a summary of what changed.
        """
        changes = {
            "injection_id": injection.id,
            "type": injection.injection_type.value,
            "stress_changes": [],
            "morale_changes": [],
            "trust_changes": [],
            "narrative_posted": False,
        }

        # Apply stress impacts
        for agent_id, delta in injection.stress_impact.items():
            persona = agents.get(agent_id)
            if persona:
                old = persona.stress_level
                persona.stress_level = max(0.0, min(1.0, persona.stress_level + delta))
                changes["stress_changes"].append({
                    "agent": agent_id, "old": round(old, 2),
                    "new": round(persona.stress_level, 2),
                })

        # Apply morale impacts
        for agent_id, delta in injection.morale_impact.items():
            persona = agents.get(agent_id)
            if persona:
                old = persona.morale
                persona.morale = max(0.0, min(1.0, persona.morale + delta))
                changes["morale_changes"].append({
                    "agent": agent_id, "old": round(old, 2),
                    "new": round(persona.morale, 2),
                })

        # Apply trust impacts
        for trust_change in injection.trust_impact:
            from_id = trust_change.get("from", "")
            to_id = trust_change.get("to", "")
            delta = trust_change.get("delta", 0)
            if memory_system:
                mem = memory_system.get(from_id)
                if mem and to_id in mem.relationships:
                    old = mem.relationships[to_id].trust
                    mem.relationships[to_id].trust = max(
                        0.0, min(1.0, mem.relationships[to_id].trust + delta)
                    )
                    changes["trust_changes"].append({
                        "from": from_id, "to": to_id,
                        "old": round(old, 2),
                        "new": round(mem.relationships[to_id].trust, 2),
                    })

        # Broadcast narrative event
        if injection.narrative_event and memory_system:
            memory_system.broadcast_event(
                injection.tick,
                injection.narrative_event,
                emotional_impact=-0.3,  # injections are usually disruptive
                salience=0.9,
            )
            changes["narrative_posted"] = True

        self.applied.append(injection)
        logger.info(f"Applied injection {injection.id}: {injection.description}")
        return changes

    # ── Injection Builders ──────────────────────────────────────────
    # Convenience methods for common injection patterns

    @staticmethod
    def news_break(tick: int, description: str,
                   target_orgs: list[str] | None = None,
                   stress_delta: float = 0.2,
                   document_content: str | None = None) -> Injection:
        """Create a news break injection."""
        injection = Injection(
            injection_type=InjectionType.NEWS_BREAK,
            description=description,
            tick=tick,
            narrative_event=f"BREAKING: {description}",
            document_content=document_content,
            target_orgs=target_orgs or [],
        )
        # All agents get some stress from unexpected news
        # (caller should populate stress_impact with specific agents)
        return injection

    @staticmethod
    def agent_defection(tick: int, agent_id: str, agent_name: str,
                        from_org: str, to_org: str,
                        allies: list[str] | None = None) -> Injection:
        """Create an agent defection injection."""
        injection = Injection(
            injection_type=InjectionType.AGENT_DEFECTION,
            description=f"{agent_name} has defected from {from_org} to {to_org}",
            tick=tick,
            narrative_event=f"ALERT: {agent_name} has left {from_org} and joined {to_org}",
            target_agents=[agent_id],
            target_orgs=[from_org, to_org],
        )
        # Allies of the defector lose trust
        for ally_id in (allies or []):
            injection.trust_impact.append({
                "from": ally_id, "to": agent_id, "delta": -0.4,
            })
        return injection

    @staticmethod
    def crisis_event(tick: int, description: str,
                     affected_orgs: list[str],
                     severity: float = 0.5) -> Injection:
        """Create a crisis event injection."""
        return Injection(
            injection_type=InjectionType.CRISIS_EVENT,
            description=description,
            tick=tick,
            narrative_event=f"CRISIS: {description}",
            target_orgs=affected_orgs,
            metadata={"severity": severity},
        )

    @staticmethod
    def leak(tick: int, description: str, leaked_content: str,
             source_agent: str | None = None,
             target_orgs: list[str] | None = None) -> Injection:
        """Create a leak injection — confidential info goes public."""
        return Injection(
            injection_type=InjectionType.LEAK,
            description=description,
            tick=tick,
            narrative_event=f"LEAKED: {description}",
            document_content=leaked_content,
            target_agents=[source_agent] if source_agent else [],
            target_orgs=target_orgs or [],
        )

    def get_history(self) -> list[dict]:
        """Get all applied injections."""
        return [i.to_dict() for i in self.applied]
