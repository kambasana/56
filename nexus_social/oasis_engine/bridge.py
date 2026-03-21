"""Bridge between NexusSocial scenarios/personas and OASIS agents.

Converts our rich persona definitions into OASIS SocialAgent instances,
seeds the OASIS environment, and provides the interface between our
narrative/memory systems and OASIS's action engine.

After each OASIS step, syncs new activity to SurrealDB so concurrent
users can query results in real-time.
"""

from __future__ import annotations

import logging
import os
import sqlite3
import uuid
from typing import Any

from camel.models import ModelFactory
from camel.prompts import TextPrompt
from camel.types import ModelPlatformType, ModelType

from oasis import (
    ActionType,
    AgentGraph,
    LLMAction,
    ManualAction,
    SocialAgent,
    UserInfo,
)

from nexus_social.core.models import AgentProfile, Organization
from nexus_social.core.personas import Persona
from nexus_social.storage.surrealdb import SurrealStorage

logger = logging.getLogger(__name__)


# All actions available to agents in our simulation
DEFAULT_ACTIONS = [
    ActionType.CREATE_POST,
    ActionType.CREATE_COMMENT,
    ActionType.LIKE_POST,
    ActionType.DISLIKE_POST,
    ActionType.REPOST,
    ActionType.FOLLOW,
    ActionType.DO_NOTHING,
]


def _build_agent_prompt_template() -> TextPrompt:
    """Build the prompt template that OASIS uses to instruct each agent."""
    return TextPrompt(
        "You are {name}, a {role} at {org} ({industry}), based in {location} "
        "({country}). Your team ({team}) focuses on: {focus}.\n\n"
        "BACKGROUND: {background}\n\n"
        "PERSONALITY: {personality}\n"
        "Communication style: {comm_style}. "
        "Emotional tendency: {emotional}. "
        "Under stress you: {stress_response}.\n\n"
        "WORLDVIEW: {worldview}\n\n"
        "MOTIVATIONS: {motivations}\n"
        "FEARS: {fears}\n\n"
        "VERBAL HABITS: {verbal_tics}\n\n"
        "CURRENT SITUATION: {situation}\n\n"
        "INSTRUCTIONS: Post, comment, and interact as this person would. "
        "Be authentic to the personality above. Write like a real person on "
        "an internal platform - not corporate speak. "
        "Your tone should reflect your stress level ({stress_level}/10) "
        "and morale ({morale}/10). "
        "{behavior_instruction}"
    )


def persona_to_profile(persona: Persona, agent: AgentProfile) -> dict[str, str]:
    """Convert a Persona + AgentProfile into the profile dict OASIS uses."""
    from nexus_social.core.personas import SocialMediaBehavior

    behavior_map = {
        SocialMediaBehavior.POWER_POSTER: "Post frequently with high energy. Share updates and engage actively.",
        SocialMediaBehavior.LURKER: "Rarely post. When you do, make it count. Mostly observe and react.",
        SocialMediaBehavior.COMMENTER: "Prefer commenting on others' posts over creating your own.",
        SocialMediaBehavior.SHARER: "Amplify others' content with your own perspective.",
        SocialMediaBehavior.THOUGHT_LEADER: "Write thoughtful, original content. Quality over quantity.",
        SocialMediaBehavior.REACTOR: "Quick reactions and brief encouragement. Generous with likes.",
        SocialMediaBehavior.NETWORKER: "Connect people. Make introductions. DM frequently.",
        SocialMediaBehavior.DEBATER: "Challenge ideas respectfully. Enjoy intellectual sparring.",
    }

    return {
        "name": persona.name,
        "role": agent.role.value,
        "org": agent.org.name,
        "industry": agent.org.industry,
        "team": agent.team.name,
        "focus": agent.team.focus,
        "location": agent.location.city,
        "country": agent.location.country,
        "background": persona.background or f"Experienced {agent.role.value} with expertise in {', '.join(persona.expertise[:3]) if persona.expertise else agent.team.focus}",
        "personality": ", ".join(persona.traits),
        "comm_style": persona.communication_style.value,
        "emotional": persona.emotional_tendency.value,
        "stress_response": persona.stress_response.value,
        "worldview": persona.worldview or "Focused professional.",
        "motivations": ", ".join(persona.motivations),
        "fears": ", ".join(persona.fears),
        "verbal_tics": "; ".join(persona.verbal_tics) if persona.verbal_tics else "None notable.",
        "situation": "Normal operations.",  # updated per-tick by narrative engine
        "stress_level": str(int(persona.stress_level * 10)),
        "morale": str(int(persona.morale * 10)),
        "behavior_instruction": behavior_map.get(
            persona.social_media_behavior,
            "Engage naturally on social media."
        ),
    }


class OASISBridge:
    """Bridges our scenario system with OASIS's social simulation engine.

    Handles:
    - Converting personas to OASIS agents
    - Creating and managing the OASIS environment
    - Stepping the simulation with narrative context
    - Querying the OASIS database for analysis
    """

    def __init__(self, model_platform: str = "openai",
                 model_type: str = "gpt-4o-mini",
                 platform_type: str = "twitter",
                 db_path: str = "./data/nexus_simulation.db",
                 storage: SurrealStorage | None = None):
        self.db_path = os.path.abspath(db_path)
        self.platform_type = platform_type
        self.storage = storage
        self.agent_graph: AgentGraph | None = None
        self.env = None
        self._agent_map: dict[str, int] = {}  # our agent_id -> oasis agent_id
        self._reverse_map: dict[int, str] = {}  # oasis agent_id -> our agent_id
        self._profile_map: dict[str, AgentProfile] = {}  # our agent_id -> AgentProfile
        self._persona_map: dict[str, Persona] = {}  # our agent_id -> Persona
        self._prompt_template = _build_agent_prompt_template()
        self._next_oasis_id = 0
        self._initialized = False
        self._last_synced_trace_count = 0  # track what we've already synced

        # Create the model
        platform_map = {
            "openai": ModelPlatformType.OPENAI,
        }
        type_map = {
            "gpt-4o-mini": ModelType.GPT_4O_MINI,
            "gpt-4o": ModelType.GPT_4O,
        }
        self.model = ModelFactory.create(
            model_platform=platform_map.get(model_platform, ModelPlatformType.OPENAI),
            model_type=type_map.get(model_type, ModelType.GPT_4O_MINI),
        )

    async def seed_agents(self, agents: list[AgentProfile]) -> AgentGraph:
        """Convert our AgentProfiles (with personas) into an OASIS AgentGraph.

        Also creates corresponding agent nodes in SurrealDB if storage is configured.
        """
        import oasis

        self.agent_graph = AgentGraph()

        for agent in agents:
            persona = getattr(agent, "_persona", None)
            if not persona:
                persona = Persona(name=agent.name)

            oasis_id = self._next_oasis_id
            self._next_oasis_id += 1

            # Build the profile dict for the prompt template
            profile = persona_to_profile(persona, agent)

            # Create OASIS agent
            social_agent = SocialAgent(
                agent_id=oasis_id,
                user_info=UserInfo(
                    user_name=agent.name.lower().replace(" ", "_").replace(".", ""),
                    name=agent.name,
                    description=(
                        f"{agent.role.value.title()} at {agent.org.name} "
                        f"({agent.org.industry}), {agent.location.city}. "
                        f"{persona.worldview}"
                    ),
                    profile=profile,
                    recsys_type="twitter" if self.platform_type == "twitter" else "reddit",
                ),
                user_info_template=self._prompt_template,
                agent_graph=self.agent_graph,
                model=self.model,
                available_actions=DEFAULT_ACTIONS,
            )
            self.agent_graph.add_agent(social_agent)

            # Track mappings
            self._agent_map[agent.id] = oasis_id
            self._reverse_map[oasis_id] = agent.id
            self._profile_map[agent.id] = agent
            self._persona_map[agent.id] = persona

            # Write agent to SurrealDB
            if self.storage:
                await self.storage.create_agent(agent.id, {
                    "name": agent.name,
                    "role": agent.role.value,
                    "org": agent.org.name,
                    "team": agent.team.name,
                    "location": agent.location.city,
                    "country": agent.location.country,
                    "industry": agent.org.industry,
                    "stress": persona.stress_level,
                    "morale": persona.morale,
                    "activity_level": agent.activity_level,
                    "personality": persona.traits,
                    "expertise": persona.expertise,
                    "persona": persona.to_dict() if hasattr(persona, "to_dict") else {},
                    "oasis_id": oasis_id,
                })

        logger.info(f"Seeded {len(agents)} agents into OASIS AgentGraph")
        return self.agent_graph

    async def initialize(self):
        """Create and reset the OASIS environment."""
        import oasis

        if not self.agent_graph:
            raise RuntimeError("Must call seed_agents() before initialize()")

        # Ensure data directory exists
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)

        # Clean previous DB
        if os.path.exists(self.db_path):
            os.remove(self.db_path)

        os.environ["OASIS_DB_PATH"] = self.db_path

        # Create environment
        if self.platform_type == "twitter":
            platform = oasis.DefaultPlatformType.TWITTER
        else:
            platform = oasis.DefaultPlatformType.REDDIT

        self.env = oasis.make(
            agent_graph=self.agent_graph,
            platform=platform,
            database_path=self.db_path,
        )

        await self.env.reset()
        self._initialized = True
        logger.info(f"OASIS environment initialized ({self.platform_type})")

    async def step_all_llm(self, active_agent_ids: list[str] | None = None):
        """Run one step where specified agents (or all) take LLM-decided actions.

        After the OASIS step completes, syncs new activity to SurrealDB.
        """
        if not self._initialized:
            raise RuntimeError("Must call initialize() first")

        if active_agent_ids:
            oasis_ids = [self._agent_map[aid] for aid in active_agent_ids
                         if aid in self._agent_map]
            actions = {
                agent: LLMAction()
                for _, agent in self.env.agent_graph.get_agents(oasis_ids)
            }
        else:
            actions = {
                agent: LLMAction()
                for _, agent in self.env.agent_graph.get_agents()
            }

        await self.env.step(actions)

        # Sync new OASIS activity to SurrealDB
        if self.storage:
            await self._sync_oasis_to_surreal()

    async def inject_post(self, agent_id: str, content: str):
        """Manually inject a post from a specific agent (for narrative events)."""
        if not self._initialized:
            return

        oasis_id = self._agent_map.get(agent_id)
        if oasis_id is None:
            return

        action = {
            self.env.agent_graph.get_agent(oasis_id): ManualAction(
                action_type=ActionType.CREATE_POST,
                action_args={"content": content},
            )
        }
        await self.env.step(action)

        if self.storage:
            await self._sync_oasis_to_surreal()

    async def inject_comment(self, agent_id: str, post_id: str, content: str):
        """Manually inject a comment from a specific agent."""
        if not self._initialized:
            return

        oasis_id = self._agent_map.get(agent_id)
        if oasis_id is None:
            return

        action = {
            self.env.agent_graph.get_agent(oasis_id): ManualAction(
                action_type=ActionType.CREATE_COMMENT,
                action_args={"post_id": post_id, "content": content},
            )
        }
        await self.env.step(action)

        if self.storage:
            await self._sync_oasis_to_surreal()

    async def update_agent_situation(self, agent_id: str, situation: str,
                                     stress_level: float, morale: float):
        """Update an agent's situational context (called by narrative engine)."""
        oasis_id = self._agent_map.get(agent_id)
        if oasis_id is None:
            return

        agent = self.env.agent_graph.get_agent(oasis_id)
        if agent and agent.user_info and agent.user_info.profile:
            agent.user_info.profile["situation"] = situation
            agent.user_info.profile["stress_level"] = str(int(stress_level * 10))
            agent.user_info.profile["morale"] = str(int(morale * 10))

        # Sync stress/morale to SurrealDB
        if self.storage:
            await self.storage.update_agent(agent_id, {
                "stress": stress_level,
                "morale": morale,
            })

    async def close(self):
        """Shut down the OASIS environment."""
        if self.env:
            await self.env.close()
            self._initialized = False

    @property
    def is_initialized(self) -> bool:
        return self._initialized

    def get_our_agent_id(self, oasis_id: int) -> str | None:
        """Map an OASIS agent ID back to our agent ID."""
        return self._reverse_map.get(oasis_id)

    def get_oasis_id(self, our_id: str) -> int | None:
        """Map our agent ID to an OASIS agent ID."""
        return self._agent_map.get(our_id)

    def get_profile(self, agent_id: str) -> AgentProfile | None:
        return self._profile_map.get(agent_id)

    def get_persona(self, agent_id: str) -> Persona | None:
        return self._persona_map.get(agent_id)

    # ── OASIS -> SurrealDB sync ─────────────────────────────────────

    async def _sync_oasis_to_surreal(self):
        """Read new activity from OASIS SQLite and write to SurrealDB.

        Reads the OASIS trace table for new actions since last sync,
        then creates corresponding records in SurrealDB.
        """
        if not self.storage:
            return

        try:
            conn = sqlite3.connect(self.db_path)
            conn.row_factory = sqlite3.Row

            # Get new trace entries since last sync
            traces = conn.execute(
                "SELECT * FROM trace ORDER BY rowid LIMIT -1 OFFSET ?",
                (self._last_synced_trace_count,)
            ).fetchall()

            for trace in traces:
                oasis_user_id = trace["user_id"]
                action = trace["action"]
                our_id = self.get_our_agent_id(int(oasis_user_id)) if oasis_user_id is not None else None

                if not our_id:
                    continue

                if action == "create_post":
                    # Find the post in OASIS DB
                    post = conn.execute(
                        "SELECT * FROM post WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
                        (oasis_user_id,)
                    ).fetchone()
                    if post:
                        post_id = str(post["post_id"])
                        await self.storage.create_post(
                            post_id=f"oasis_{post_id}",
                            author_id=our_id,
                            content=post["content"] or "",
                        )

                elif action == "create_comment":
                    comment = conn.execute(
                        "SELECT * FROM comment WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
                        (oasis_user_id,)
                    ).fetchone()
                    if comment:
                        comment_id = str(comment["comment_id"])
                        post_id = str(comment["post_id"])
                        await self.storage.create_comment(
                            comment_id=f"oasis_{comment_id}",
                            author_id=our_id,
                            post_id=f"oasis_{post_id}",
                            content=comment["content"] or "",
                        )

                elif action == "like_post":
                    info = trace["info"] or ""
                    # OASIS stores post_id in the info field
                    if info:
                        await self.storage.like_post(our_id, f"oasis_{info}")

                elif action == "dislike_post":
                    info = trace["info"] or ""
                    if info:
                        await self.storage.dislike_post(our_id, f"oasis_{info}")

                elif action == "follow":
                    info = trace["info"] or ""
                    if info:
                        target_our_id = self.get_our_agent_id(int(info))
                        if target_our_id:
                            await self.storage.follow(our_id, target_our_id)

                elif action == "repost":
                    info = trace["info"] or ""
                    if info:
                        await self.storage.repost(our_id, f"oasis_{info}")

            self._last_synced_trace_count += len(traces)
            conn.close()

            if traces:
                logger.debug(f"Synced {len(traces)} OASIS actions to SurrealDB")

        except Exception as e:
            logger.error(f"Error syncing OASIS to SurrealDB: {e}")
