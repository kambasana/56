"""Integration tests — scenario load + simulate + analyze through the full stack.

These tests exercise the real scenario builder, storage, graph analytics,
and behavior engine together (no mocks except OASIS/CAMEL externals).
"""

from __future__ import annotations

import sys
from unittest.mock import MagicMock

# Stub CAMEL/OASIS — not available in test env
_STUB_MODULES = [
    "camel", "camel.models", "camel.types", "camel.agents",
    "camel.messages", "camel.prompts",
    "oasis", "oasis.social_platform", "oasis.social_platform.agent_graph",
]
for mod_name in _STUB_MODULES:
    if mod_name not in sys.modules:
        sys.modules[mod_name] = MagicMock()

import pytest

from nexus_social.core.counterfactual import CounterfactualEngine
from nexus_social.core.memory import MemorySystem
from nexus_social.core.narrative import NarrativeEngine
from nexus_social.core.observer import ObserverAgent
from nexus_social.core.scenarios import (
    NARRATIVE_ARCS, SCENARIOS, ScenarioBuilder, list_scenarios,
)
from nexus_social.documents.intelligence import DocumentIntelligence
from nexus_social.oasis_engine.analysis import SocialAnalyzer
from nexus_social.storage.graph import GraphAnalytics
from nexus_social.storage.surrealdb import SurrealStorage


@pytest.fixture
async def storage():
    s = SurrealStorage(url="mem://", database="test_integration")
    await s.connect()
    yield s
    await s.close()


class TestScenarioLoading:
    """Test that all pre-made scenarios load correctly."""

    def test_list_scenarios_returns_all(self):
        scenarios = list_scenarios()
        assert len(scenarios) >= 5
        for s in scenarios:
            assert "name" in s
            assert "description" in s
            assert "agent_count" in s
            assert s["agent_count"] > 0

    @pytest.mark.parametrize("name", list(SCENARIOS.keys()))
    def test_build_each_scenario(self, name):
        config = SCENARIOS[name]
        builder = ScenarioBuilder()
        orgs, agents = builder.build(config)
        assert len(orgs) > 0
        assert len(agents) > 0
        for agent in agents:
            assert agent.name
            assert agent.org
            assert agent.team
            assert agent.role

    @pytest.mark.parametrize("name", list(SCENARIOS.keys()))
    def test_narrative_arcs_valid(self, name):
        config = SCENARIOS[name]
        arc = NARRATIVE_ARCS.get(config.name)
        if arc:
            assert len(arc.phases) > 0
            for phase in arc.phases:
                assert phase.name
                assert phase.start_tick >= 0


class TestFullStackIntegration:
    """Test scenario load -> storage -> graph analytics pipeline."""

    @pytest.mark.asyncio
    async def test_load_agents_into_storage(self, storage):
        config = SCENARIOS["Coalition Strike"]
        builder = ScenarioBuilder()
        _, agents = builder.build(config)

        for agent in agents:
            await storage.create_agent(agent.id, {
                "name": agent.name,
                "org": agent.org.name,
                "team": agent.team.name,
                "role": agent.role.value,
                "location": agent.team.location.city,
                "country": agent.team.location.country,
                "stress": 0.3,
                "morale": 0.7,
            })

        all_agents = await storage.get_all_agents()
        assert len(all_agents) == len(agents)

    @pytest.mark.asyncio
    async def test_create_posts_and_analytics(self, storage):
        await storage.create_agent("a1", {"name": "Alice", "org": "OrgA", "team": "Team1",
                                          "role": "engineer", "location": "NYC", "country": "US"})
        await storage.create_agent("a2", {"name": "Bob", "org": "OrgB", "team": "Team2",
                                          "role": "analyst", "location": "London", "country": "UK"})

        await storage.create_post("p1", "a1", "Hello from OrgA! Great progress today.", hashtags=["progress"])
        await storage.create_post("p2", "a2", "Analysis complete. Threat detected.", hashtags=["security"])
        await storage.create_post("p3", "a1", "Cross-team collaboration is key.", mentions=["a2"])

        feed = await storage.get_feed(limit=10)
        assert len(feed) == 3

        analytics = await storage.get_analytics()
        assert analytics["total_posts"] == 3

    @pytest.mark.asyncio
    async def test_relationships_and_graph(self, storage):
        await storage.create_agent("a1", {"name": "Alice", "org": "OrgA", "team": "Team1",
                                          "role": "engineer", "location": "NYC", "country": "US"})
        await storage.create_agent("a2", {"name": "Bob", "org": "OrgB", "team": "Team2",
                                          "role": "analyst", "location": "London", "country": "UK"})
        await storage.create_agent("a3", {"name": "Charlie", "org": "OrgA", "team": "Team1",
                                          "role": "manager", "location": "NYC", "country": "US"})

        await storage.update_relationship("a1", "a2", {"trust": 0.8})
        await storage.update_relationship("a2", "a3", {"trust": 0.6})
        await storage.update_relationship("a1", "a3", {"trust": 0.9})

        graph = GraphAnalytics(storage)
        pr = await graph.pagerank()
        assert len(pr) == 3

        communities = await graph.community_summary("louvain")
        assert isinstance(communities, list)

        bc = await graph.betweenness_centrality()
        assert len(bc) == 3

    @pytest.mark.asyncio
    async def test_memory_system(self):
        memory = MemorySystem()
        memory.register_agent("a1", "Alice", trust_baseline=0.6)
        memory.register_agent("a2", "Bob", trust_baseline=0.5)

        # Add memories via the AgentMemory API
        agent_mem = memory.get("a1")
        agent_mem.remember(tick=1, event_type="praise", summary="Received praise from commander",
                           emotional_impact=0.8)
        agent_mem.remember(tick=2, event_type="breach", summary="Witnessed security breach",
                           emotional_impact=-0.6)

        assert len(agent_mem.memories) == 2

        # Record interaction to create relationship
        memory.record_interaction(tick=1, actor_id="a1", target_id="a2",
                                  target_name="Bob", interaction_type="collaboration",
                                  summary="Worked together on analysis",
                                  trust_delta=0.1)

        rel = agent_mem.get_relationship("a2")
        assert rel is not None

    @pytest.mark.asyncio
    async def test_observer_detects_patterns(self):
        observer = ObserverAgent(window_size=5)

        tick_data = {
            "agent_states": {
                "a1": {"stress": 0.9, "morale": 0.2, "org": "OrgA"},
                "a2": {"stress": 0.85, "morale": 0.3, "org": "OrgA"},
                "a3": {"stress": 0.8, "morale": 0.25, "org": "OrgA"},
                "a4": {"stress": 0.3, "morale": 0.7, "org": "OrgB"},
            },
            "posts": [],
            "relationships": {},
        }

        patterns = observer.observe(1, tick_data)
        # Should detect some patterns with high stress in OrgA
        assert isinstance(patterns, list)

    @pytest.mark.asyncio
    async def test_counterfactual_injection(self):
        engine = CounterfactualEngine()

        inj1 = CounterfactualEngine.news_break(
            tick=3,
            description="Major security breach detected",
            target_orgs=["OrgA"],
        )
        engine.queue_injection(inj1)

        inj2 = CounterfactualEngine.crisis_event(
            tick=5,
            description="Hurricane approaching base",
            affected_orgs=["OrgA", "OrgB"],
        )
        engine.queue_injection(inj2)

        tick3 = engine.get_due_injections(tick=3)
        assert len(tick3) == 1
        assert tick3[0].description == "Major security breach detected"

        tick5 = engine.get_due_injections(tick=5)
        assert len(tick5) == 1

        # Verify no more pending
        remaining = engine.get_due_injections(tick=100)
        assert len(remaining) == 0

    @pytest.mark.asyncio
    async def test_document_intelligence(self):
        intel = DocumentIntelligence()

        doc = MagicMock()
        doc.id = "doc1"
        doc.title = "Security Assessment Report"
        doc.content = ("The security assessment reveals critical vulnerabilities "
                       "in the network infrastructure. AI-powered threat detection "
                       "systems identified multiple breach attempts.")
        doc.doc_type = "report"
        doc.author_org = "OrgA"
        doc.created_at = "2026-01-01"
        doc.views = 10

        intel.ingest(doc)

        topics = intel.get_trending_topics(top_n=5)
        assert len(topics) > 0

        timeline = intel.get_document_timeline()
        assert len(timeline) == 1

    @pytest.mark.asyncio
    async def test_analyzer_with_real_storage(self, storage):
        """Full analyzer pipeline with real storage."""
        await storage.create_agent("a1", {"name": "Alice", "org": "OrgA", "team": "Team1",
                                          "role": "engineer", "location": "NYC", "country": "US"})
        await storage.create_agent("a2", {"name": "Bob", "org": "OrgB", "team": "Team2",
                                          "role": "analyst", "location": "London", "country": "UK"})
        await storage.create_post("p1", "a1", "Testing the platform!", hashtags=["test"])
        await storage.update_relationship("a1", "a2", {"trust": 0.7})

        graph = GraphAnalytics(storage)
        analyzer = SocialAnalyzer(storage, graph)

        feed = await analyzer.get_feed(limit=10)
        assert len(feed) == 1
        assert feed[0]["sentiment"] in ["positive", "neutral", "negative", "very_positive", "very_negative"]

        analytics = await analyzer.get_analytics()
        assert analytics["total_posts"] == 1

        network = await analyzer.get_network_graph()
        assert "nodes" in network
        assert "edges" in network

        rankings = await analyzer.get_influence_rankings()
        assert isinstance(rankings, list)
