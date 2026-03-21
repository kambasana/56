"""Tests for counterfactual injection system."""

import pytest

from nexus_social.core.counterfactual import (
    CounterfactualEngine,
    Injection,
    InjectionType,
)
from nexus_social.core.memory import MemorySystem
from nexus_social.core.personas import Persona


@pytest.fixture
def engine():
    return CounterfactualEngine()


@pytest.fixture
def memory():
    mem = MemorySystem()
    mem.register_agent("alice", "Alice", trust_baseline=0.5)
    mem.register_agent("bob", "Bob", trust_baseline=0.5)
    # Set up a relationship
    mem.record_interaction(
        0, "alice", "bob", "Bob", "ally",
        "Working together", trust_delta=0.3,
    )
    return mem


@pytest.fixture
def agents():
    return {
        "alice": Persona(name="Alice", stress_level=0.3, morale=0.7),
        "bob": Persona(name="Bob", stress_level=0.2, morale=0.8),
    }


class TestInjectionBuilders:
    def test_news_break(self):
        inj = CounterfactualEngine.news_break(
            5, "Cyber attack detected", target_orgs=["TechCorp"]
        )
        assert inj.injection_type == InjectionType.NEWS_BREAK
        assert inj.tick == 5
        assert "BREAKING" in inj.narrative_event

    def test_agent_defection(self):
        inj = CounterfactualEngine.agent_defection(
            3, "alice", "Alice", "TechCorp", "RivalCorp",
            allies=["bob"],
        )
        assert inj.injection_type == InjectionType.AGENT_DEFECTION
        assert len(inj.trust_impact) == 1
        assert inj.trust_impact[0]["delta"] == -0.4

    def test_crisis_event(self):
        inj = CounterfactualEngine.crisis_event(
            10, "Major earthquake", ["PeaceCorp"], severity=0.8
        )
        assert inj.injection_type == InjectionType.CRISIS_EVENT
        assert "CRISIS" in inj.narrative_event

    def test_leak(self):
        inj = CounterfactualEngine.leak(
            7, "Classified memo leaked",
            leaked_content="Top secret content here",
            source_agent="alice",
        )
        assert inj.injection_type == InjectionType.LEAK
        assert inj.document_content == "Top secret content here"


class TestInjectionQueue:
    def test_queue_and_retrieve(self, engine):
        inj1 = CounterfactualEngine.news_break(5, "Event 1")
        inj2 = CounterfactualEngine.news_break(3, "Event 2")
        engine.queue_injection(inj1)
        engine.queue_injection(inj2)

        # Should be sorted by tick
        due = engine.get_due_injections(3)
        assert len(due) == 1
        assert due[0].description == "Event 2"

        due = engine.get_due_injections(5)
        assert len(due) == 1
        assert due[0].description == "Event 1"

    def test_no_injections_due(self, engine):
        inj = CounterfactualEngine.news_break(10, "Future event")
        engine.queue_injection(inj)
        assert len(engine.get_due_injections(5)) == 0


class TestInjectionApplication:
    def test_apply_stress_impact(self, engine, agents, memory):
        inj = Injection(
            injection_type=InjectionType.CRISIS_EVENT,
            description="Crisis",
            tick=1,
            stress_impact={"alice": 0.3, "bob": 0.2},
        )
        result = engine.apply_injection(inj, agents, memory, None)
        assert agents["alice"].stress_level == pytest.approx(0.6, abs=0.01)
        assert agents["bob"].stress_level == pytest.approx(0.4, abs=0.01)
        assert len(result["stress_changes"]) == 2

    def test_apply_morale_impact(self, engine, agents, memory):
        inj = Injection(
            injection_type=InjectionType.NEWS_BREAK,
            description="Bad news",
            tick=1,
            morale_impact={"alice": -0.3},
        )
        result = engine.apply_injection(inj, agents, memory, None)
        assert agents["alice"].morale == pytest.approx(0.4, abs=0.01)

    def test_apply_trust_impact(self, engine, agents, memory):
        old_trust = memory.get("alice").relationships["bob"].trust
        inj = Injection(
            injection_type=InjectionType.AGENT_DEFECTION,
            description="Bob defected",
            tick=1,
            trust_impact=[{"from": "alice", "to": "bob", "delta": -0.5}],
        )
        result = engine.apply_injection(inj, agents, memory, None)
        new_trust = memory.get("alice").relationships["bob"].trust
        assert new_trust < old_trust
        assert len(result["trust_changes"]) == 1

    def test_apply_narrative_event(self, engine, agents, memory):
        inj = Injection(
            injection_type=InjectionType.CRISIS_EVENT,
            description="Earthquake",
            tick=1,
            narrative_event="CRISIS: Major earthquake in region",
        )
        result = engine.apply_injection(inj, agents, memory, None)
        assert result["narrative_posted"]
        # Both agents should have the memory
        alice_mem = memory.get("alice")
        assert any("earthquake" in m.summary.lower() for m in alice_mem.memories)

    def test_history_tracking(self, engine, agents, memory):
        inj = CounterfactualEngine.news_break(1, "Test event")
        engine.apply_injection(inj, agents, memory, None)
        history = engine.get_history()
        assert len(history) == 1
        assert history[0]["type"] == "news_break"
