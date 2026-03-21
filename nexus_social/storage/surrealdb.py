"""SurrealDB storage backend — single source of truth for the social platform.

Uses SurrealDB's graph-native model: agents are nodes, relationships are
edges with trust/respect/warmth/tension properties. Posts, comments, likes
are also graph edges connecting agents to content.

Supports both embedded mode (dev) and server mode (multi-user production).
"""

from __future__ import annotations

import logging
from typing import Any

from surrealdb import AsyncSurreal

logger = logging.getLogger(__name__)


class SurrealStorage:
    """SurrealDB-backed storage for the multi-agent social platform.

    Connection modes:
        - Embedded (dev):    SurrealStorage("mem://")
        - Embedded (file):   SurrealStorage("surrealkv://./data/sim.db")
        - Server (prod):     SurrealStorage("ws://localhost:8000")
    """

    def __init__(self, url: str = "mem://",
                 namespace: str = "nexus",
                 database: str = "simulation"):
        self.url = url
        self.namespace = namespace
        self.database = database
        self._db: AsyncSurreal | None = None

    async def connect(self):
        """Connect to SurrealDB and initialize schema."""
        self._db = AsyncSurreal(self.url)
        await self._db.connect()
        await self._db.use(self.namespace, self.database)
        await self._init_schema()
        logger.info(f"SurrealDB connected: {self.url}/{self.namespace}/{self.database}")

    async def close(self):
        """Close the connection."""
        if self._db:
            await self._db.close()
            self._db = None

    @property
    def db(self) -> AsyncSurreal:
        if not self._db:
            raise RuntimeError("Not connected. Call connect() first.")
        return self._db

    @staticmethod
    def _rows(result: Any) -> list[dict]:
        """Normalize query/select result to a list of dicts."""
        if isinstance(result, list):
            return result
        if result is None:
            return []
        return [result]

    @staticmethod
    def _one(result: Any) -> dict | None:
        """Extract a single row from query/select result."""
        if isinstance(result, list):
            return result[0] if result else None
        return result

    # ── Schema ──────────────────────────────────────────────────────

    async def _init_schema(self):
        """Define tables and fields. SurrealDB is schemaless by default,
        but we define structure for clarity and indexing."""
        await self.db.query("""
            -- Agent node (SCHEMALESS for flexibility)
            DEFINE TABLE agent SCHEMALESS;
            DEFINE INDEX idx_agent_org ON agent FIELDS org;

            -- Post node
            DEFINE TABLE post SCHEMALESS;
            DEFINE INDEX idx_post_author ON post FIELDS author;
            DEFINE INDEX idx_post_time ON post FIELDS created_at;

            -- Comment node
            DEFINE TABLE comment SCHEMALESS;
            DEFINE INDEX idx_comment_post ON comment FIELDS post;

            -- Graph edges: agent relationships
            DEFINE TABLE follows TYPE RELATION IN agent OUT agent;
            DEFINE TABLE trusts TYPE RELATION IN agent OUT agent;

            -- Graph edges: agent <-> content interactions
            DEFINE TABLE liked TYPE RELATION IN agent OUT post;
            DEFINE TABLE disliked TYPE RELATION IN agent OUT post;
            DEFINE TABLE reposted TYPE RELATION IN agent OUT post;

            -- Memories
            DEFINE TABLE memory SCHEMALESS;
            DEFINE INDEX idx_memory_agent ON memory FIELDS agent;
            DEFINE INDEX idx_memory_salience ON memory FIELDS salience;

            -- Simulation events (narrative layer)
            DEFINE TABLE sim_event SCHEMALESS;

            -- Action trace (audit log)
            DEFINE TABLE trace SCHEMALESS;
            DEFINE INDEX idx_trace_agent ON trace FIELDS agent;
            DEFINE INDEX idx_trace_tick ON trace FIELDS tick;
        """)

    # ── Agent CRUD ──────────────────────────────────────────────────

    async def create_agent(self, agent_id: str, data: dict[str, Any]) -> dict:
        """Create an agent node."""
        result = await self.db.create(f"agent:{agent_id}", data)
        return result

    async def get_agent(self, agent_id: str) -> dict | None:
        """Get an agent by ID."""
        result = await self.db.select(f"agent:{agent_id}")
        # select returns a list
        if isinstance(result, list):
            return self._one(result)
        return result if result else None

    async def update_agent(self, agent_id: str, data: dict[str, Any]) -> dict:
        """Update agent fields."""
        result = await self.db.merge(f"agent:{agent_id}", data)
        return result

    async def get_all_agents(self) -> list[dict]:
        """Get all agents."""
        result = await self.db.select("agent")
        return result if isinstance(result, list) else []

    # ── Posts ────────────────────────────────────────────────────────

    async def create_post(self, post_id: str, author_id: str,
                          content: str, **kwargs) -> dict:
        """Create a post linked to its author."""
        data = {
            "content": content,
            "author": f"agent:{author_id}",
            **kwargs,
        }
        result = await self.db.create(f"post:{post_id}", data)
        # Log in trace
        await self._trace(author_id, "create_post", {"post_id": post_id})
        return result

    async def get_post(self, post_id: str) -> dict | None:
        result = await self.db.select(f"post:{post_id}")
        if isinstance(result, list):
            return self._one(result)
        return result if result else None

    async def get_feed(self, limit: int = 50) -> list[dict]:
        """Get recent posts with author info and engagement counts."""
        result = await self.db.query("""
            SELECT *,
                   author.name AS author_name,
                   author.org AS author_org,
                   author.role AS author_role,
                   author.team AS author_team,
                   author.location AS author_location,
                   author.country AS author_country,
                   author.stress AS author_stress,
                   author.morale AS author_morale,
                   count(->liked<-agent) AS like_count,
                   count(->disliked<-agent) AS dislike_count,
                   (SELECT content, author.name AS author_name,
                           author.org AS author_org, created_at
                    FROM comment WHERE post = $parent.id
                    ORDER BY created_at ASC) AS comments
            FROM post
            ORDER BY created_at DESC
            LIMIT $limit
        """, {"limit": limit})
        return result if isinstance(result, list) else []

    # ── Comments ────────────────────────────────────────────────────

    async def create_comment(self, comment_id: str, author_id: str,
                             post_id: str, content: str, **kwargs) -> dict:
        data = {
            "content": content,
            "author": f"agent:{author_id}",
            "post": f"post:{post_id}",
            **kwargs,
        }
        result = await self.db.create(f"comment:{comment_id}", data)
        await self._trace(author_id, "create_comment",
                          {"post_id": post_id, "comment_id": comment_id})
        return result

    # ── Graph edges: social interactions ─────────────────────────────

    async def follow(self, follower_id: str, followee_id: str):
        """Create a follow edge."""
        await self.db.query(
            f"RELATE agent:{follower_id}->follows->agent:{followee_id}"
        )
        await self._trace(follower_id, "follow", {"followee_id": followee_id})

    async def unfollow(self, follower_id: str, followee_id: str):
        """Remove a follow edge."""
        await self.db.query(
            f"DELETE follows WHERE in = agent:{follower_id} AND out = agent:{followee_id}"
        )

    async def like_post(self, agent_id: str, post_id: str):
        """Create a like edge."""
        await self.db.query(
            f"RELATE agent:{agent_id}->liked->post:{post_id}"
        )
        await self._trace(agent_id, "like_post", {"post_id": post_id})

    async def dislike_post(self, agent_id: str, post_id: str):
        await self.db.query(
            f"RELATE agent:{agent_id}->disliked->post:{post_id}"
        )
        await self._trace(agent_id, "dislike_post", {"post_id": post_id})

    async def repost(self, agent_id: str, post_id: str):
        await self.db.query(
            f"RELATE agent:{agent_id}->reposted->post:{post_id}"
        )
        await self._trace(agent_id, "repost", {"post_id": post_id})

    # ── Graph edges: agent relationships (trust network) ─────────────

    async def update_relationship(self, from_id: str, to_id: str,
                                  data: dict[str, Any]):
        """Create or update a trust/relationship edge between agents."""
        trust = data.get("trust", 0.5)
        respect = data.get("respect", 0.5)
        warmth = data.get("warmth", 0.4)
        tension = data.get("tension", 0.0)
        tags = data.get("tags", [])
        opinion = data.get("opinion", "")
        count = data.get("interaction_count", 0)
        tick = data.get("last_interaction_tick", 0)

        # Delete existing and recreate (simpler than upsert with RELATE)
        await self.db.query(
            f"DELETE trusts WHERE in = agent:{from_id} AND out = agent:{to_id}"
        )
        await self.db.query(
            f"RELATE agent:{from_id}->trusts->agent:{to_id} SET "
            f"trust = $trust, respect = $respect, warmth = $warmth, "
            f"tension = $tension, tags = $tags, opinion = $opinion, "
            f"interaction_count = $count, last_interaction_tick = $tick",
            {
                "trust": trust, "respect": respect, "warmth": warmth,
                "tension": tension, "tags": tags, "opinion": opinion,
                "count": count, "tick": tick,
            }
        )

    async def get_relationship(self, from_id: str, to_id: str) -> dict | None:
        """Get the trust edge between two agents."""
        result = await self.db.query(
            f"SELECT * FROM trusts WHERE in = agent:{from_id} AND out = agent:{to_id} LIMIT 1"
        )
        rows = self._rows(result)
        return rows[0] if rows else None

    async def get_agent_relationships(self, agent_id: str) -> list[dict]:
        """Get all relationships for an agent."""
        result = await self.db.query(
            f"SELECT *, out.name AS target_name, out.org AS target_org "
            f"FROM trusts WHERE in = agent:{agent_id}"
        )
        return self._rows(result)

    # ── Graph queries: the good stuff ────────────────────────────────

    async def get_influence_chain(self, agent_id: str,
                                  max_depth: int = 3) -> list[dict]:
        """Find agents reachable through trust network up to N hops."""
        result = await self.db.query("""
            SELECT out.name AS name, out.org AS org,
                   trust, respect, warmth
            FROM agent:$id->trusts.{1..$depth}
        """, {"id": agent_id, "depth": max_depth})
        return self._rows(result)

    async def get_narrative_spread(self, keyword: str) -> list[dict]:
        """Track how a narrative keyword spreads through the network.
        Returns the chain: original poster -> commenters -> their followers."""
        result = await self.db.query("""
            SELECT
                post.author.name AS origin,
                post.author.org AS origin_org,
                post.content AS original_content,
                comment.author.name AS amplifier,
                comment.author.org AS amplifier_org,
                comment.content AS response,
                count(comment.author->follows<-agent) AS amplifier_reach
            FROM comment
            WHERE post.content CONTAINS $keyword
               OR content CONTAINS $keyword
            ORDER BY amplifier_reach DESC
        """, {"keyword": keyword})
        return self._rows(result)

    async def get_cross_org_interactions(self) -> list[dict]:
        """Find all interactions between agents of different orgs."""
        result = await self.db.query("""
            SELECT
                comment.author.name AS commenter,
                comment.author.org AS commenter_org,
                post.author.name AS poster,
                post.author.org AS poster_org,
                comment.content AS content
            FROM comment
            WHERE comment.author.org != post.author.org
            ORDER BY comment.created_at DESC
        """)
        return self._rows(result)

    async def get_community_activity(self, org: str) -> dict:
        """Get activity summary for an organization."""
        result = await self.db.query("""
            LET $agents = (SELECT id, name, stress, morale FROM agent
                           WHERE org = $org);
            LET $posts = (SELECT count() AS cnt FROM post
                          WHERE author.org = $org GROUP ALL);
            LET $comments = (SELECT count() AS cnt FROM comment
                             WHERE author.org = $org GROUP ALL);
            RETURN {
                agents: $agents,
                post_count: $posts[0].cnt OR 0,
                comment_count: $comments[0].cnt OR 0,
                avg_stress: math::mean($agents.stress),
                avg_morale: math::mean($agents.morale)
            }
        """, {"org": org})
        return self._one(result) or {}

    async def get_network_graph(self) -> dict:
        """Build the full social graph for visualization."""
        nodes = self._rows(await self.db.query(
            "SELECT id, name, role, org, team, location, country, stress, morale FROM agent"
        ))
        edges = self._rows(await self.db.query(
            "SELECT in.id AS source, out.id AS target, "
            "trust, respect, warmth, tension, interaction_count AS weight, tags "
            "FROM trusts"
        ))
        follow_edges = self._rows(await self.db.query(
            "SELECT in.id AS source, out.id AS target, 'follows' AS type FROM follows"
        ))
        return {
            "nodes": nodes,
            "edges": edges + follow_edges,
        }

    # ── Memories ────────────────────────────────────────────────────

    async def store_memory(self, memory_id: str, agent_id: str,
                           tick: int, event_type: str, summary: str,
                           about_agent_id: str | None = None,
                           emotional_impact: float = 0.0,
                           salience: float = 0.5):
        data = {
            "agent": f"agent:{agent_id}",
            "tick": tick,
            "event_type": event_type,
            "summary": summary,
            "about_agent": f"agent:{about_agent_id}" if about_agent_id else None,
            "emotional_impact": emotional_impact,
            "salience": salience,
        }
        await self.db.create(f"memory:{memory_id}", data)

    async def get_agent_memories(self, agent_id: str,
                                 limit: int = 20) -> list[dict]:
        result = await self.db.query("""
            SELECT *, about_agent.name AS about_name
            FROM memory
            WHERE agent = $agent
            ORDER BY salience DESC, created_at DESC
            LIMIT $limit
        """, {"agent": f"agent:{agent_id}", "limit": limit})
        return self._rows(result)

    # ── Trace / Audit ───────────────────────────────────────────────

    async def _trace(self, agent_id: str, action: str,
                     info: dict[str, Any] | None = None):
        """Log an action to the trace table."""
        await self.db.query(
            "CREATE trace SET agent = $agent, action = $action, "
            "tick = 0, info = $info",
            {"agent": f"agent:{agent_id}", "action": action,
             "info": info or {}}
        )

    async def get_trace(self, agent_id: str | None = None,
                        limit: int = 100) -> list[dict]:
        if agent_id:
            result = await self.db.query(
                "SELECT *, agent.name AS agent_name FROM trace "
                "WHERE agent = $agent ORDER BY created_at DESC LIMIT $limit",
                {"agent": f"agent:{agent_id}", "limit": limit}
            )
        else:
            result = await self.db.query(
                "SELECT *, agent.name AS agent_name FROM trace "
                "ORDER BY created_at DESC LIMIT $limit",
                {"limit": limit}
            )
        return self._rows(result)

    # ── Analytics helpers ───────────────────────────────────────────

    async def get_analytics(self) -> dict:
        """Platform-wide analytics using simple queries."""
        posts = self._rows(await self.db.query(
            "SELECT count() AS cnt FROM post GROUP ALL"
        ))
        comments = self._rows(await self.db.query(
            "SELECT count() AS cnt FROM comment GROUP ALL"
        ))
        follows = self._rows(await self.db.query(
            "SELECT count() AS cnt FROM follows GROUP ALL"
        ))
        org_activity = self._rows(await self.db.query(
            "SELECT author.org AS org, count() AS cnt FROM post GROUP BY author.org"
        ))
        sentiment = self._rows(await self.db.query(
            "SELECT sentiment, count() AS cnt FROM post GROUP BY sentiment"
        ))

        return {
            "total_posts": posts[0]["cnt"] if posts else 0,
            "total_comments": comments[0]["cnt"] if comments else 0,
            "total_follows": follows[0]["cnt"] if follows else 0,
            "org_activity": org_activity,
            "sentiment_distribution": sentiment,
        }

    async def get_faction_analysis(self) -> list[dict]:
        """Inter-faction dynamics using graph traversal."""
        result = await self.db.query("""
            SELECT
                org,
                count() AS agent_count,
                math::mean(stress) AS avg_stress,
                math::mean(morale) AS avg_morale,
                (SELECT out.org AS target_org,
                        math::mean(trust) AS avg_trust,
                        math::mean(tension) AS avg_tension,
                        count() AS interaction_count
                 FROM ->trusts
                 WHERE out.org != $parent.org
                 GROUP BY out.org) AS cross_org_relations
            FROM agent
            GROUP BY org
        """)
        return self._rows(result)
