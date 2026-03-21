"""Tests for the FastAPI visualization server.

Uses httpx AsyncClient with the ASGI transport to test endpoints
without spinning up a real server.
"""

from __future__ import annotations

import sys
import types
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

# Stub external dependencies (camel, oasis) that aren't installed in test env
_CAMEL_MODULES = ["camel", "camel.models", "camel.types", "camel.agents",
                  "camel.messages", "camel.prompts"]
_OASIS_MODULES = ["oasis", "oasis.social_platform", "oasis.social_platform.agent_graph"]

for mod_name in _CAMEL_MODULES + _OASIS_MODULES:
    if mod_name not in sys.modules:
        sys.modules[mod_name] = MagicMock()

from fastapi.testclient import TestClient

from nexus_social.core.memory import MemorySystem
from nexus_social.core.narrative import NarrativeEngine
from nexus_social.core.counterfactual import CounterfactualEngine
from nexus_social.core.observer import ObserverAgent
from nexus_social.documents.intelligence import DocumentIntelligence
from nexus_social.oasis_engine.analysis import SocialAnalyzer
from nexus_social.oasis_engine.runner import SimulationRunner
from nexus_social.storage.surrealdb import SurrealStorage
from nexus_social.visualization.server import create_app


# ── Fixtures ───────────────────────────────────────────────────────


def _mock_runner():
    """Build a SimulationRunner with mocked internals."""
    runner = MagicMock(spec=SimulationRunner)
    runner.tick_log = [
        {"tick": 1, "active_agents": 5, "new_posts": 3, "timestamp": "2026-01-01T00:00:00"},
        {"tick": 2, "active_agents": 8, "new_posts": 6, "timestamp": "2026-01-01T01:00:00"},
    ]
    runner.narrative = MagicMock(spec=NarrativeEngine)
    runner.narrative.to_dict.return_value = {"phase": "rising_action", "tick": 2}
    runner.memory = MagicMock(spec=MemorySystem)
    runner.memory.to_dict.return_value = {"agents": 5, "total_memories": 12}
    runner.counterfactual = MagicMock(spec=CounterfactualEngine)
    runner.counterfactual.get_history.return_value = [
        {"type": "news_break", "description": "Breaking news", "tick": 3, "effects": []}
    ]
    runner.get_observer_summary.return_value = {
        "total_patterns": 3,
        "ticks_observed": 2,
        "by_type": {"stress_cascade": [{"severity": 0.8}]},
    }
    runner.get_all_patterns.return_value = [
        {"type": "stress_cascade", "severity": 0.8, "description": "High stress detected",
         "agents": ["agent_1", "agent_2"], "tick": 1},
        {"type": "echo_chamber", "severity": 0.5, "description": "Org isolation",
         "agents": ["agent_3"], "tick": 2, "org": "OrgA"},
    ]
    runner.get_influence_rankings = AsyncMock(return_value=[
        {"name": "Alice", "org": "OrgA", "pagerank": 0.15},
        {"name": "Bob", "org": "OrgB", "pagerank": 0.10},
    ])
    runner.get_communities = AsyncMock(return_value=[
        {"dominant_org": "OrgA", "size": 5, "agents": ["a1", "a2", "a3", "a4", "a5"],
         "modularity": 0.42},
    ])
    runner.run = AsyncMock(return_value=[{"tick": 1}])
    runner.inject = AsyncMock(return_value={"applied": True, "effects": [{"type": "stress"}]})
    runner.ingest_document = AsyncMock(return_value={
        "mode": "rule_based", "entities": 5, "relations": 3, "topics": ["ai", "security"],
    })
    runner.graphrag = None

    # Bridge mock for export
    runner.bridge = MagicMock()
    runner.bridge._profile_map = {}

    return runner


def _mock_analyzer():
    """Build a SocialAnalyzer with mocked methods."""
    analyzer = MagicMock(spec=SocialAnalyzer)
    analyzer.get_feed = AsyncMock(return_value=[
        {"author": "Alice Smith", "author_org": "OrgA", "author_role": "engineer",
         "author_team": "Alpha", "author_location": "NYC", "content": "Hello world",
         "sentiment": "positive", "reactions": {"thumbsup": ["bob"]},
         "comments": [], "hashtags": ["test"], "mentions": [],
         "comment_count": 0, "shared_document": None},
    ])
    analyzer.get_analytics = AsyncMock(return_value={
        "total_posts": 10, "total_comments": 5, "total_dms": 2,
        "total_documents": 1, "cross_org_interactions": 3, "ticks": 2,
        "org_activity": {"OrgA": 7, "OrgB": 3},
        "location_activity": {"NYC": 6, "London": 4},
        "sentiment_distribution": {"positive": 6, "neutral": 3, "negative": 1},
    })
    analyzer.get_network_graph = AsyncMock(return_value={
        "nodes": [
            {"id": "a1", "name": "Alice", "org": "OrgA", "team": "Alpha",
             "role": "engineer", "location": "NYC"},
        ],
        "edges": [{"source": "a1", "target": "a2", "weight": 3}],
    })
    analyzer.get_agent_details = AsyncMock(return_value=[
        {"name": "Alice", "org": "OrgA", "role": "engineer", "team": "Alpha",
         "location": "NYC", "expertise": ["AI"], "traits": ["analytical"],
         "activity_level": 0.7, "persona": None},
    ])
    analyzer.get_geo_breakdown = AsyncMock(return_value={
        "NYC, US": {"agent_count": 5, "avg_stress": 0.3, "avg_morale": 0.7},
    })
    analyzer.get_faction_analysis = AsyncMock(return_value=[
        {"org": "OrgA", "sentiment": 0.6, "stress": 0.3},
    ])
    analyzer.get_narrative_spread = AsyncMock(return_value=[
        {"agent": "Alice", "tick": 1, "content": "Test narrative"},
    ])
    analyzer.get_cross_org_interactions = AsyncMock(return_value=[
        {"from_org": "OrgA", "to_org": "OrgB", "count": 5},
    ])
    analyzer.get_communities = AsyncMock(return_value=[
        {"dominant_org": "OrgA", "size": 4, "agents": ["a1", "a2", "a3", "a4"],
         "modularity": 0.38},
    ])
    analyzer.get_bridge_agents = AsyncMock(return_value=[
        {"name": "Charlie", "org": "OrgA", "betweenness": 0.45},
    ])
    analyzer.get_stress_clusters = AsyncMock(return_value=[
        {"dominant_org": "OrgB", "size": 3, "agents": ["b1", "b2", "b3"],
         "avg_stress": 0.8, "avg_morale": 0.2},
    ])
    analyzer.get_influence_spread = AsyncMock(return_value=[
        {"agent": "Alice", "reached": True, "round": 1},
    ])
    return analyzer


@pytest.fixture
def client():
    runner = _mock_runner()
    analyzer = _mock_analyzer()
    doc_intel = DocumentIntelligence()
    app = create_app(runner, analyzer, doc_intel, storage=None)
    return TestClient(app)


# ── Tests ──────────────────────────────────────────────────────────


class TestIndexPage:
    def test_index_returns_html(self, client):
        res = client.get("/")
        assert res.status_code == 200
        assert "NexusSocial" in res.text


class TestFeedEndpoints:
    def test_get_feed(self, client):
        res = client.get("/api/feed?limit=10")
        assert res.status_code == 200
        data = res.json()
        assert isinstance(data, list)
        assert data[0]["author"] == "Alice Smith"

    def test_get_analytics(self, client):
        res = client.get("/api/analytics")
        assert res.status_code == 200
        data = res.json()
        assert data["total_posts"] == 10
        assert "org_activity" in data

    def test_get_network(self, client):
        res = client.get("/api/network")
        assert res.status_code == 200
        data = res.json()
        assert "nodes" in data
        assert "edges" in data

    def test_get_events(self, client):
        res = client.get("/api/events?limit=10")
        assert res.status_code == 200
        data = res.json()
        assert len(data) == 2
        # Reversed order (most recent first)
        assert data[0]["tick"] == 2

    def test_get_agents(self, client):
        res = client.get("/api/agents")
        assert res.status_code == 200
        data = res.json()
        assert data[0]["name"] == "Alice"


class TestSimulation:
    def test_simulate_ticks(self, client):
        res = client.post("/api/simulate", json={"ticks": 3})
        assert res.status_code == 200
        data = res.json()
        assert data["ticks_run"] == 3
        assert "analytics" in data

    def test_simulate_capped_at_20(self, client):
        res = client.post("/api/simulate", json={"ticks": 100})
        assert res.status_code == 200
        assert res.json()["ticks_run"] == 20


class TestAnalysis:
    def test_geo_breakdown(self, client):
        res = client.get("/api/analysis/geo")
        assert res.status_code == 200
        assert "NYC, US" in res.json()

    def test_faction_analysis(self, client):
        res = client.get("/api/analysis/factions")
        assert res.status_code == 200

    def test_narrative_state(self, client):
        res = client.get("/api/analysis/narrative")
        assert res.status_code == 200
        assert res.json()["phase"] == "rising_action"

    def test_memory_state(self, client):
        res = client.get("/api/analysis/memory")
        assert res.status_code == 200
        assert res.json()["agents"] == 5

    def test_narrative_spread(self, client):
        res = client.get("/api/analysis/narrative-spread?keyword=test")
        assert res.status_code == 200

    def test_cross_org_interactions(self, client):
        res = client.get("/api/analysis/cross-org")
        assert res.status_code == 200


class TestObserver:
    def test_observer_summary(self, client):
        res = client.get("/api/observer/summary")
        assert res.status_code == 200
        data = res.json()
        assert data["total_patterns"] == 3

    def test_observer_patterns(self, client):
        res = client.get("/api/observer/patterns")
        assert res.status_code == 200
        data = res.json()
        assert len(data) == 2
        assert data[0]["type"] == "stress_cascade"


class TestGraphAnalytics:
    def test_influence_rankings(self, client):
        res = client.get("/api/graph/influence")
        assert res.status_code == 200
        data = res.json()
        assert data[0]["name"] == "Alice"
        assert data[0]["pagerank"] == 0.15

    def test_communities(self, client):
        res = client.get("/api/graph/communities?method=louvain")
        assert res.status_code == 200
        data = res.json()
        assert data[0]["size"] == 4

    def test_bridge_agents(self, client):
        res = client.get("/api/graph/bridges")
        assert res.status_code == 200
        data = res.json()
        assert data[0]["name"] == "Charlie"

    def test_stress_clusters(self, client):
        res = client.get("/api/graph/stress-clusters")
        assert res.status_code == 200
        data = res.json()
        assert data[0]["avg_stress"] == 0.8


class TestInjection:
    def test_inject_event(self, client):
        res = client.post("/api/inject", json={
            "type": "news_break",
            "description": "Breaking: Major breach detected",
        })
        assert res.status_code == 200
        data = res.json()
        assert data["applied"] is True

    def test_injection_history(self, client):
        res = client.get("/api/inject/history")
        assert res.status_code == 200
        data = res.json()
        assert len(data) == 1
        assert data[0]["type"] == "news_break"


class TestDocuments:
    def test_ingest_document(self, client):
        res = client.post("/api/documents/ingest", json={
            "text": "Alice from OrgA met Bob from OrgB.",
            "doc_id": "test_doc",
        })
        assert res.status_code == 200
        data = res.json()
        assert data["entities"] == 5

    def test_document_topics(self, client):
        res = client.get("/api/documents/topics")
        assert res.status_code == 200

    def test_document_timeline(self, client):
        res = client.get("/api/documents/timeline")
        assert res.status_code == 200


class TestScenarios:
    def test_list_scenarios(self, client):
        res = client.get("/api/scenarios")
        assert res.status_code == 200
        data = res.json()
        assert isinstance(data, list)
        assert len(data) > 0
        # All pre-made scenarios should have names
        assert all("name" in s for s in data)

    def test_get_scenario_by_name(self, client):
        # First get list
        scenarios = client.get("/api/scenarios").json()
        name = scenarios[0]["name"]
        res = client.get(f"/api/scenarios/{name}")
        assert res.status_code == 200

    def test_get_nonexistent_scenario(self, client):
        res = client.get("/api/scenarios/nonexistent_scenario_xyz")
        assert res.status_code == 404

    def test_persona_templates(self, client):
        res = client.get("/api/persona-templates")
        assert res.status_code == 200
        data = res.json()
        assert isinstance(data, list)
        assert len(data) > 0

    def test_export_scenario(self, client):
        res = client.get("/api/scenario/export")
        assert res.status_code == 200
        data = res.json()
        assert "name" in data
        assert "organizations" in data
