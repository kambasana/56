"""Persona system - rich personality definitions for agents."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class MBTI(Enum):
    INTJ = "INTJ"
    INTP = "INTP"
    ENTJ = "ENTJ"
    ENTP = "ENTP"
    INFJ = "INFJ"
    INFP = "INFP"
    ENFJ = "ENFJ"
    ENFP = "ENFP"
    ISTJ = "ISTJ"
    ISFJ = "ISFJ"
    ESTJ = "ESTJ"
    ESFJ = "ESFJ"
    ISTP = "ISTP"
    ISFP = "ISFP"
    ESTP = "ESTP"
    ESFP = "ESFP"


class CommunicationStyle(Enum):
    DIRECT = "direct"
    DIPLOMATIC = "diplomatic"
    ANALYTICAL = "analytical"
    EXPRESSIVE = "expressive"
    STORYTELLER = "storyteller"
    PROVOCATIVE = "provocative"
    SUPPORTIVE = "supportive"
    FORMAL = "formal"
    CASUAL = "casual"
    TECHNICAL = "technical"


class EmotionalTendency(Enum):
    OPTIMISTIC = "optimistic"
    SKEPTICAL = "skeptical"
    PASSIONATE = "passionate"
    RESERVED = "reserved"
    EMPATHETIC = "empathetic"
    COMPETITIVE = "competitive"
    COLLABORATIVE = "collaborative"
    INDEPENDENT = "independent"


class ConflictStyle(Enum):
    CONFRONTATIONAL = "confrontational"
    AVOIDANT = "avoidant"
    COMPROMISING = "compromising"
    ACCOMMODATING = "accommodating"
    COLLABORATIVE = "collaborative"


class SocialMediaBehavior(Enum):
    POWER_POSTER = "power_poster"        # posts frequently, high engagement
    LURKER = "lurker"                     # reads a lot, rarely posts
    COMMENTER = "commenter"              # mainly comments on others' posts
    SHARER = "sharer"                     # shares/reposts a lot
    THOUGHT_LEADER = "thought_leader"    # original long-form content
    REACTOR = "reactor"                   # heavy on reactions/likes
    NETWORKER = "networker"              # DMs a lot, connects people
    DEBATER = "debater"                   # engages in discussions/debates


@dataclass
class Persona:
    """Rich personality definition for an agent."""

    name: str
    age: int = 35
    gender: str = "unspecified"
    mbti: MBTI = MBTI.ENTJ
    communication_style: CommunicationStyle = CommunicationStyle.DIRECT
    emotional_tendency: EmotionalTendency = EmotionalTendency.OPTIMISTIC
    conflict_style: ConflictStyle = ConflictStyle.COLLABORATIVE
    social_media_behavior: SocialMediaBehavior = SocialMediaBehavior.POWER_POSTER

    # Personality traits (free-form)
    traits: list[str] = field(default_factory=lambda: ["professional", "curious"])

    # What they care about / talk about
    interests: list[str] = field(default_factory=list)

    # Professional expertise
    expertise: list[str] = field(default_factory=list)

    # Language/tone preferences
    vocabulary_level: str = "professional"  # casual, professional, academic, slang
    uses_humor: bool = False
    uses_jargon: bool = True
    emoji_usage: str = "minimal"  # none, minimal, moderate, heavy

    # Biases and perspectives
    biases: list[str] = field(default_factory=list)  # e.g. "favors agile over waterfall"
    worldview: str = ""  # brief worldview description

    # Background
    background: str = ""  # free-form background story

    # Activity parameters
    posting_frequency: float = 0.5   # 0-1
    reply_probability: float = 0.3   # 0-1
    reaction_probability: float = 0.5  # 0-1
    dm_probability: float = 0.1      # 0-1

    def to_system_prompt(self, role: str, team: str, org: str, location: str,
                         team_focus: str) -> str:
        """Generate a rich system prompt for CAMEL agent creation."""
        lines = [
            f"You are {self.name}, age {self.age}, a {role} on the {team} team "
            f"at {org}. Based in {location}.",
            f"Team focus: {team_focus}.",
        ]

        if self.background:
            lines.append(f"Background: {self.background}")

        lines.append(f"MBTI: {self.mbti.value}. "
                      f"Communication: {self.communication_style.value}. "
                      f"Emotional tendency: {self.emotional_tendency.value}. "
                      f"Conflict style: {self.conflict_style.value}.")

        if self.traits:
            lines.append(f"Key traits: {', '.join(self.traits)}.")

        if self.expertise:
            lines.append(f"Expertise: {', '.join(self.expertise)}.")

        if self.interests:
            lines.append(f"Interests: {', '.join(self.interests)}.")

        if self.biases:
            lines.append(f"Perspectives: {', '.join(self.biases)}.")

        if self.worldview:
            lines.append(f"Worldview: {self.worldview}")

        # Social media behavior instructions
        behavior_instructions = {
            SocialMediaBehavior.POWER_POSTER: "You post frequently with high energy. You're always sharing updates and engaging.",
            SocialMediaBehavior.LURKER: "You rarely post but when you do it's meaningful. You mostly observe.",
            SocialMediaBehavior.COMMENTER: "You prefer commenting on others' posts over creating your own.",
            SocialMediaBehavior.SHARER: "You love amplifying others' content with your own take.",
            SocialMediaBehavior.THOUGHT_LEADER: "You write thoughtful, original long-form content.",
            SocialMediaBehavior.REACTOR: "You're generous with reactions and brief encouragement.",
            SocialMediaBehavior.NETWORKER: "You connect people, make introductions, and DM frequently.",
            SocialMediaBehavior.DEBATER: "You enjoy respectful debate and aren't afraid to challenge ideas.",
        }
        lines.append(behavior_instructions.get(
            self.social_media_behavior,
            "You engage naturally on social media."
        ))

        # Tone guidance
        tone_parts = []
        if self.uses_humor:
            tone_parts.append("use humor when appropriate")
        if self.uses_jargon:
            tone_parts.append("use industry jargon naturally")
        tone_parts.append(f"vocabulary level: {self.vocabulary_level}")
        tone_parts.append(f"emoji usage: {self.emoji_usage}")
        lines.append(f"Tone: {', '.join(tone_parts)}.")

        lines.append(
            "You interact on an internal social platform. "
            "Keep posts concise and authentic to your persona."
        )

        return " ".join(lines)

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "age": self.age,
            "gender": self.gender,
            "mbti": self.mbti.value,
            "communication_style": self.communication_style.value,
            "emotional_tendency": self.emotional_tendency.value,
            "conflict_style": self.conflict_style.value,
            "social_media_behavior": self.social_media_behavior.value,
            "traits": self.traits,
            "interests": self.interests,
            "expertise": self.expertise,
            "vocabulary_level": self.vocabulary_level,
            "uses_humor": self.uses_humor,
            "uses_jargon": self.uses_jargon,
            "emoji_usage": self.emoji_usage,
            "biases": self.biases,
            "worldview": self.worldview,
            "background": self.background,
            "posting_frequency": self.posting_frequency,
            "reply_probability": self.reply_probability,
            "reaction_probability": self.reaction_probability,
            "dm_probability": self.dm_probability,
        }

    @classmethod
    def from_dict(cls, d: dict) -> Persona:
        return cls(
            name=d["name"],
            age=d.get("age", 35),
            gender=d.get("gender", "unspecified"),
            mbti=MBTI(d.get("mbti", "ENTJ")),
            communication_style=CommunicationStyle(d.get("communication_style", "direct")),
            emotional_tendency=EmotionalTendency(d.get("emotional_tendency", "optimistic")),
            conflict_style=ConflictStyle(d.get("conflict_style", "collaborative")),
            social_media_behavior=SocialMediaBehavior(d.get("social_media_behavior", "power_poster")),
            traits=d.get("traits", []),
            interests=d.get("interests", []),
            expertise=d.get("expertise", []),
            vocabulary_level=d.get("vocabulary_level", "professional"),
            uses_humor=d.get("uses_humor", False),
            uses_jargon=d.get("uses_jargon", True),
            emoji_usage=d.get("emoji_usage", "minimal"),
            biases=d.get("biases", []),
            worldview=d.get("worldview", ""),
            background=d.get("background", ""),
            posting_frequency=d.get("posting_frequency", 0.5),
            reply_probability=d.get("reply_probability", 0.3),
            reaction_probability=d.get("reaction_probability", 0.5),
            dm_probability=d.get("dm_probability", 0.1),
        )


# --- Preset Persona Templates ---

PERSONA_TEMPLATES: dict[str, dict] = {
    "visionary_ceo": {
        "age": 48, "mbti": "ENTJ",
        "communication_style": "expressive",
        "emotional_tendency": "passionate",
        "conflict_style": "confrontational",
        "social_media_behavior": "thought_leader",
        "traits": ["visionary", "decisive", "charismatic", "demanding"],
        "vocabulary_level": "professional",
        "uses_humor": True, "emoji_usage": "minimal",
        "worldview": "Technology and bold leadership can transform industries.",
        "posting_frequency": 0.4, "reply_probability": 0.2,
        "reaction_probability": 0.3, "dm_probability": 0.15,
    },
    "quiet_engineer": {
        "age": 29, "mbti": "INTP",
        "communication_style": "technical",
        "emotional_tendency": "reserved",
        "conflict_style": "avoidant",
        "social_media_behavior": "lurker",
        "traits": ["analytical", "introverted", "detail-oriented", "innovative"],
        "vocabulary_level": "academic",
        "uses_humor": False, "uses_jargon": True, "emoji_usage": "none",
        "worldview": "Good code speaks for itself. Simplicity over complexity.",
        "posting_frequency": 0.15, "reply_probability": 0.2,
        "reaction_probability": 0.4, "dm_probability": 0.05,
    },
    "social_butterfly": {
        "age": 26, "mbti": "ENFP",
        "communication_style": "expressive",
        "emotional_tendency": "optimistic",
        "conflict_style": "accommodating",
        "social_media_behavior": "power_poster",
        "traits": ["enthusiastic", "creative", "spontaneous", "people-person"],
        "vocabulary_level": "casual",
        "uses_humor": True, "emoji_usage": "heavy",
        "worldview": "Work should be fun and everyone deserves to be heard.",
        "posting_frequency": 0.9, "reply_probability": 0.6,
        "reaction_probability": 0.8, "dm_probability": 0.3,
    },
    "data_skeptic": {
        "age": 42, "mbti": "ISTJ",
        "communication_style": "analytical",
        "emotional_tendency": "skeptical",
        "conflict_style": "confrontational",
        "social_media_behavior": "debater",
        "traits": ["rigorous", "questioning", "methodical", "evidence-driven"],
        "vocabulary_level": "academic",
        "uses_humor": False, "uses_jargon": True, "emoji_usage": "none",
        "worldview": "Claims without data are just opinions. Show me the numbers.",
        "posting_frequency": 0.35, "reply_probability": 0.5,
        "reaction_probability": 0.2, "dm_probability": 0.1,
    },
    "empathetic_manager": {
        "age": 38, "mbti": "ENFJ",
        "communication_style": "supportive",
        "emotional_tendency": "empathetic",
        "conflict_style": "collaborative",
        "social_media_behavior": "networker",
        "traits": ["empathetic", "organized", "people-first", "diplomatic"],
        "vocabulary_level": "professional",
        "uses_humor": True, "emoji_usage": "moderate",
        "worldview": "Happy teams build great products. Culture eats strategy.",
        "posting_frequency": 0.5, "reply_probability": 0.5,
        "reaction_probability": 0.7, "dm_probability": 0.25,
    },
    "ambitious_newcomer": {
        "age": 23, "mbti": "ESTP",
        "communication_style": "direct",
        "emotional_tendency": "competitive",
        "conflict_style": "confrontational",
        "social_media_behavior": "power_poster",
        "traits": ["ambitious", "fast-learner", "eager", "bold"],
        "vocabulary_level": "casual",
        "uses_humor": True, "emoji_usage": "moderate",
        "worldview": "Move fast, learn from mistakes. Age is just a number.",
        "posting_frequency": 0.7, "reply_probability": 0.4,
        "reaction_probability": 0.6, "dm_probability": 0.2,
    },
    "research_purist": {
        "age": 52, "mbti": "INTJ",
        "communication_style": "formal",
        "emotional_tendency": "independent",
        "conflict_style": "compromising",
        "social_media_behavior": "thought_leader",
        "traits": ["methodical", "patient", "precise", "principled"],
        "vocabulary_level": "academic",
        "uses_humor": False, "uses_jargon": True, "emoji_usage": "none",
        "worldview": "Rigor and reproducibility are non-negotiable.",
        "posting_frequency": 0.2, "reply_probability": 0.3,
        "reaction_probability": 0.2, "dm_probability": 0.05,
    },
    "creative_rebel": {
        "age": 31, "mbti": "ENFP",
        "communication_style": "provocative",
        "emotional_tendency": "passionate",
        "conflict_style": "confrontational",
        "social_media_behavior": "debater",
        "traits": ["unconventional", "risk-taker", "artistic", "outspoken"],
        "vocabulary_level": "casual",
        "uses_humor": True, "emoji_usage": "moderate",
        "worldview": "Rules are guidelines. The best ideas come from breaking norms.",
        "posting_frequency": 0.6, "reply_probability": 0.5,
        "reaction_probability": 0.5, "dm_probability": 0.15,
    },
    "process_guardian": {
        "age": 45, "mbti": "ESTJ",
        "communication_style": "formal",
        "emotional_tendency": "skeptical",
        "conflict_style": "confrontational",
        "social_media_behavior": "commenter",
        "traits": ["structured", "rule-following", "reliable", "blunt"],
        "vocabulary_level": "professional",
        "uses_humor": False, "emoji_usage": "none",
        "worldview": "Process exists for a reason. Consistency breeds excellence.",
        "posting_frequency": 0.3, "reply_probability": 0.4,
        "reaction_probability": 0.3, "dm_probability": 0.1,
    },
    "connector": {
        "age": 34, "mbti": "ESFJ",
        "communication_style": "diplomatic",
        "emotional_tendency": "collaborative",
        "conflict_style": "accommodating",
        "social_media_behavior": "networker",
        "traits": ["warm", "inclusive", "relationship-builder", "attentive"],
        "vocabulary_level": "professional",
        "uses_humor": True, "emoji_usage": "moderate",
        "worldview": "The best solutions come from bringing the right people together.",
        "posting_frequency": 0.5, "reply_probability": 0.6,
        "reaction_probability": 0.7, "dm_probability": 0.35,
    },
}


def create_persona_from_template(template_name: str, name: str, **overrides) -> Persona:
    """Create a Persona from a preset template with optional overrides."""
    if template_name not in PERSONA_TEMPLATES:
        raise ValueError(
            f"Unknown template: {template_name}. "
            f"Available: {', '.join(PERSONA_TEMPLATES.keys())}"
        )
    data = {**PERSONA_TEMPLATES[template_name], **overrides, "name": name}
    return Persona.from_dict(data)
