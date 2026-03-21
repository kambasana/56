"""Tests for the behavior engine — trust propagation, emotional contagion, activity decisions."""

import pytest

from nexus_social.core.behavior import ActivityType, BehaviorDecision, BehaviorEngine
from nexus_social.core.memory import MemorySystem
from nexus_social.core.personas import (
    CommunicationStyle,
    ConflictStyle,
    EmotionalTendency,
    Persona,
    SocialMediaBehavior,
    StressResponse,
)


@pytest.fixture
def memory():
    mem = MemorySystem()
    mem.register_agent("alice", "Alice", trust_baseline=0.5)
    mem.register_agent("bob", "Bob", trust_baseline=0.5)
    mem.register_agent("carol", "Carol", trust_baseline=0.5)
    return mem


@pytest.fixture
def agents():
    return {
        "alice": Persona(
            name="Alice", stress_level=0.2, morale=0.7,
            posting_frequency=0.6,
            social_media_behavior=SocialMediaBehavior.POWER_POSTER,
            stress_response=StressResponse.LASH_OUT,
            emotional_tendency=EmotionalTendency.PASSIONATE,
            conflict_style=ConflictStyle.CONFRONTATIONAL,
        ),
        "bob": Persona(
            name="Bob", stress_level=0.1, morale=0.8,
            posting_frequency=0.1,
            social_media_behavior=SocialMediaBehavior.LURKER,
            stress_response=StressResponse.WITHDRAW,
            emotional_tendency=EmotionalTendency.RESERVED,
        ),
        "carol": Persona(
            name="Carol", stress_level=0.3, morale=0.6,
            posting_frequency=0.5,
            social_media_behavior=SocialMediaBehavior.NETWORKER,
            stress_response=StressResponse.SEEK_ALLIES,
            emotional_tendency=EmotionalTendency.EMPATHETIC,
        ),
    }


@pytest.fixture
def profiles():
    """Minimal profile-like objects for testing."""
    class FakeProfile:
        def __init__(self, name, role_val, org_name):
            self.name = name
            self.role = type("R", (), {"value": role_val})()
            self.org = type("O", (), {"name": org_name})()
            self.team = type("T", (), {"name": "team1"})()
            self.expertise = []
    return {
        "alice": FakeProfile("Alice", "engineer", "TechCorp"),
        "bob": FakeProfile("Bob", "analyst", "TechCorp"),
        "carol": FakeProfile("Carol", "diplomat", "PeaceCorp"),
    }


@pytest.fixture
def engine(memory):
    return BehaviorEngine(memory)


class TestBehaviorDecisions:
    def test_all_agents_get_decisions(self, engine, agents, profiles, memory):
        decisions = engine.decide_actions(1, agents, profiles)
        assert len(decisions) == 3
        assert all(isinstance(d, BehaviorDecision) for d in decisions)

    def test_lurker_more_likely_silent(self, engine, agents, profiles, memory):
        """Lurkers (low posting_frequency) should be silent more often."""
        silent_count = 0
        for _ in range(100):
            decisions = engine.decide_actions(1, agents, profiles)
            bob_d = next(d for d in decisions if d.agent_id == "bob")
            if bob_d.activity == ActivityType.SILENT:
                silent_count += 1
        # Bob (lurker, 0.1 freq) should be silent majority of the time
        assert silent_count > 50

    def test_power_poster_more_active(self, engine, agents, profiles, memory):
        """Power posters should be active more often than lurkers."""
        alice_active = 0
        bob_active = 0
        for _ in range(100):
            decisions = engine.decide_actions(1, agents, profiles)
            for d in decisions:
                if d.activity != ActivityType.SILENT:
                    if d.agent_id == "alice":
                        alice_active += 1
                    elif d.agent_id == "bob":
                        bob_active += 1
        assert alice_active > bob_active

    def test_decision_has_emotional_driver(self, engine, agents, profiles, memory):
        decisions = engine.decide_actions(1, agents, profiles)
        for d in decisions:
            assert isinstance(d.emotional_driver, str)

    def test_high_urgency_increases_activity(self, engine, agents, profiles, memory):
        """High narrative urgency should make more agents active."""
        low_active = 0
        high_active = 0
        for _ in range(100):
            lo = engine.decide_actions(1, agents, profiles, narrative_urgency=0.0)
            hi = engine.decide_actions(1, agents, profiles, narrative_urgency=1.0)
            low_active += sum(1 for d in lo if d.activity != ActivityType.SILENT)
            high_active += sum(1 for d in hi if d.activity != ActivityType.SILENT)
        assert high_active > low_active


class TestEmotionalContagion:
    def test_stress_spreads_through_trust(self, engine, agents, profiles, memory):
        """When a trusted ally is stressed, the agent should get more stressed."""
        # Create a trust relationship: Alice trusts Carol
        memory.record_interaction(
            0, "alice", "carol", "Carol", "ally",
            "Working together on project",
            trust_delta=0.3, warmth_delta=0.3,
        )

        # Carol is very stressed
        agents["carol"].stress_level = 0.9
        alice_initial_stress = agents["alice"].stress_level

        # Run behavior engine (which propagates emotions)
        engine.decide_actions(1, agents, profiles)

        # Alice should be more stressed now (emotional contagion)
        assert agents["alice"].stress_level >= alice_initial_stress

    def test_empathetic_agents_more_susceptible(self, engine, agents, profiles, memory):
        """Empathetic agents should absorb more stress from others."""
        # Carol (empathetic) and Bob (reserved) both trust Alice
        for agent_id in ["bob", "carol"]:
            memory.record_interaction(
                0, agent_id, "alice", "Alice", "ally",
                "Working together", trust_delta=0.3, warmth_delta=0.3,
            )

        # Alice is very stressed
        agents["alice"].stress_level = 0.9
        carol_start = agents["carol"].stress_level
        bob_start = agents["bob"].stress_level

        engine.decide_actions(1, agents, profiles)

        carol_delta = agents["carol"].stress_level - carol_start
        bob_delta = agents["bob"].stress_level - bob_start

        # Carol (empathetic) should absorb more than Bob (reserved)
        assert carol_delta >= bob_delta


class TestStressResponse:
    def test_withdraw_reduces_activity(self, engine, agents, profiles, memory):
        """Agents with WITHDRAW stress response should go quiet under stress."""
        agents["bob"].stress_level = 0.8  # Bob withdraws under stress
        silent_count = 0
        for _ in range(100):
            decisions = engine.decide_actions(1, agents, profiles)
            bob_d = next(d for d in decisions if d.agent_id == "bob")
            if bob_d.activity == ActivityType.SILENT:
                silent_count += 1
        assert silent_count > 70  # should be very quiet

    def test_lash_out_increases_activity(self, engine, agents, profiles, memory):
        """Agents who lash out should post MORE under stress."""
        # Compare Alice's activity at low vs high stress
        agents["alice"].stress_level = 0.1
        low_active = 0
        for _ in range(100):
            decisions = engine.decide_actions(1, agents, profiles)
            alice_d = next(d for d in decisions if d.agent_id == "alice")
            if alice_d.activity != ActivityType.SILENT:
                low_active += 1

        agents["alice"].stress_level = 0.9
        high_active = 0
        for _ in range(100):
            decisions = engine.decide_actions(1, agents, profiles)
            alice_d = next(d for d in decisions if d.agent_id == "alice")
            if alice_d.activity != ActivityType.SILENT:
                high_active += 1

        assert high_active >= low_active
