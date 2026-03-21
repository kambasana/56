"""Narrative arc engine - drives evolving storylines, tensions, and events.

Each scenario has a NarrativeArc that defines phases of the story,
tension escalation points, and events that fire at specific ticks
to drive agent behavior and create realistic drama.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from typing import Any


@dataclass
class NarrativeEvent:
    """A story event that fires at a specific point in the simulation."""

    tick_trigger: int  # which tick this fires on (0 = immediate)
    name: str
    description: str  # what happens - broadcast to all agents
    # How this event affects agents
    stress_impact: float = 0.0  # added to all agents' stress (-1 to 1)
    morale_impact: float = 0.0  # added to all agents' morale (-1 to 1)
    # Optional: only affect specific orgs or roles
    target_orgs: list[str] = field(default_factory=list)
    target_roles: list[str] = field(default_factory=list)
    # Tags for content generation to reference
    tags: list[str] = field(default_factory=list)
    fired: bool = False

    def to_dict(self) -> dict:
        return {
            "tick_trigger": self.tick_trigger,
            "name": self.name,
            "description": self.description,
            "stress_impact": self.stress_impact,
            "morale_impact": self.morale_impact,
            "target_orgs": self.target_orgs,
            "target_roles": self.target_roles,
            "tags": self.tags,
            "fired": self.fired,
        }


@dataclass
class NarrativePhase:
    """A phase of the story arc - the situation evolves through phases."""

    name: str
    description: str  # describes the overall situation during this phase
    start_tick: int
    # Ambient conditions during this phase
    base_tension: float = 0.3  # 0-1, general tension level
    base_urgency: float = 0.3  # 0-1, time pressure
    # What topics agents should be thinking/posting about
    active_themes: list[str] = field(default_factory=list)
    # Situational details that agents can reference
    situation_details: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "description": self.description,
            "start_tick": self.start_tick,
            "base_tension": self.base_tension,
            "base_urgency": self.base_urgency,
            "active_themes": self.active_themes,
            "situation_details": self.situation_details,
        }


@dataclass
class NarrativeArc:
    """Complete narrative arc for a scenario."""

    scenario_name: str
    phases: list[NarrativePhase] = field(default_factory=list)
    events: list[NarrativeEvent] = field(default_factory=list)
    # Interpersonal tensions baked into the scenario
    # Format: {"agent_name_1 vs agent_name_2": "description of tension"}
    baked_tensions: dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "scenario_name": self.scenario_name,
            "phases": [p.to_dict() for p in self.phases],
            "events": [e.to_dict() for e in self.events],
            "baked_tensions": self.baked_tensions,
        }


class NarrativeEngine:
    """Runs the narrative arc, firing events and managing phases."""

    def __init__(self, arc: NarrativeArc | None = None):
        self.arc = arc
        self._current_phase_idx = 0
        self.fired_events: list[NarrativeEvent] = []

    @property
    def current_phase(self) -> NarrativePhase | None:
        if not self.arc or not self.arc.phases:
            return None
        return self.arc.phases[self._current_phase_idx]

    @property
    def tension_level(self) -> float:
        phase = self.current_phase
        return phase.base_tension if phase else 0.3

    @property
    def urgency_level(self) -> float:
        phase = self.current_phase
        return phase.base_urgency if phase else 0.3

    @property
    def active_themes(self) -> list[str]:
        phase = self.current_phase
        return phase.active_themes if phase else []

    @property
    def situation_summary(self) -> str:
        phase = self.current_phase
        if not phase:
            return "Normal operations."
        details = random.choice(phase.situation_details) if phase.situation_details else ""
        return f"{phase.description} {details}".strip()

    def tick(self, tick_count: int) -> list[NarrativeEvent]:
        """Advance narrative state. Returns events that fired this tick."""
        if not self.arc:
            return []

        # Advance phase if needed
        for i, phase in enumerate(self.arc.phases):
            if phase.start_tick <= tick_count:
                self._current_phase_idx = i

        # Fire any events for this tick
        newly_fired = []
        for event in self.arc.events:
            if event.tick_trigger == tick_count and not event.fired:
                event.fired = True
                self.fired_events.append(event)
                newly_fired.append(event)

        return newly_fired

    def get_context_for_agent(self, agent_name: str, agent_role: str,
                              agent_org: str) -> str:
        """Build narrative context string for a specific agent."""
        parts = []

        phase = self.current_phase
        if phase:
            parts.append(f"SITUATION: {phase.description}")

            if phase.situation_details:
                # Give each agent a slightly different detail to reference
                detail = random.choice(phase.situation_details)
                parts.append(f"DETAIL: {detail}")

            if phase.active_themes:
                parts.append(f"KEY ISSUES: {', '.join(phase.active_themes)}")

        # Any tensions involving this agent
        if self.arc:
            for tension_key, tension_desc in self.arc.baked_tensions.items():
                if agent_name.lower() in tension_key.lower():
                    parts.append(f"TENSION: {tension_desc}")

        # Recent fired events (last 3)
        recent_events = self.fired_events[-3:]
        for evt in recent_events:
            # Check if this event targets this agent
            if evt.target_orgs and agent_org not in evt.target_orgs:
                continue
            if evt.target_roles and agent_role not in evt.target_roles:
                continue
            parts.append(f"EVENT: {evt.description}")

        return " | ".join(parts) if parts else ""

    def get_stress_modifier(self) -> float:
        """Get current stress modifier from narrative state."""
        phase = self.current_phase
        if not phase:
            return 0.0
        return phase.base_tension * 0.3

    def to_dict(self) -> dict:
        return {
            "arc": self.arc.to_dict() if self.arc else None,
            "current_phase": self.current_phase.to_dict() if self.current_phase else None,
            "fired_events": [e.to_dict() for e in self.fired_events],
            "tension_level": self.tension_level,
            "urgency_level": self.urgency_level,
        }
