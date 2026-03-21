"""Social media analysis layer — queries SurrealDB for insights.

Provides geo-aware, faction-aware, actor-type-aware analytics using
SurrealDB's graph-native queries and igraph for heavy algorithms.
"""

from __future__ import annotations

import logging
from typing import Any

from nexus_social.storage.surrealdb import SurrealStorage
from nexus_social.storage.graph import GraphAnalytics

logger = logging.getLogger(__name__)

# Sentiment keywords for offline sentiment inference
_POSITIVE = {
    "good", "great", "excellent", "strong", "success", "win", "progress",
    "proud", "impressive", "solid", "effective", "trust", "ready", "secure",
    "breakthrough", "achieved", "confirmed", "positive", "advancing",
}
_NEGATIVE = {
    "bad", "fail", "failure", "threat", "danger", "risk", "breach", "attack",
    "casualties", "loss", "critical", "urgent", "broken", "compromised",
    "hostile", "deteriorating", "denied", "blocked", "overrun", "collapse",
}


class SocialAnalyzer:
    """Analyzes simulation data through SurrealDB graph queries + igraph algorithms."""

    def __init__(self, storage: SurrealStorage, graph: GraphAnalytics | None = None):
        self.storage = storage
        self.graph = graph or GraphAnalytics(storage)

    async def get_feed(self, limit: int = 50) -> list[dict]:
        """Get the social feed with author metadata and engagement."""
        feed = await self.storage.get_feed(limit)
        # Add sentiment analysis
        for post in feed:
            content = post.get("content", "")
            post["sentiment"] = self._analyze_sentiment(content)
        return feed

    async def get_analytics(self) -> dict:
        """Platform-wide analytics with geo and faction breakdown."""
        return await self.storage.get_analytics()

    async def get_network_graph(self) -> dict:
        """Build interaction network for visualization."""
        return await self.storage.get_network_graph()

    async def get_agent_details(self) -> list[dict]:
        """Get all agents with their current state and relationships."""
        agents = await self.storage.get_all_agents()
        for agent in agents:
            agent_id = str(agent.get("id", ""))
            if ":" in agent_id:
                agent_id = agent_id.split(":", 1)[1]
            agent["relationships"] = await self.storage.get_agent_relationships(agent_id)
            agent["memories"] = await self.storage.get_agent_memories(agent_id, limit=10)
        return agents

    async def get_geo_breakdown(self) -> dict:
        """Analyze activity patterns by geography."""
        result = await self.storage.db.query("""
            SELECT
                location, country,
                count() AS agent_count,
                math::mean(stress) AS avg_stress,
                math::mean(morale) AS avg_morale,
                array::group(name) AS agents,
                array::distinct(array::group(org)) AS orgs,
                (SELECT count() AS cnt FROM post
                 WHERE author.location = $parent.location
                   AND author.country = $parent.country
                 GROUP ALL)[0].cnt OR 0 AS post_count
            FROM agent
            GROUP BY location, country
        """)
        rows = result[0] if result else []
        geo_data = {}
        for row in rows:
            key = f"{row.get('location', '')}, {row.get('country', '')}"
            geo_data[key] = row
        return geo_data

    async def get_faction_analysis(self) -> list[dict]:
        """Inter-faction dynamics using graph traversal."""
        return await self.storage.get_faction_analysis()

    # ── Graph algorithm analytics (via igraph) ──────────────────────

    async def get_influence_rankings(self) -> list[dict]:
        """Rank agents by influence using PageRank."""
        return await self.graph.pagerank()

    async def get_bridge_agents(self) -> list[dict]:
        """Find bridge agents connecting different communities."""
        return await self.graph.betweenness_centrality()

    async def get_communities(self, method: str = "louvain") -> list[dict]:
        """Detect communities in the social network."""
        return await self.graph.community_summary(method)

    async def get_influence_spread(self, seed_agent_id: str,
                                   threshold: float = 0.3) -> list[dict]:
        """Simulate how influence spreads from a seed agent."""
        return await self.graph.simulate_influence_spread(
            seed_agent_id, threshold=threshold
        )

    async def get_stress_clusters(self) -> list[dict]:
        """Find clusters of high-stress agents."""
        return await self.graph.stress_clusters()

    async def get_narrative_spread(self, keyword: str) -> list[dict]:
        """Track how a narrative keyword spreads through the network."""
        return await self.storage.get_narrative_spread(keyword)

    async def get_cross_org_interactions(self) -> list[dict]:
        """Find all interactions between agents of different orgs."""
        return await self.storage.get_cross_org_interactions()

    def _analyze_sentiment(self, text: str) -> str:
        """Simple keyword-based sentiment analysis."""
        words = set(text.lower().split())
        pos = len(words & _POSITIVE)
        neg = len(words & _NEGATIVE)
        if pos > neg + 1:
            return "very_positive"
        if pos > neg:
            return "positive"
        if neg > pos + 1:
            return "very_negative"
        if neg > pos:
            return "negative"
        return "neutral"
