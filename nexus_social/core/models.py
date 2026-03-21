"""Core data models for the multi-agent social platform."""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any


class LocationType(Enum):
    HEADQUARTERS = "headquarters"
    BRANCH = "branch"
    REMOTE = "remote"
    SATELLITE = "satellite"


class AgentRole(Enum):
    EXECUTIVE = "executive"
    MANAGER = "manager"
    ENGINEER = "engineer"
    DESIGNER = "designer"
    ANALYST = "analyst"
    MARKETING = "marketing"
    SALES = "sales"
    HR = "hr"
    RESEARCHER = "researcher"
    INTERN = "intern"


class Sentiment(Enum):
    VERY_POSITIVE = "very_positive"
    POSITIVE = "positive"
    NEUTRAL = "neutral"
    NEGATIVE = "negative"
    VERY_NEGATIVE = "very_negative"


@dataclass
class Location:
    name: str
    city: str
    country: str
    timezone: str
    location_type: LocationType
    id: str = field(default_factory=lambda: str(uuid.uuid4())[:8])

    def __repr__(self):
        return f"Location({self.name}, {self.city})"


@dataclass
class Organization:
    name: str
    industry: str
    description: str
    locations: list[Location] = field(default_factory=list)
    teams: list[Team] = field(default_factory=list)
    id: str = field(default_factory=lambda: str(uuid.uuid4())[:8])

    def __repr__(self):
        return f"Org({self.name})"


@dataclass
class Team:
    name: str
    org: Organization
    location: Location
    focus: str
    id: str = field(default_factory=lambda: str(uuid.uuid4())[:8])
    members: list[AgentProfile] = field(default_factory=list)

    def __repr__(self):
        return f"Team({self.name}@{self.org.name})"


@dataclass
class AgentProfile:
    name: str
    role: AgentRole
    team: Team
    personality_traits: list[str] = field(default_factory=list)
    expertise: list[str] = field(default_factory=list)
    communication_style: str = "professional"
    activity_level: float = 0.7  # 0-1, how active on social platform
    id: str = field(default_factory=lambda: str(uuid.uuid4())[:8])

    @property
    def org(self) -> Organization:
        return self.team.org

    @property
    def location(self) -> Location:
        return self.team.location

    def system_prompt(self) -> str:
        return (
            f"You are {self.name}, a {self.role.value} on the {self.team.name} team "
            f"at {self.org.name} ({self.org.industry}). "
            f"You are based in {self.location.city}, {self.location.country}. "
            f"Your team focuses on: {self.team.focus}. "
            f"Your expertise: {', '.join(self.expertise)}. "
            f"Personality: {', '.join(self.personality_traits)}. "
            f"Communication style: {self.communication_style}. "
            f"You interact on an internal social platform where employees across "
            f"organizations share updates, discuss documents, and collaborate. "
            f"Keep responses concise and natural - like real social media posts."
        )

    def __repr__(self):
        return f"Agent({self.name}, {self.role.value}@{self.team.name})"


@dataclass
class SocialPost:
    author: AgentProfile
    content: str
    timestamp: datetime = field(default_factory=datetime.utcnow)
    id: str = field(default_factory=lambda: str(uuid.uuid4())[:8])
    mentions: list[AgentProfile] = field(default_factory=list)
    hashtags: list[str] = field(default_factory=list)
    reactions: dict[str, list[AgentProfile]] = field(default_factory=dict)
    comments: list[Comment] = field(default_factory=list)
    shared_document: Document | None = None
    parent_post: SocialPost | None = None  # for reposts/shares
    sentiment: Sentiment = Sentiment.NEUTRAL
    reach: int = 0
    metadata: dict[str, Any] = field(default_factory=dict)

    def add_reaction(self, emoji: str, agent: AgentProfile):
        if emoji not in self.reactions:
            self.reactions[emoji] = []
        if agent not in self.reactions[emoji]:
            self.reactions[emoji].append(agent)

    def total_reactions(self) -> int:
        return sum(len(agents) for agents in self.reactions.values())

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "author": self.author.name,
            "author_role": self.author.role.value,
            "author_org": self.author.org.name,
            "author_team": self.author.team.name,
            "author_location": self.author.location.city,
            "content": self.content,
            "timestamp": self.timestamp.isoformat(),
            "mentions": [m.name for m in self.mentions],
            "hashtags": self.hashtags,
            "reactions": {k: [a.name for a in v] for k, v in self.reactions.items()},
            "comments": [c.to_dict() for c in self.comments],
            "shared_document": self.shared_document.to_dict() if self.shared_document else None,
            "sentiment": self.sentiment.value,
            "reach": self.reach,
            "total_reactions": self.total_reactions(),
            "comment_count": len(self.comments),
        }


@dataclass
class Comment:
    author: AgentProfile
    content: str
    timestamp: datetime = field(default_factory=datetime.utcnow)
    id: str = field(default_factory=lambda: str(uuid.uuid4())[:8])
    sentiment: Sentiment = Sentiment.NEUTRAL

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "author": self.author.name,
            "author_org": self.author.org.name,
            "content": self.content,
            "timestamp": self.timestamp.isoformat(),
            "sentiment": self.sentiment.value,
        }


@dataclass
class Document:
    title: str
    content: str
    author: AgentProfile
    doc_type: str = "general"  # report, proposal, memo, spec, research
    created: datetime = field(default_factory=datetime.utcnow)
    id: str = field(default_factory=lambda: str(uuid.uuid4())[:8])
    tags: list[str] = field(default_factory=list)
    shared_with: list[AgentProfile] = field(default_factory=list)
    views: int = 0
    keywords: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "doc_type": self.doc_type,
            "author": self.author.name,
            "author_org": self.author.org.name,
            "created": self.created.isoformat(),
            "tags": self.tags,
            "views": self.views,
            "content_preview": self.content[:200],
            "keywords": self.keywords,
        }


@dataclass
class DirectMessage:
    sender: AgentProfile
    recipient: AgentProfile
    content: str
    timestamp: datetime = field(default_factory=datetime.utcnow)
    id: str = field(default_factory=lambda: str(uuid.uuid4())[:8])
    read: bool = False

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "sender": self.sender.name,
            "recipient": self.recipient.name,
            "content": self.content,
            "timestamp": self.timestamp.isoformat(),
            "read": self.read,
        }


@dataclass
class SimulationEvent:
    event_type: str
    description: str
    participants: list[AgentProfile]
    timestamp: datetime = field(default_factory=datetime.utcnow)
    data: dict[str, Any] = field(default_factory=dict)
    id: str = field(default_factory=lambda: str(uuid.uuid4())[:8])

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "type": self.event_type,
            "description": self.description,
            "participants": [p.name for p in self.participants],
            "timestamp": self.timestamp.isoformat(),
            "data": self.data,
        }
