"""CAMEL AI integration - the brain powering agent interactions."""

from __future__ import annotations

import logging
import os
import random
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from nexus_social.core.models import AgentProfile, Document, SocialPost

logger = logging.getLogger(__name__)

# Try to import CAMEL AI, fall back to built-in simulation
try:
    from camel.agents import ChatAgent
    from camel.messages import BaseMessage
    from camel.models import ModelFactory
    from camel.types import ModelPlatformType, ModelType

    CAMEL_AVAILABLE = True
except ImportError:
    CAMEL_AVAILABLE = False
    logger.info("CAMEL AI not installed. Using built-in simulation engine.")


class CamelBrain:
    """Wraps CAMEL AI to power agent decision-making and content generation."""

    def __init__(self, use_camel: bool | None = None):
        if use_camel is None:
            use_camel = CAMEL_AVAILABLE and bool(os.environ.get("OPENAI_API_KEY"))
        self.use_camel = use_camel and CAMEL_AVAILABLE
        self._agents: dict[str, ChatAgent] = {}

        if self.use_camel:
            logger.info("CAMEL AI engine active - using LLM-powered agents")
            self.model = ModelFactory.create(
                model_platform=ModelPlatformType.OPENAI,
                model_type=ModelType.GPT_4O_MINI,
                model_config_dict={"temperature": 0.8, "max_tokens": 300},
            )
        else:
            logger.info("Built-in simulation engine active")
            self.model = None

    def _get_or_create_agent(self, profile: AgentProfile) -> ChatAgent | None:
        if not self.use_camel:
            return None
        if profile.id not in self._agents:
            # Use rich persona prompt if available, else basic prompt
            persona = getattr(profile, "_persona", None)
            if persona:
                prompt_content = persona.to_system_prompt(
                    role=profile.role.value,
                    team=profile.team.name,
                    org=profile.org.name,
                    location=profile.location.city,
                    team_focus=profile.team.focus,
                )
            else:
                prompt_content = profile.system_prompt()

            sys_msg = BaseMessage.make_assistant_message(
                role_name=profile.name,
                content=prompt_content,
            )
            self._agents[profile.id] = ChatAgent(
                system_message=sys_msg,
                model=self.model,
            )
        return self._agents[profile.id]

    def generate_post(self, profile: AgentProfile, context: str = "") -> str:
        """Generate a social media post for an agent."""
        if self.use_camel:
            agent = self._get_or_create_agent(profile)
            prompt = (
                f"Write a short social media post (1-3 sentences) for the internal "
                f"company platform. {context} "
                f"Be authentic to your role and personality. No hashtags unless natural."
            )
            user_msg = BaseMessage.make_user_message(
                role_name="Platform", content=prompt
            )
            response = agent.step(user_msg)
            return response.msgs[0].content
        return self._simulate_post(profile, context)

    def generate_comment(
        self, profile: AgentProfile, post: SocialPost, context: str = ""
    ) -> str:
        """Generate a comment on a post."""
        if self.use_camel:
            agent = self._get_or_create_agent(profile)
            prompt = (
                f"Reply to this post by {post.author.name} ({post.author.role.value}): "
                f'"{post.content}" '
                f"Write a brief, natural reply (1-2 sentences). {context}"
            )
            user_msg = BaseMessage.make_user_message(
                role_name="Platform", content=prompt
            )
            response = agent.step(user_msg)
            return response.msgs[0].content
        return self._simulate_comment(profile, post)

    def generate_document_reaction(
        self, profile: AgentProfile, document: Document
    ) -> str:
        """Generate a reaction/post about a shared document."""
        if self.use_camel:
            agent = self._get_or_create_agent(profile)
            prompt = (
                f'A document was shared: "{document.title}" by {document.author.name}. '
                f"Type: {document.doc_type}. Preview: {document.content[:200]}. "
                f"Write a brief social post reacting to this document (1-2 sentences)."
            )
            user_msg = BaseMessage.make_user_message(
                role_name="Platform", content=prompt
            )
            response = agent.step(user_msg)
            return response.msgs[0].content
        return self._simulate_doc_reaction(profile, document)

    def generate_dm(
        self, sender: AgentProfile, recipient: AgentProfile, context: str = ""
    ) -> str:
        """Generate a direct message between agents."""
        if self.use_camel:
            agent = self._get_or_create_agent(sender)
            prompt = (
                f"Write a brief direct message to {recipient.name} "
                f"({recipient.role.value} on {recipient.team.name}). {context} "
                f"Keep it professional but friendly (1-2 sentences)."
            )
            user_msg = BaseMessage.make_user_message(
                role_name="Platform", content=prompt
            )
            response = agent.step(user_msg)
            return response.msgs[0].content
        return self._simulate_dm(sender, recipient, context)

    def decide_reaction(self, profile: AgentProfile, post: SocialPost) -> str | None:
        """Decide whether and how to react to a post. Returns emoji or None."""
        # Even with CAMEL, we use simple heuristics for reactions
        same_team = profile.team.id == post.author.team.id
        same_org = profile.org.id == post.author.org.id
        react_chance = 0.15
        if same_team:
            react_chance = 0.6
        elif same_org:
            react_chance = 0.35

        if random.random() > react_chance:
            return None

        emojis = ["thumbsup", "heart", "fire", "clap", "thinking", "rocket", "100"]
        weights = [30, 15, 10, 20, 10, 10, 5]
        return random.choices(emojis, weights=weights, k=1)[0]

    # --- Built-in simulation fallbacks ---

    def _simulate_post(self, profile: AgentProfile, context: str) -> str:
        templates = {
            "executive": [
                "Excited about the direction {team} is heading. Great progress on {focus} this quarter.",
                "Leadership sync today reinforced our commitment to {focus}. Proud of what {org} is building.",
                "Cross-org collaboration between {location} and other offices is really paying off.",
            ],
            "manager": [
                "Team standup highlight: {team} shipped a key milestone on {focus}. Well done everyone!",
                "Looking for feedback on our {focus} approach. DMs open for brainstorming.",
                "Great sprint review with {team}. The momentum is real.",
            ],
            "engineer": [
                "Just wrapped up a deep dive into {focus}. Found some interesting optimization paths.",
                "Anyone else at {location} interested in a {focus} knowledge share session?",
                "Code review day. {focus} codebase is looking clean. Ship it!",
                "Debugging {focus} issues. Coffee count: 3 and rising.",
            ],
            "designer": [
                "New design iterations for {focus} are up for review. Feedback welcome!",
                "User research insights from {location} market are fascinating.",
                "Design system update: new components aligned with {focus} goals.",
            ],
            "analyst": [
                "Data shows interesting trends in {focus}. Writing up findings for the team.",
                "Q4 metrics for {team} are looking strong. Details in the report.",
                "Cross-referencing {org} data with market trends. Some surprises.",
            ],
            "marketing": [
                "Campaign performance for {focus} exceeded targets by 15%. Thread below.",
                "Brand sentiment in {location} market trending positive. Great work {team}!",
                "Content calendar for next month is locked. Exciting {focus} launches ahead.",
            ],
            "sales": [
                "Closed a key deal today. {focus} resonating with enterprise clients.",
                "Pipeline looking healthy for {team}. {location} territory showing strong demand.",
                "Customer feedback on {focus}: they love it. Sharing detailed notes soon.",
            ],
            "hr": [
                "Welcome to our newest {team} members! Onboarding starts next week in {location}.",
                "Culture survey results are in. {org} scores high on collaboration.",
                "Reminder: team building event this Friday at {location} office!",
            ],
            "researcher": [
                "Published internal findings on {focus}. Link in comments.",
                "Interesting paper on {focus} methodology. Hosting a journal club Thursday.",
                "Research collaboration between {location} and HQ yielding great results.",
            ],
            "intern": [
                "Week 3 at {org} and already learning so much about {focus}!",
                "Shadowed the {team} today. The work on {focus} is really impressive.",
                "Any tips for navigating the {location} office? Still getting lost!",
            ],
        }

        role_templates = templates.get(profile.role.value, templates["engineer"])
        template = random.choice(role_templates)

        return template.format(
            team=profile.team.name,
            org=profile.org.name,
            focus=profile.team.focus,
            location=profile.location.city,
        )

    def _simulate_comment(self, profile: AgentProfile, post: SocialPost) -> str:
        same_org = profile.org.id == post.author.org.id
        if same_org:
            replies = [
                "Great update! Looking forward to seeing more progress.",
                f"Thanks for sharing, {post.author.name}. How can {profile.team.name} help?",
                "This aligns well with what we're seeing on our end.",
                "Solid work! Let's sync on this next week.",
                f"Love the energy from {post.author.team.name}!",
                "Interesting perspective. Would love to discuss further.",
            ]
        else:
            replies = [
                f"Great to see what {post.author.org.name} is up to!",
                "Cross-org collaboration at its finest. Let's connect!",
                f"We're doing similar work at {profile.org.name}. Should compare notes.",
                "Impressive progress. Happy to share our learnings too.",
                f"The {post.author.location.city} team is crushing it!",
            ]
        return random.choice(replies)

    def _simulate_doc_reaction(self, profile: AgentProfile, document: Document) -> str:
        reactions = [
            f'Just read "{document.title}" by {document.author.name}. '
            f"Really insightful {document.doc_type}.",
            f'"{document.title}" is a must-read for anyone working on '
            f"{', '.join(document.tags[:2]) if document.tags else 'this space'}.",
            f"Great {document.doc_type} from {document.author.team.name}. "
            f"Key takeaway: solid research backing the recommendations.",
            f"Sharing this with my team. "
            f'"{document.title}" has some actionable insights for us.',
        ]
        return random.choice(reactions)

    def _simulate_dm(
        self, sender: AgentProfile, recipient: AgentProfile, context: str
    ) -> str:
        messages = [
            f"Hey {recipient.name}, wanted to follow up on the {sender.team.focus} discussion.",
            f"Hi {recipient.name}! Do you have time for a quick sync this week?",
            f"{recipient.name} - saw your recent post. Really interesting work "
            f"on {recipient.team.focus}.",
            f"Hey! {sender.team.name} could use your expertise. Got a few minutes?",
            f"Quick question about {recipient.team.focus} - mind if I pick your brain?",
        ]
        return random.choice(messages)
