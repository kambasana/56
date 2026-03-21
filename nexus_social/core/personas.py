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
# Military, crisis, intelligence, and warfare-focused archetypes

PERSONA_TEMPLATES: dict[str, dict] = {
    "commanding_officer": {
        "age": 48, "mbti": "ENTJ",
        "communication_style": "direct",
        "emotional_tendency": "passionate",
        "conflict_style": "confrontational",
        "social_media_behavior": "thought_leader",
        "traits": ["decisive", "authoritative", "strategic", "demanding"],
        "vocabulary_level": "professional",
        "uses_humor": False, "uses_jargon": True, "emoji_usage": "none",
        "worldview": "Mission first. Clear orders, decisive action, zero ambiguity.",
        "posting_frequency": 0.4, "reply_probability": 0.3,
        "reaction_probability": 0.2, "dm_probability": 0.2,
    },
    "intelligence_analyst": {
        "age": 34, "mbti": "INTJ",
        "communication_style": "analytical",
        "emotional_tendency": "skeptical",
        "conflict_style": "compromising",
        "social_media_behavior": "thought_leader",
        "traits": ["perceptive", "methodical", "secretive", "pattern-finder"],
        "vocabulary_level": "academic",
        "uses_humor": False, "uses_jargon": True, "emoji_usage": "none",
        "worldview": "Information is power. Every data point tells a story if you look hard enough.",
        "posting_frequency": 0.25, "reply_probability": 0.4,
        "reaction_probability": 0.2, "dm_probability": 0.15,
    },
    "field_operator": {
        "age": 30, "mbti": "ISTP",
        "communication_style": "direct",
        "emotional_tendency": "reserved",
        "conflict_style": "confrontational",
        "social_media_behavior": "lurker",
        "traits": ["calm-under-fire", "resourceful", "adaptive", "taciturn"],
        "vocabulary_level": "casual",
        "uses_humor": False, "uses_jargon": True, "emoji_usage": "none",
        "worldview": "Plans don't survive first contact. Adapt and overcome.",
        "posting_frequency": 0.15, "reply_probability": 0.2,
        "reaction_probability": 0.3, "dm_probability": 0.1,
    },
    "crisis_coordinator": {
        "age": 40, "mbti": "ENFJ",
        "communication_style": "supportive",
        "emotional_tendency": "empathetic",
        "conflict_style": "collaborative",
        "social_media_behavior": "networker",
        "traits": ["calm", "organized", "multi-tasker", "bridge-builder"],
        "vocabulary_level": "professional",
        "uses_humor": False, "emoji_usage": "none",
        "worldview": "Coordination saves lives. Every agency, every asset, aligned to one objective.",
        "posting_frequency": 0.6, "reply_probability": 0.6,
        "reaction_probability": 0.5, "dm_probability": 0.35,
    },
    "cyber_warfare_specialist": {
        "age": 28, "mbti": "INTP",
        "communication_style": "technical",
        "emotional_tendency": "independent",
        "conflict_style": "avoidant",
        "social_media_behavior": "lurker",
        "traits": ["brilliant", "paranoid", "nocturnal", "obsessive"],
        "vocabulary_level": "academic",
        "uses_humor": True, "uses_jargon": True, "emoji_usage": "none",
        "worldview": "The next war will be won or lost in cyberspace. Every system is a target.",
        "posting_frequency": 0.15, "reply_probability": 0.3,
        "reaction_probability": 0.2, "dm_probability": 0.1,
    },
    "diplomatic_envoy": {
        "age": 52, "mbti": "ENFJ",
        "communication_style": "diplomatic",
        "emotional_tendency": "empathetic",
        "conflict_style": "accommodating",
        "social_media_behavior": "networker",
        "traits": ["tactful", "multilingual", "patient", "persuasive"],
        "vocabulary_level": "professional",
        "uses_humor": True, "emoji_usage": "minimal",
        "worldview": "War is a failure of diplomacy. There is always another channel.",
        "posting_frequency": 0.4, "reply_probability": 0.5,
        "reaction_probability": 0.6, "dm_probability": 0.4,
    },
    "combat_medic": {
        "age": 32, "mbti": "ISFJ",
        "communication_style": "supportive",
        "emotional_tendency": "empathetic",
        "conflict_style": "collaborative",
        "social_media_behavior": "commenter",
        "traits": ["compassionate", "steady-hands", "courageous", "tireless"],
        "vocabulary_level": "professional",
        "uses_humor": True, "uses_jargon": True, "emoji_usage": "none",
        "worldview": "Save who you can. Every life matters, enemy or friend.",
        "posting_frequency": 0.3, "reply_probability": 0.5,
        "reaction_probability": 0.6, "dm_probability": 0.2,
    },
    "logistics_officer": {
        "age": 38, "mbti": "ISTJ",
        "communication_style": "formal",
        "emotional_tendency": "skeptical",
        "conflict_style": "compromising",
        "social_media_behavior": "commenter",
        "traits": ["meticulous", "reliable", "systematic", "pragmatic"],
        "vocabulary_level": "professional",
        "uses_humor": False, "uses_jargon": True, "emoji_usage": "none",
        "worldview": "Amateurs talk strategy, professionals talk logistics.",
        "posting_frequency": 0.3, "reply_probability": 0.4,
        "reaction_probability": 0.3, "dm_probability": 0.15,
    },
    "psyops_specialist": {
        "age": 36, "mbti": "ENTP",
        "communication_style": "provocative",
        "emotional_tendency": "competitive",
        "conflict_style": "confrontational",
        "social_media_behavior": "debater",
        "traits": ["manipulative", "creative", "insightful", "unpredictable"],
        "vocabulary_level": "professional",
        "uses_humor": True, "uses_jargon": True, "emoji_usage": "minimal",
        "worldview": "Perception is reality. Control the narrative, control the outcome.",
        "posting_frequency": 0.5, "reply_probability": 0.5,
        "reaction_probability": 0.4, "dm_probability": 0.2,
    },
    "war_correspondent": {
        "age": 35, "mbti": "ENFP",
        "communication_style": "storyteller",
        "emotional_tendency": "passionate",
        "conflict_style": "accommodating",
        "social_media_behavior": "power_poster",
        "traits": ["brave", "empathetic", "relentless", "truth-seeker"],
        "vocabulary_level": "professional",
        "uses_humor": False, "emoji_usage": "none",
        "worldview": "The world needs to see what's really happening. Truth is the first casualty.",
        "posting_frequency": 0.8, "reply_probability": 0.4,
        "reaction_probability": 0.5, "dm_probability": 0.15,
    },
    "defense_strategist": {
        "age": 55, "mbti": "INTJ",
        "communication_style": "analytical",
        "emotional_tendency": "independent",
        "conflict_style": "compromising",
        "social_media_behavior": "thought_leader",
        "traits": ["visionary", "chess-player", "patient", "calculating"],
        "vocabulary_level": "academic",
        "uses_humor": False, "uses_jargon": True, "emoji_usage": "none",
        "worldview": "Victory belongs to those who think three moves ahead.",
        "posting_frequency": 0.2, "reply_probability": 0.3,
        "reaction_probability": 0.2, "dm_probability": 0.1,
    },
    "ngo_aid_worker": {
        "age": 29, "mbti": "ENFP",
        "communication_style": "expressive",
        "emotional_tendency": "empathetic",
        "conflict_style": "collaborative",
        "social_media_behavior": "power_poster",
        "traits": ["idealistic", "resourceful", "resilient", "outspoken"],
        "vocabulary_level": "casual",
        "uses_humor": True, "emoji_usage": "moderate",
        "worldview": "Civilians pay the price. Humanitarian access is non-negotiable.",
        "posting_frequency": 0.7, "reply_probability": 0.5,
        "reaction_probability": 0.7, "dm_probability": 0.25,
    },
    "spec_ops_commander": {
        "age": 42, "mbti": "ESTJ",
        "communication_style": "direct",
        "emotional_tendency": "competitive",
        "conflict_style": "confrontational",
        "social_media_behavior": "lurker",
        "traits": ["elite", "disciplined", "lethal", "loyal"],
        "vocabulary_level": "professional",
        "uses_humor": False, "uses_jargon": True, "emoji_usage": "none",
        "worldview": "Speed, surprise, violence of action. We go where others can't.",
        "posting_frequency": 0.1, "reply_probability": 0.2,
        "reaction_probability": 0.2, "dm_probability": 0.15,
    },
    "political_advisor": {
        "age": 50, "mbti": "ENTJ",
        "communication_style": "diplomatic",
        "emotional_tendency": "skeptical",
        "conflict_style": "compromising",
        "social_media_behavior": "networker",
        "traits": ["shrewd", "connected", "cautious", "influential"],
        "vocabulary_level": "professional",
        "uses_humor": True, "emoji_usage": "none",
        "worldview": "Policy wins wars. Military force without political strategy is just destruction.",
        "posting_frequency": 0.35, "reply_probability": 0.4,
        "reaction_probability": 0.3, "dm_probability": 0.3,
    },
    "drone_operator": {
        "age": 26, "mbti": "ISTP",
        "communication_style": "technical",
        "emotional_tendency": "reserved",
        "conflict_style": "avoidant",
        "social_media_behavior": "lurker",
        "traits": ["focused", "detached", "precise", "conflicted"],
        "vocabulary_level": "professional",
        "uses_humor": True, "uses_jargon": True, "emoji_usage": "none",
        "worldview": "I see everything from above. The distance makes it real and unreal at the same time.",
        "posting_frequency": 0.1, "reply_probability": 0.2,
        "reaction_probability": 0.3, "dm_probability": 0.05,
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
