"""Social media platform simulation engine."""

from __future__ import annotations

import logging
import random
from datetime import datetime, timedelta

from nexus_social.camel_engine.brain import CamelBrain
from nexus_social.core.models import (
    AgentProfile,
    Comment,
    DirectMessage,
    Document,
    Sentiment,
    SimulationEvent,
    SocialPost,
)

logger = logging.getLogger(__name__)


class SocialPlatform:
    """Simulates a multi-org social media platform with active agent interactions."""

    def __init__(self, brain: CamelBrain):
        self.brain = brain
        self.posts: list[SocialPost] = []
        self.direct_messages: list[DirectMessage] = []
        self.documents: list[Document] = []
        self.events: list[SimulationEvent] = []
        self.agents: list[AgentProfile] = []
        self.tick_count: int = 0
        self.current_time: datetime = datetime.utcnow()

    def register_agents(self, agents: list[AgentProfile]):
        self.agents.extend(agents)
        logger.info(f"Registered {len(agents)} agents on the platform")

    def simulate_tick(self, hours_delta: float = 1.0) -> list[SimulationEvent]:
        """Run one simulation tick. Returns events that occurred."""
        self.tick_count += 1
        self.current_time += timedelta(hours=hours_delta)
        tick_events = []

        # Phase 1: Some agents create new posts
        for agent in self.agents:
            if random.random() < agent.activity_level * 0.25:
                post = self._agent_creates_post(agent)
                tick_events.append(
                    SimulationEvent(
                        event_type="new_post",
                        description=f"{agent.name} posted",
                        participants=[agent],
                        timestamp=self.current_time,
                        data={"post_id": post.id},
                    )
                )

        # Phase 2: Agents react to and comment on recent posts
        recent_posts = self.posts[-20:] if len(self.posts) > 20 else self.posts
        for agent in self.agents:
            for post in recent_posts:
                if post.author.id == agent.id:
                    continue

                # Reactions
                reaction = self.brain.decide_reaction(agent, post)
                if reaction:
                    post.add_reaction(reaction, agent)
                    post.reach += 1

                # Comments
                comment_chance = 0.08
                if agent.team.id == post.author.team.id:
                    comment_chance = 0.25
                elif agent.org.id == post.author.org.id:
                    comment_chance = 0.12

                if random.random() < comment_chance:
                    comment = self._agent_comments(agent, post)
                    tick_events.append(
                        SimulationEvent(
                            event_type="comment",
                            description=f"{agent.name} commented on {post.author.name}'s post",
                            participants=[agent, post.author],
                            timestamp=self.current_time,
                            data={"post_id": post.id, "comment_id": comment.id},
                        )
                    )

        # Phase 3: Document sharing
        if random.random() < 0.15:
            author = random.choice(self.agents)
            doc = self._create_document(author)
            post = self._share_document(author, doc)
            tick_events.append(
                SimulationEvent(
                    event_type="document_shared",
                    description=f'{author.name} shared document: "{doc.title}"',
                    participants=[author],
                    timestamp=self.current_time,
                    data={"doc_id": doc.id, "post_id": post.id},
                )
            )

            # Other agents react to the document
            for agent in self.agents:
                if agent.id == author.id:
                    continue
                if random.random() < 0.1:
                    doc_post = self._agent_reacts_to_document(agent, doc)
                    tick_events.append(
                        SimulationEvent(
                            event_type="document_reaction",
                            description=f"{agent.name} reacted to document",
                            participants=[agent, author],
                            timestamp=self.current_time,
                            data={"doc_id": doc.id, "post_id": doc_post.id},
                        )
                    )

        # Phase 4: Direct messages
        for agent in self.agents:
            if random.random() < agent.activity_level * 0.1:
                recipient = self._pick_dm_recipient(agent)
                if recipient:
                    dm = self._agent_sends_dm(agent, recipient)
                    tick_events.append(
                        SimulationEvent(
                            event_type="direct_message",
                            description=f"{agent.name} messaged {recipient.name}",
                            participants=[agent, recipient],
                            timestamp=self.current_time,
                            data={"dm_id": dm.id},
                        )
                    )

        self.events.extend(tick_events)
        logger.info(
            f"Tick {self.tick_count}: {len(tick_events)} events, "
            f"{len(self.posts)} total posts"
        )
        return tick_events

    def _agent_creates_post(self, agent: AgentProfile) -> SocialPost:
        content = self.brain.generate_post(agent)
        hashtags = self._extract_hashtags(content, agent)
        mentions = self._pick_mentions(agent)
        sentiment = self._infer_sentiment(content)

        post = SocialPost(
            author=agent,
            content=content,
            timestamp=self.current_time,
            mentions=mentions,
            hashtags=hashtags,
            sentiment=sentiment,
        )
        self.posts.append(post)
        return post

    def _agent_comments(self, agent: AgentProfile, post: SocialPost) -> Comment:
        content = self.brain.generate_comment(agent, post)
        comment = Comment(
            author=agent,
            content=content,
            timestamp=self.current_time,
            sentiment=self._infer_sentiment(content),
        )
        post.comments.append(comment)
        post.reach += 1
        return comment

    def _agent_reacts_to_document(
        self, agent: AgentProfile, doc: Document
    ) -> SocialPost:
        content = self.brain.generate_document_reaction(agent, doc)
        post = SocialPost(
            author=agent,
            content=content,
            timestamp=self.current_time,
            shared_document=doc,
            hashtags=doc.tags[:2],
            sentiment=Sentiment.POSITIVE,
        )
        self.posts.append(post)
        doc.views += 1
        return post

    def _share_document(self, author: AgentProfile, doc: Document) -> SocialPost:
        content = (
            f'Just published: "{doc.title}" - '
            f"a {doc.doc_type} on {', '.join(doc.tags[:3]) if doc.tags else author.team.focus}. "
            f"Check it out and share your thoughts!"
        )
        post = SocialPost(
            author=author,
            content=content,
            timestamp=self.current_time,
            shared_document=doc,
            hashtags=doc.tags[:3],
            sentiment=Sentiment.POSITIVE,
        )
        self.posts.append(post)
        return post

    def _agent_sends_dm(
        self, sender: AgentProfile, recipient: AgentProfile
    ) -> DirectMessage:
        content = self.brain.generate_dm(sender, recipient)
        dm = DirectMessage(
            sender=sender,
            recipient=recipient,
            content=content,
            timestamp=self.current_time,
        )
        self.direct_messages.append(dm)
        return dm

    def _create_document(self, author: AgentProfile) -> Document:
        doc_types = ["report", "proposal", "memo", "spec", "research", "analysis"]
        topics = [
            author.team.focus,
            f"{author.org.industry} trends",
            "quarterly review",
            "strategy update",
            "technical deep-dive",
            "market analysis",
            "process improvement",
        ]
        doc_type = random.choice(doc_types)
        topic = random.choice(topics)

        doc = Document(
            title=f"{topic.title()} - {doc_type.title()}",
            content=f"This {doc_type} covers key aspects of {topic} "
            f"from the perspective of {author.team.name} at {author.org.name}. "
            f"Based in {author.location.city}, our team has unique insights into "
            f"regional dynamics and cross-functional implications.",
            author=author,
            doc_type=doc_type,
            created=self.current_time,
            tags=[topic.split()[0].lower(), doc_type, author.org.industry.lower()],
            keywords=[topic, author.team.focus, author.org.industry],
        )
        self.documents.append(doc)
        return doc

    def _pick_mentions(self, agent: AgentProfile) -> list[AgentProfile]:
        if random.random() > 0.3:
            return []
        teammates = [a for a in self.agents if a.team.id == agent.team.id and a.id != agent.id]
        colleagues = [a for a in self.agents if a.org.id == agent.org.id and a.id != agent.id]
        pool = teammates if teammates else colleagues
        if not pool:
            return []
        count = random.randint(1, min(2, len(pool)))
        return random.sample(pool, count)

    def _pick_dm_recipient(self, agent: AgentProfile) -> AgentProfile | None:
        candidates = [a for a in self.agents if a.id != agent.id]
        if not candidates:
            return None
        # Weight toward same org but allow cross-org
        weights = []
        for c in candidates:
            if c.team.id == agent.team.id:
                weights.append(5)
            elif c.org.id == agent.org.id:
                weights.append(3)
            else:
                weights.append(1)
        return random.choices(candidates, weights=weights, k=1)[0]

    def _extract_hashtags(self, content: str, agent: AgentProfile) -> list[str]:
        tags = []
        focus_words = agent.team.focus.lower().split()
        if focus_words:
            tags.append(focus_words[0])
        if random.random() < 0.3:
            tags.append(agent.org.industry.lower().replace(" ", ""))
        return tags

    def _infer_sentiment(self, content: str) -> Sentiment:
        positive_words = {"great", "excited", "love", "amazing", "proud", "excellent",
                          "fantastic", "crushing", "strong", "impressive", "solid"}
        negative_words = {"issue", "problem", "concerned", "difficult", "challenge",
                          "struggling", "bug", "broken"}
        words = set(content.lower().split())
        pos = len(words & positive_words)
        neg = len(words & negative_words)
        if pos > neg + 1:
            return Sentiment.VERY_POSITIVE
        if pos > neg:
            return Sentiment.POSITIVE
        if neg > pos:
            return Sentiment.NEGATIVE
        return Sentiment.NEUTRAL

    def get_feed(self, agent: AgentProfile | None = None, limit: int = 50) -> list[dict]:
        """Get social feed, optionally filtered for a specific agent's perspective."""
        posts = sorted(self.posts, key=lambda p: p.timestamp, reverse=True)[:limit]
        return [p.to_dict() for p in posts]

    def get_analytics(self) -> dict:
        """Get platform-wide analytics."""
        if not self.posts:
            return {"total_posts": 0, "total_comments": 0, "total_dms": 0,
                    "total_documents": 0, "events": 0}

        org_activity: dict[str, int] = {}
        team_activity: dict[str, int] = {}
        location_activity: dict[str, int] = {}
        cross_org_interactions = 0

        for post in self.posts:
            org_name = post.author.org.name
            org_activity[org_name] = org_activity.get(org_name, 0) + 1
            team_key = f"{post.author.team.name}@{org_name}"
            team_activity[team_key] = team_activity.get(team_key, 0) + 1
            loc = post.author.location.city
            location_activity[loc] = location_activity.get(loc, 0) + 1

            for comment in post.comments:
                if comment.author.org.id != post.author.org.id:
                    cross_org_interactions += 1

        sentiment_dist = {}
        for post in self.posts:
            s = post.sentiment.value
            sentiment_dist[s] = sentiment_dist.get(s, 0) + 1

        return {
            "total_posts": len(self.posts),
            "total_comments": sum(len(p.comments) for p in self.posts),
            "total_reactions": sum(p.total_reactions() for p in self.posts),
            "total_dms": len(self.direct_messages),
            "total_documents": len(self.documents),
            "events": len(self.events),
            "ticks": self.tick_count,
            "org_activity": org_activity,
            "team_activity": team_activity,
            "location_activity": location_activity,
            "cross_org_interactions": cross_org_interactions,
            "sentiment_distribution": sentiment_dist,
        }

    def get_network_graph(self) -> dict:
        """Build interaction network graph for visualization."""
        nodes = []
        edges: dict[tuple[str, str], dict] = {}

        agent_map = {a.id: a for a in self.agents}
        for agent in self.agents:
            nodes.append({
                "id": agent.id,
                "name": agent.name,
                "role": agent.role.value,
                "org": agent.org.name,
                "team": agent.team.name,
                "location": agent.location.city,
            })

        # Build edges from interactions
        for post in self.posts:
            # Comments create edges
            for comment in post.comments:
                edge_key = tuple(sorted([post.author.id, comment.author.id]))
                if edge_key not in edges:
                    edges[edge_key] = {"source": edge_key[0], "target": edge_key[1],
                                       "weight": 0, "types": []}
                edges[edge_key]["weight"] += 1
                if "comment" not in edges[edge_key]["types"]:
                    edges[edge_key]["types"].append("comment")

            # Reactions create weaker edges
            for emoji, reactors in post.reactions.items():
                for reactor in reactors:
                    edge_key = tuple(sorted([post.author.id, reactor.id]))
                    if edge_key not in edges:
                        edges[edge_key] = {"source": edge_key[0], "target": edge_key[1],
                                           "weight": 0, "types": []}
                    edges[edge_key]["weight"] += 0.3
                    if "reaction" not in edges[edge_key]["types"]:
                        edges[edge_key]["types"].append("reaction")

            # Mentions
            for mentioned in post.mentions:
                edge_key = tuple(sorted([post.author.id, mentioned.id]))
                if edge_key not in edges:
                    edges[edge_key] = {"source": edge_key[0], "target": edge_key[1],
                                       "weight": 0, "types": []}
                edges[edge_key]["weight"] += 0.5
                if "mention" not in edges[edge_key]["types"]:
                    edges[edge_key]["types"].append("mention")

        # DMs
        for dm in self.direct_messages:
            edge_key = tuple(sorted([dm.sender.id, dm.recipient.id]))
            if edge_key not in edges:
                edges[edge_key] = {"source": edge_key[0], "target": edge_key[1],
                                   "weight": 0, "types": []}
            edges[edge_key]["weight"] += 2
            if "dm" not in edges[edge_key]["types"]:
                edges[edge_key]["types"].append("dm")

        return {
            "nodes": nodes,
            "edges": list(edges.values()),
        }
