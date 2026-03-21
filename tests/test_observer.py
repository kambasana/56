"""Tests for the observer agent — emergent pattern detection."""

import pytest

from nexus_social.core.observer import EmergentPattern, ObserverAgent


@pytest.fixture
def observer():
    return ObserverAgent(window_size=5)


def _make_tick_data(agents=None, org_post_counts=None, cross_org=None,
                    org_matrix=None, agent_post_counts=None, org_sentiment=None,
                    bridge_agents=None):
    return {
        "agents": agents or {},
        "org_post_counts": org_post_counts or {},
        "cross_org_interactions": cross_org or [],
        "org_interaction_matrix": org_matrix or {},
        "agent_post_counts": agent_post_counts or {},
        "org_sentiment": org_sentiment or {},
        "bridge_agents": bridge_agents or [],
    }


class TestStressCascade:
    def test_detects_stress_spike(self, observer):
        """Should detect when multiple agents in same org get stressed simultaneously."""
        agents = {
            "a1": {"name": "Agent1", "org": "TechCorp", "stress": 0.3},
            "a2": {"name": "Agent2", "org": "TechCorp", "stress": 0.3},
            "a3": {"name": "Agent3", "org": "TechCorp", "stress": 0.3},
        }
        # Tick 1: normal stress
        observer.observe(1, _make_tick_data(agents=agents))

        # Tick 2: stress spike
        agents["a1"]["stress"] = 0.7
        agents["a2"]["stress"] = 0.7
        agents["a3"]["stress"] = 0.8
        patterns = observer.observe(2, _make_tick_data(agents=agents))

        stress_patterns = [p for p in patterns if p.pattern_type == "stress_cascade"]
        assert len(stress_patterns) >= 1
        assert "TechCorp" in stress_patterns[0].orgs_involved

    def test_no_false_positive_on_single_stress(self, observer):
        """One agent getting stressed shouldn't trigger cascade."""
        agents = {
            "a1": {"name": "Agent1", "org": "TechCorp", "stress": 0.3},
            "a2": {"name": "Agent2", "org": "TechCorp", "stress": 0.3},
        }
        observer.observe(1, _make_tick_data(agents=agents))

        agents["a1"]["stress"] = 0.8  # only one spikes
        patterns = observer.observe(2, _make_tick_data(agents=agents))

        stress_patterns = [p for p in patterns if p.pattern_type == "stress_cascade"]
        assert len(stress_patterns) == 0


class TestEchoChamber:
    def test_detects_echo_chamber(self, observer):
        """Should detect when an org only talks to itself."""
        org_matrix = {"TechCorp": {"TechCorp": 10, "PeaceCorp": 1}}
        patterns = observer.observe(1, _make_tick_data(org_matrix=org_matrix))

        echo = [p for p in patterns if p.pattern_type == "echo_chamber"]
        assert len(echo) >= 1

    def test_no_echo_chamber_when_diverse(self, observer):
        """Diverse interaction should not trigger echo chamber."""
        org_matrix = {"TechCorp": {"TechCorp": 3, "PeaceCorp": 3, "MilCorp": 3}}
        patterns = observer.observe(1, _make_tick_data(org_matrix=org_matrix))

        echo = [p for p in patterns if p.pattern_type == "echo_chamber"]
        assert len(echo) == 0


class TestInfluenceConcentration:
    def test_detects_dominant_voice(self, observer):
        """Should detect when one agent produces >30% of all content."""
        agent_posts = {"alice": 8, "bob": 1, "carol": 1}
        patterns = observer.observe(1, _make_tick_data(agent_post_counts=agent_posts))

        influence = [p for p in patterns if p.pattern_type == "influence_concentration"]
        assert len(influence) >= 1
        assert "alice" in influence[0].agents_involved


class TestSuspiciousSilence:
    def test_detects_org_going_quiet(self, observer):
        """Should detect when an active org suddenly goes silent."""
        # Build up activity history
        for tick in range(1, 5):
            observer.observe(tick, _make_tick_data(
                org_post_counts={"TechCorp": 5}
            ))

        # Sudden silence
        patterns = observer.observe(5, _make_tick_data(
            org_post_counts={"TechCorp": 0}
        ))
        patterns2 = observer.observe(6, _make_tick_data(
            org_post_counts={"TechCorp": 0}
        ))

        silence = [p for p in patterns + patterns2 if p.pattern_type == "suspicious_silence"]
        assert len(silence) >= 1


class TestObserverSummary:
    def test_summary_structure(self, observer):
        observer.observe(1, _make_tick_data(
            agent_post_counts={"alice": 10, "bob": 1}
        ))
        summary = observer.get_summary()
        assert "total_patterns" in summary
        assert "by_type" in summary
        assert "high_severity" in summary

    def test_pattern_to_dict(self):
        p = EmergentPattern(
            pattern_type="test", description="test pattern",
            severity=0.8, tick=1,
            agents_involved=["a1"], orgs_involved=["TechCorp"],
        )
        d = p.to_dict()
        assert d["type"] == "test"
        assert d["severity"] == 0.8
        assert d["tick"] == 1
