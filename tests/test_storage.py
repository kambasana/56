"""Tests for SurrealDB storage and igraph analytics."""

import pytest
import pytest_asyncio

from nexus_social.storage.surrealdb import SurrealStorage
from nexus_social.storage.graph import GraphAnalytics


@pytest_asyncio.fixture
async def storage():
    """Create an in-memory SurrealDB instance for testing."""
    s = SurrealStorage(url="mem://", database="test_sim")
    await s.connect()
    yield s
    await s.close()


@pytest_asyncio.fixture
async def populated_storage(storage):
    """Storage with some test data."""
    # Create agents
    await storage.create_agent("alice", {
        "name": "Alice", "role": "engineer", "org": "TechCorp",
        "team": "Alpha", "location": "London", "country": "UK",
        "industry": "tech", "stress": 0.3, "morale": 0.7,
    })
    await storage.create_agent("bob", {
        "name": "Bob", "role": "analyst", "org": "TechCorp",
        "team": "Beta", "location": "London", "country": "UK",
        "industry": "tech", "stress": 0.5, "morale": 0.5,
    })
    await storage.create_agent("carol", {
        "name": "Carol", "role": "diplomat", "org": "PeaceCorp",
        "team": "Gamma", "location": "Geneva", "country": "CH",
        "industry": "ngo", "stress": 0.2, "morale": 0.8,
    })

    # Create posts
    await storage.create_post("p1", "alice", "Great progress on the project!")
    await storage.create_post("p2", "bob", "Threat assessment update: situation deteriorating")
    await storage.create_post("p3", "carol", "Diplomatic channels still open")

    # Create comments
    await storage.create_comment("c1", "bob", "p1", "Agreed, solid work")
    await storage.create_comment("c2", "carol", "p2", "This is concerning")

    # Follow relationships
    await storage.follow("alice", "bob")
    await storage.follow("bob", "alice")
    await storage.follow("carol", "alice")

    # Trust relationships
    await storage.update_relationship("alice", "bob", {
        "trust": 0.8, "respect": 0.7, "warmth": 0.6, "tension": 0.1,
        "interaction_count": 5, "last_interaction_tick": 3,
    })
    await storage.update_relationship("alice", "carol", {
        "trust": 0.5, "respect": 0.6, "warmth": 0.4, "tension": 0.2,
        "interaction_count": 2, "last_interaction_tick": 2,
    })

    return storage


@pytest.mark.asyncio
class TestSurrealStorage:
    async def test_create_and_get_agent(self, storage):
        await storage.create_agent("test1", {
            "name": "Test Agent", "role": "engineer", "org": "TestOrg",
            "team": "TeamA", "location": "NYC", "country": "US",
            "industry": "tech",
        })
        agent = await storage.get_agent("test1")
        assert agent is not None
        assert agent["name"] == "Test Agent"

    async def test_update_agent(self, storage):
        await storage.create_agent("test2", {"name": "Old Name", "role": "analyst",
                                              "org": "X", "team": "Y",
                                              "location": "Z", "country": "Z",
                                              "industry": "Z"})
        await storage.update_agent("test2", {"stress": 0.9})
        agent = await storage.get_agent("test2")
        assert agent["stress"] == 0.9

    async def test_create_post_and_feed(self, populated_storage):
        feed = await populated_storage.get_feed(limit=10)
        assert len(feed) >= 3

    async def test_follow_relationship(self, populated_storage):
        graph = await populated_storage.get_network_graph()
        follow_edges = [e for e in graph["edges"] if e.get("type") == "follows"]
        assert len(follow_edges) >= 3

    async def test_trust_relationship(self, populated_storage):
        rel = await populated_storage.get_relationship("alice", "bob")
        assert rel is not None
        assert rel["trust"] == 0.8

    async def test_get_analytics(self, populated_storage):
        analytics = await populated_storage.get_analytics()
        assert analytics["total_posts"] >= 3
        assert analytics["total_comments"] >= 2

    async def test_like_post(self, populated_storage):
        await populated_storage.like_post("carol", "p1")
        # Verify via trace
        trace = await populated_storage.get_trace("carol")
        actions = [t["action"] for t in trace]
        assert "like_post" in actions

    async def test_store_and_get_memory(self, populated_storage):
        await populated_storage.store_memory(
            "m1", "alice", tick=1, event_type="saw_post",
            summary="Saw Bob's threat assessment",
            about_agent_id="bob", emotional_impact=-0.3, salience=0.7,
        )
        memories = await populated_storage.get_agent_memories("alice")
        assert len(memories) >= 1
        assert memories[0]["summary"] == "Saw Bob's threat assessment"


@pytest.mark.asyncio
class TestGraphAnalytics:
    async def test_build_graph(self, populated_storage):
        graph = GraphAnalytics(populated_storage)
        g = await graph.build_graph()
        assert g.vcount() == 3
        assert g.ecount() >= 2  # at least trust + follow edges

    async def test_pagerank(self, populated_storage):
        graph = GraphAnalytics(populated_storage)
        rankings = await graph.pagerank()
        assert len(rankings) == 3
        assert all("pagerank" in r for r in rankings)
        # Alice should have highest rank (most incoming edges)
        assert rankings[0]["name"] == "Alice"

    async def test_community_detection(self, populated_storage):
        graph = GraphAnalytics(populated_storage)
        communities = await graph.community_summary()
        assert len(communities) >= 1
        assert all("size" in c for c in communities)

    async def test_betweenness_centrality(self, populated_storage):
        graph = GraphAnalytics(populated_storage)
        results = await graph.betweenness_centrality()
        assert len(results) == 3
        assert all("betweenness" in r for r in results)

    async def test_generate_topology(self):
        edges = GraphAnalytics.generate_realistic_topology(
            20, topology="barabasi_albert"
        )
        assert len(edges) > 0
        # All edges should be valid indices
        for s, t in edges:
            assert 0 <= s < 20
            assert 0 <= t < 20

    async def test_influence_spread(self, populated_storage):
        graph = GraphAnalytics(populated_storage)
        timeline = await graph.simulate_influence_spread("alice", threshold=0.3)
        assert len(timeline) >= 1
        assert timeline[0]["step"] == 0
        assert timeline[0]["newly_influenced"][0]["name"] == "Alice"

    async def test_stress_clusters(self, populated_storage):
        # Make bob and alice high stress
        await populated_storage.update_agent("alice", {"stress": 0.8})
        await populated_storage.update_agent("bob", {"stress": 0.8})
        graph = GraphAnalytics(populated_storage)
        clusters = await graph.stress_clusters()
        # May or may not find clusters depending on connectivity
        assert isinstance(clusters, list)
