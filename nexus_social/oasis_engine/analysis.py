"""Social media analysis layer - queries the OASIS database for insights.

Provides geo-aware, faction-aware, actor-type-aware analytics on top of
the raw OASIS social platform data.
"""

from __future__ import annotations

import logging
import sqlite3
from collections import Counter
from typing import Any

from nexus_social.core.memory import MemorySystem
from nexus_social.oasis_engine.bridge import OASISBridge

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
    """Analyzes OASIS simulation data through our scenario lens."""

    def __init__(self, bridge: OASISBridge, memory: MemorySystem):
        self.bridge = bridge
        self.memory = memory

    def _conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.bridge.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def get_feed(self, limit: int = 50) -> list[dict]:
        """Get the social feed with our metadata (org, role, geo) attached."""
        try:
            conn = self._conn()
            posts = conn.execute(
                "SELECT * FROM post ORDER BY created_at DESC LIMIT ?",
                (limit,)
            ).fetchall()

            feed = []
            for post in posts:
                post_dict = dict(post)
                # Enrich with our metadata
                oasis_id = post_dict.get("user_id")
                if oasis_id is not None:
                    our_id = self.bridge.get_our_agent_id(int(oasis_id))
                    profile = self.bridge.get_profile(our_id) if our_id else None
                    persona = self.bridge.get_persona(our_id) if our_id else None
                    if profile:
                        post_dict["author_name"] = profile.name
                        post_dict["author_role"] = profile.role.value
                        post_dict["author_org"] = profile.org.name
                        post_dict["author_team"] = profile.team.name
                        post_dict["author_location"] = profile.location.city
                        post_dict["author_country"] = profile.location.country
                        post_dict["author_industry"] = profile.org.industry
                    if persona:
                        post_dict["author_persona"] = persona.name
                        post_dict["stress_level"] = persona.stress_level
                        post_dict["morale"] = persona.morale

                # Inline sentiment
                content = post_dict.get("content", "")
                post_dict["sentiment"] = self._analyze_sentiment(content)

                # Get comments for this post
                comments = conn.execute(
                    "SELECT * FROM comment WHERE post_id = ? ORDER BY created_at",
                    (post_dict.get("post_id", post_dict.get("id")),)
                ).fetchall()
                post_dict["comments"] = []
                for c in comments:
                    c_dict = dict(c)
                    c_oasis_id = c_dict.get("user_id")
                    if c_oasis_id is not None:
                        c_our_id = self.bridge.get_our_agent_id(int(c_oasis_id))
                        c_profile = self.bridge.get_profile(c_our_id) if c_our_id else None
                        if c_profile:
                            c_dict["author_name"] = c_profile.name
                            c_dict["author_org"] = c_profile.org.name
                            c_dict["author_role"] = c_profile.role.value
                    post_dict["comments"].append(c_dict)

                # Get like count
                try:
                    likes = conn.execute(
                        "SELECT COUNT(*) as cnt FROM like_post WHERE post_id = ?",
                        (post_dict.get("post_id", post_dict.get("id")),)
                    ).fetchone()
                    post_dict["likes"] = likes["cnt"] if likes else 0
                except Exception:
                    post_dict["likes"] = 0

                feed.append(post_dict)

            conn.close()
            return feed
        except Exception as e:
            logger.error(f"Error getting feed: {e}")
            return []

    def get_analytics(self) -> dict:
        """Platform-wide analytics with geo and faction breakdown."""
        try:
            conn = self._conn()

            # Count posts
            post_count = conn.execute("SELECT COUNT(*) as cnt FROM post").fetchone()
            comment_count = conn.execute("SELECT COUNT(*) as cnt FROM comment").fetchone()

            # Build org/geo/role breakdowns
            org_activity: dict[str, int] = Counter()
            geo_activity: dict[str, int] = Counter()
            role_activity: dict[str, int] = Counter()
            industry_activity: dict[str, int] = Counter()
            cross_org_comments = 0

            posts = conn.execute("SELECT user_id, content FROM post").fetchall()
            for post in posts:
                oasis_id = post["user_id"]
                our_id = self.bridge.get_our_agent_id(int(oasis_id)) if oasis_id else None
                profile = self.bridge.get_profile(our_id) if our_id else None
                if profile:
                    org_activity[profile.org.name] += 1
                    geo_activity[f"{profile.location.city}, {profile.location.country}"] += 1
                    role_activity[profile.role.value] += 1
                    industry_activity[profile.org.industry] += 1

            # Sentiment distribution
            sentiment_dist: dict[str, int] = Counter()
            for post in posts:
                s = self._analyze_sentiment(post["content"] or "")
                sentiment_dist[s] += 1

            # Cross-org interactions
            comments = conn.execute(
                "SELECT c.user_id as commenter, p.user_id as poster "
                "FROM comment c JOIN post p ON c.post_id = p.post_id"
            ).fetchall()
            for c in comments:
                c_id = self.bridge.get_our_agent_id(int(c["commenter"])) if c["commenter"] else None
                p_id = self.bridge.get_our_agent_id(int(c["poster"])) if c["poster"] else None
                c_profile = self.bridge.get_profile(c_id) if c_id else None
                p_profile = self.bridge.get_profile(p_id) if p_id else None
                if c_profile and p_profile and c_profile.org.id != p_profile.org.id:
                    cross_org_comments += 1

            conn.close()

            return {
                "total_posts": post_count["cnt"] if post_count else 0,
                "total_comments": comment_count["cnt"] if comment_count else 0,
                "cross_org_interactions": cross_org_comments,
                "org_activity": dict(org_activity),
                "geo_activity": dict(geo_activity),
                "role_activity": dict(role_activity),
                "industry_activity": dict(industry_activity),
                "sentiment_distribution": dict(sentiment_dist),
            }
        except Exception as e:
            logger.error(f"Error getting analytics: {e}")
            return {"total_posts": 0, "total_comments": 0}

    def get_network_graph(self) -> dict:
        """Build interaction network from OASIS data + our metadata."""
        nodes = []
        edges: dict[tuple, dict] = {}

        # Add all agents as nodes
        for agent_id, profile in self.bridge._profile_map.items():
            persona = self.bridge.get_persona(agent_id)
            nodes.append({
                "id": agent_id,
                "name": profile.name,
                "role": profile.role.value,
                "org": profile.org.name,
                "team": profile.team.name,
                "location": profile.location.city,
                "country": profile.location.country,
                "stress": persona.stress_level if persona else 0,
                "morale": persona.morale if persona else 0.5,
            })

        # Build edges from memory system relationships
        for agent_id, mem in self.memory.agents.items():
            for target_id, rel in mem.relationships.items():
                edge_key = tuple(sorted([agent_id, target_id]))
                if edge_key not in edges:
                    edges[edge_key] = {
                        "source": edge_key[0],
                        "target": edge_key[1],
                        "weight": 0,
                        "sentiment": 0,
                        "types": [],
                    }
                edges[edge_key]["weight"] += rel.interaction_count
                edges[edge_key]["sentiment"] = rel.overall_sentiment
                if rel.dominant_type.value not in edges[edge_key]["types"]:
                    edges[edge_key]["types"].append(rel.dominant_type.value)

        # Also add edges from OASIS comment interactions
        try:
            conn = self._conn()
            comments = conn.execute(
                "SELECT c.user_id as commenter, p.user_id as poster "
                "FROM comment c JOIN post p ON c.post_id = p.post_id"
            ).fetchall()
            for c in comments:
                c_id = self.bridge.get_our_agent_id(int(c["commenter"])) if c["commenter"] else None
                p_id = self.bridge.get_our_agent_id(int(c["poster"])) if c["poster"] else None
                if c_id and p_id and c_id != p_id:
                    edge_key = tuple(sorted([c_id, p_id]))
                    if edge_key not in edges:
                        edges[edge_key] = {
                            "source": edge_key[0],
                            "target": edge_key[1],
                            "weight": 0,
                            "sentiment": 0,
                            "types": [],
                        }
                    edges[edge_key]["weight"] += 1
                    if "comment" not in edges[edge_key]["types"]:
                        edges[edge_key]["types"].append("comment")
            conn.close()
        except Exception:
            pass

        return {"nodes": nodes, "edges": list(edges.values())}

    def get_agent_details(self) -> list[dict]:
        """Get all agents with their current state, relationships, and memory."""
        agents = []
        for agent_id, profile in self.bridge._profile_map.items():
            persona = self.bridge.get_persona(agent_id)
            mem = self.memory.get(agent_id)

            agent_data = {
                "id": agent_id,
                "name": profile.name,
                "role": profile.role.value,
                "org": profile.org.name,
                "team": profile.team.name,
                "location": profile.location.city,
                "country": profile.location.country,
                "industry": profile.org.industry,
                "activity_level": profile.activity_level,
                "traits": profile.personality_traits,
                "expertise": profile.expertise,
            }

            if persona:
                agent_data["persona"] = persona.to_dict()
                agent_data["stress_level"] = persona.stress_level
                agent_data["morale"] = persona.morale

            if mem:
                agent_data["memory"] = mem.to_dict()
                agent_data["emotional_state"] = mem.get_emotional_state_summary()
                agent_data["relationships"] = {
                    tid: r.to_dict() for tid, r in mem.relationships.items()
                }

            agents.append(agent_data)

        return agents

    def get_geo_breakdown(self) -> dict:
        """Analyze activity patterns by geography."""
        geo_data: dict[str, dict] = {}

        for agent_id, profile in self.bridge._profile_map.items():
            geo_key = f"{profile.location.city}, {profile.location.country}"
            if geo_key not in geo_data:
                geo_data[geo_key] = {
                    "location": profile.location.city,
                    "country": profile.location.country,
                    "agents": [],
                    "orgs": set(),
                    "post_count": 0,
                    "avg_stress": 0,
                    "avg_morale": 0,
                }
            geo_data[geo_key]["agents"].append(profile.name)
            geo_data[geo_key]["orgs"].add(profile.org.name)

            persona = self.bridge.get_persona(agent_id)
            if persona:
                geo_data[geo_key]["avg_stress"] += persona.stress_level
                geo_data[geo_key]["avg_morale"] += persona.morale

        # Count posts per geo
        try:
            conn = self._conn()
            posts = conn.execute("SELECT user_id FROM post").fetchall()
            for post in posts:
                our_id = self.bridge.get_our_agent_id(int(post["user_id"])) if post["user_id"] else None
                profile = self.bridge.get_profile(our_id) if our_id else None
                if profile:
                    geo_key = f"{profile.location.city}, {profile.location.country}"
                    if geo_key in geo_data:
                        geo_data[geo_key]["post_count"] += 1
            conn.close()
        except Exception:
            pass

        # Finalize averages
        for geo_key, data in geo_data.items():
            n = len(data["agents"])
            if n > 0:
                data["avg_stress"] = round(data["avg_stress"] / n, 2)
                data["avg_morale"] = round(data["avg_morale"] / n, 2)
            data["orgs"] = list(data["orgs"])

        return geo_data

    def get_faction_analysis(self) -> dict:
        """Analyze inter-faction (inter-org) dynamics."""
        factions: dict[str, dict] = {}

        for agent_id, profile in self.bridge._profile_map.items():
            org = profile.org.name
            if org not in factions:
                factions[org] = {
                    "org": org,
                    "industry": profile.org.industry,
                    "agent_count": 0,
                    "avg_stress": 0,
                    "avg_morale": 0,
                    "post_count": 0,
                    "sentiment_toward": {},  # other org -> avg sentiment
                }
            factions[org]["agent_count"] += 1
            persona = self.bridge.get_persona(agent_id)
            if persona:
                factions[org]["avg_stress"] += persona.stress_level
                factions[org]["avg_morale"] += persona.morale

        # Cross-faction sentiment from memory
        for agent_id, mem in self.memory.agents.items():
            my_profile = self.bridge.get_profile(agent_id)
            if not my_profile:
                continue
            my_org = my_profile.org.name

            for target_id, rel in mem.relationships.items():
                target_profile = self.bridge.get_profile(target_id)
                if not target_profile or target_profile.org.name == my_org:
                    continue

                target_org = target_profile.org.name
                if target_org not in factions[my_org]["sentiment_toward"]:
                    factions[my_org]["sentiment_toward"][target_org] = {
                        "scores": [], "dominant_types": Counter()
                    }
                factions[my_org]["sentiment_toward"][target_org]["scores"].append(
                    rel.overall_sentiment
                )
                factions[my_org]["sentiment_toward"][target_org]["dominant_types"][
                    rel.dominant_type.value
                ] += 1

        # Finalize
        for org, data in factions.items():
            n = data["agent_count"]
            if n > 0:
                data["avg_stress"] = round(data["avg_stress"] / n, 2)
                data["avg_morale"] = round(data["avg_morale"] / n, 2)

            for target_org, sent_data in data["sentiment_toward"].items():
                scores = sent_data["scores"]
                data["sentiment_toward"][target_org] = {
                    "avg_sentiment": round(sum(scores) / len(scores), 2) if scores else 0,
                    "dominant_dynamic": sent_data["dominant_types"].most_common(1)[0][0] if sent_data["dominant_types"] else "unknown",
                }

        return factions

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
