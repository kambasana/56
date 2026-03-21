"""Scenario builder and pre-made scenario library.

Scenarios define the complete setup: orgs, teams, locations, agents with
personas, and simulation parameters. Users can pick pre-made ones or
build custom scenarios through the UI.
"""

from __future__ import annotations

import json
import random
from dataclasses import dataclass, field
from typing import Any

from nexus_social.core.models import (
    AgentProfile,
    AgentRole,
    Location,
    LocationType,
    Organization,
    Team,
)
from nexus_social.core.personas import (
    PERSONA_TEMPLATES,
    CommunicationStyle,
    Persona,
    SocialMediaBehavior,
    create_persona_from_template,
)


@dataclass
class ScenarioConfig:
    """Complete scenario definition - everything needed to run a simulation."""

    name: str
    description: str
    category: str  # e.g. "corporate", "startup", "crisis", "competition"
    organizations: list[dict] = field(default_factory=list)
    simulation_params: dict = field(default_factory=lambda: {
        "tick_hours": 1.0,
        "document_frequency": 0.15,
        "enable_cross_org": True,
        "enable_dms": True,
    })
    tags: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "description": self.description,
            "category": self.category,
            "organizations": self.organizations,
            "simulation_params": self.simulation_params,
            "tags": self.tags,
        }

    @classmethod
    def from_dict(cls, d: dict) -> ScenarioConfig:
        return cls(
            name=d["name"],
            description=d.get("description", ""),
            category=d.get("category", "custom"),
            organizations=d.get("organizations", []),
            simulation_params=d.get("simulation_params", {}),
            tags=d.get("tags", []),
        )

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), indent=2)

    @classmethod
    def from_json(cls, s: str) -> ScenarioConfig:
        return cls.from_dict(json.loads(s))


class ScenarioBuilder:
    """Builds simulation worlds from ScenarioConfig definitions.

    Supports:
    - Pre-made scenario templates
    - Custom scenario building via the UI or API
    - Import/export of scenario configs as JSON
    """

    def build(self, config: ScenarioConfig) -> tuple[list[Organization], list[AgentProfile]]:
        """Build a complete world from a scenario config."""
        orgs = []
        all_agents = []

        for org_cfg in config.organizations:
            org, agents = self._build_org(org_cfg)
            orgs.append(org)
            all_agents.extend(agents)

        return orgs, all_agents

    def _build_org(self, cfg: dict) -> tuple[Organization, list[AgentProfile]]:
        locations = []
        for loc_cfg in cfg.get("locations", []):
            locations.append(Location(
                name=loc_cfg.get("name", f"{cfg['name']} Office"),
                city=loc_cfg["city"],
                country=loc_cfg["country"],
                timezone=loc_cfg.get("timezone", "UTC"),
                location_type=LocationType(loc_cfg.get("type", "branch")),
            ))

        org = Organization(
            name=cfg["name"],
            industry=cfg.get("industry", "Technology"),
            description=cfg.get("description", ""),
            locations=locations,
        )

        agents = []
        teams = []
        for team_cfg in cfg.get("teams", []):
            loc_idx = team_cfg.get("location_index", 0)
            location = locations[loc_idx] if loc_idx < len(locations) else locations[0]

            team = Team(
                name=team_cfg["name"],
                org=org,
                location=location,
                focus=team_cfg.get("focus", "general"),
            )
            teams.append(team)

            for agent_cfg in team_cfg.get("agents", []):
                agent, persona = self._build_agent(agent_cfg, team)
                team.members.append(agent)
                agents.append(agent)

        org.teams = teams
        return org, agents

    def _build_agent(self, cfg: dict, team: Team) -> tuple[AgentProfile, Persona]:
        # Build persona - from template or custom
        template = cfg.get("persona_template")
        if template:
            persona = create_persona_from_template(
                template, cfg["name"],
                **{k: v for k, v in cfg.items()
                   if k not in ("name", "role", "persona_template")}
            )
        else:
            persona = Persona.from_dict({
                "name": cfg["name"],
                **{k: v for k, v in cfg.items() if k != "name" and k != "role"},
            })

        role = AgentRole(cfg.get("role", "engineer"))

        agent = AgentProfile(
            name=cfg["name"],
            role=role,
            team=team,
            personality_traits=persona.traits,
            expertise=persona.expertise,
            communication_style=persona.communication_style.value,
            activity_level=persona.posting_frequency,
        )

        # Attach persona for rich prompts
        agent._persona = persona  # type: ignore[attr-defined]

        return agent, persona

    def get_agent_system_prompt(self, agent: AgentProfile) -> str:
        """Get the rich system prompt for an agent, using persona if available."""
        persona = getattr(agent, "_persona", None)
        if persona:
            return persona.to_system_prompt(
                role=agent.role.value,
                team=agent.team.name,
                org=agent.org.name,
                location=agent.location.city,
                team_focus=agent.team.focus,
            )
        return agent.system_prompt()


# =============================================================================
# Pre-Made Scenario Library
# =============================================================================

SCENARIOS: dict[str, ScenarioConfig] = {}


def _register(config: ScenarioConfig):
    SCENARIOS[config.name] = config


# --- Scenario 1: Tech Rivalry ---
_register(ScenarioConfig(
    name="Tech Rivalry",
    description="Two competing tech companies and a consulting firm. Watch how employees interact across org lines, share intel, and compete for talent.",
    category="competition",
    tags=["tech", "competition", "multi-org", "enterprise"],
    organizations=[
        {
            "name": "Quantum Labs",
            "industry": "AI/ML Platform",
            "description": "Fast-growing AI startup disrupting the enterprise market",
            "locations": [
                {"name": "QL HQ", "city": "San Francisco", "country": "USA", "timezone": "US/Pacific", "type": "headquarters"},
                {"name": "QL London", "city": "London", "country": "UK", "timezone": "Europe/London", "type": "branch"},
            ],
            "teams": [
                {
                    "name": "Core ML", "location_index": 0, "focus": "foundation models and training infrastructure",
                    "agents": [
                        {"name": "Alex Reeves", "role": "manager", "persona_template": "visionary_ceo",
                         "expertise": ["ML systems", "distributed computing"], "age": 36},
                        {"name": "Priya Nair", "role": "engineer", "persona_template": "quiet_engineer",
                         "expertise": ["PyTorch", "CUDA optimization"]},
                        {"name": "Jake Torres", "role": "engineer", "persona_template": "ambitious_newcomer",
                         "expertise": ["data pipelines", "MLOps"]},
                    ],
                },
                {
                    "name": "Product", "location_index": 0, "focus": "developer experience and API design",
                    "agents": [
                        {"name": "Maya Goldstein", "role": "manager", "persona_template": "empathetic_manager",
                         "expertise": ["product strategy", "developer tools"]},
                        {"name": "Leo Park", "role": "designer", "persona_template": "creative_rebel",
                         "expertise": ["UX design", "design systems"]},
                    ],
                },
                {
                    "name": "Go-to-Market", "location_index": 1, "focus": "enterprise sales in EMEA",
                    "agents": [
                        {"name": "Sophie Laurent", "role": "sales", "persona_template": "connector",
                         "expertise": ["enterprise sales", "EMEA markets"]},
                        {"name": "Ravi Mehta", "role": "marketing", "persona_template": "social_butterfly",
                         "expertise": ["content marketing", "community building"]},
                    ],
                },
            ],
        },
        {
            "name": "Nexus AI",
            "industry": "AI/ML Platform",
            "description": "Established AI company defending market position",
            "locations": [
                {"name": "NAI HQ", "city": "New York", "country": "USA", "timezone": "US/Eastern", "type": "headquarters"},
                {"name": "NAI Berlin", "city": "Berlin", "country": "Germany", "timezone": "Europe/Berlin", "type": "branch"},
            ],
            "teams": [
                {
                    "name": "Research", "location_index": 0, "focus": "advanced model architectures and safety",
                    "agents": [
                        {"name": "Dr. Helen Zhao", "role": "researcher", "persona_template": "research_purist",
                         "expertise": ["transformer architectures", "alignment"]},
                        {"name": "Marcus Webb", "role": "engineer", "persona_template": "data_skeptic",
                         "expertise": ["benchmarking", "evaluation systems"]},
                    ],
                },
                {
                    "name": "Platform", "location_index": 0, "focus": "enterprise deployment and scalability",
                    "agents": [
                        {"name": "Diana Cruz", "role": "manager", "persona_template": "process_guardian",
                         "expertise": ["platform engineering", "SRE"]},
                        {"name": "Sam Fischer", "role": "engineer", "persona_template": "quiet_engineer",
                         "expertise": ["Kubernetes", "infrastructure as code"]},
                        {"name": "Amir Hassan", "role": "engineer", "persona_template": "ambitious_newcomer",
                         "expertise": ["cloud architecture", "cost optimization"]},
                    ],
                },
                {
                    "name": "Sales EMEA", "location_index": 1, "focus": "European enterprise accounts",
                    "agents": [
                        {"name": "Lena Richter", "role": "sales", "persona_template": "connector",
                         "expertise": ["enterprise sales", "German market"]},
                    ],
                },
            ],
        },
        {
            "name": "Apex Consulting",
            "industry": "Technology Consulting",
            "description": "Neutral consulting firm that works with both AI companies",
            "locations": [
                {"name": "Apex HQ", "city": "Chicago", "country": "USA", "timezone": "US/Central", "type": "headquarters"},
            ],
            "teams": [
                {
                    "name": "AI Advisory", "location_index": 0, "focus": "advising enterprises on AI strategy",
                    "agents": [
                        {"name": "Jordan Blake", "role": "analyst", "persona_template": "data_skeptic",
                         "expertise": ["AI strategy", "market analysis"]},
                        {"name": "Tina Okafor", "role": "manager", "persona_template": "empathetic_manager",
                         "expertise": ["change management", "stakeholder alignment"]},
                    ],
                },
            ],
        },
    ],
))

# --- Scenario 2: Startup vs. Corporation ---
_register(ScenarioConfig(
    name="David vs. Goliath",
    description="A scrappy 5-person startup disrupting a 50-year-old corporation. See how culture, speed, and communication styles clash.",
    category="competition",
    tags=["startup", "corporate", "culture-clash", "disruption"],
    organizations=[
        {
            "name": "FlashPay",
            "industry": "Fintech",
            "description": "Move-fast fintech startup, 2 years old",
            "locations": [
                {"name": "FlashPay Garage", "city": "Austin", "country": "USA", "timezone": "US/Central", "type": "headquarters"},
            ],
            "teams": [
                {
                    "name": "The Whole Company", "location_index": 0, "focus": "instant payments and crypto integration",
                    "agents": [
                        {"name": "Zoe Chang", "role": "executive", "persona_template": "visionary_ceo",
                         "expertise": ["fintech", "fundraising", "product vision"],
                         "background": "Former Stripe engineer, dropped out of MBA to start FlashPay"},
                        {"name": "Kai Okonkwo", "role": "engineer", "persona_template": "creative_rebel",
                         "expertise": ["full-stack", "blockchain", "rapid prototyping"]},
                        {"name": "Mia Santos", "role": "engineer", "persona_template": "quiet_engineer",
                         "expertise": ["security", "cryptography", "systems"]},
                        {"name": "Tyler Reed", "role": "marketing", "persona_template": "social_butterfly",
                         "expertise": ["growth hacking", "social media", "memes"]},
                        {"name": "Nisha Patel", "role": "designer", "persona_template": "creative_rebel",
                         "expertise": ["mobile UX", "user research"]},
                    ],
                },
            ],
        },
        {
            "name": "GlobalBank Corp",
            "industry": "Banking",
            "description": "150-year-old traditional bank trying to modernize",
            "locations": [
                {"name": "GBC Tower", "city": "New York", "country": "USA", "timezone": "US/Eastern", "type": "headquarters"},
                {"name": "GBC London", "city": "London", "country": "UK", "timezone": "Europe/London", "type": "branch"},
                {"name": "GBC Singapore", "city": "Singapore", "country": "Singapore", "timezone": "Asia/Singapore", "type": "branch"},
            ],
            "teams": [
                {
                    "name": "Digital Innovation", "location_index": 0, "focus": "digital banking transformation",
                    "agents": [
                        {"name": "Robert Chen", "role": "executive", "persona_template": "process_guardian",
                         "expertise": ["banking regulation", "digital transformation"],
                         "background": "30 years in banking, skeptical of crypto but knows change is needed"},
                        {"name": "Amanda Foster", "role": "manager", "persona_template": "empathetic_manager",
                         "expertise": ["project management", "agile transformation"]},
                        {"name": "Dev Krishnamurthy", "role": "engineer", "persona_template": "quiet_engineer",
                         "expertise": ["COBOL modernization", "cloud migration"]},
                    ],
                },
                {
                    "name": "Compliance", "location_index": 1, "focus": "regulatory compliance and risk",
                    "agents": [
                        {"name": "Victoria Shaw", "role": "analyst", "persona_template": "data_skeptic",
                         "expertise": ["regulatory compliance", "risk assessment"]},
                        {"name": "James Whitmore", "role": "manager", "persona_template": "process_guardian",
                         "expertise": ["SOX compliance", "audit"]},
                    ],
                },
                {
                    "name": "APAC Operations", "location_index": 2, "focus": "Asia-Pacific market expansion",
                    "agents": [
                        {"name": "Grace Tan", "role": "manager", "persona_template": "connector",
                         "expertise": ["APAC banking", "partnerships"]},
                        {"name": "Hiroshi Yamada", "role": "analyst", "persona_template": "research_purist",
                         "expertise": ["market research", "competitive intelligence"]},
                    ],
                },
            ],
        },
    ],
))

# --- Scenario 3: Remote-First Crisis ---
_register(ScenarioConfig(
    name="Crisis Response",
    description="A product security breach unfolds across a globally distributed company. Watch how remote teams coordinate, blame shifts, and leaders emerge.",
    category="crisis",
    tags=["crisis", "remote", "security", "incident-response"],
    organizations=[
        {
            "name": "CloudVault",
            "industry": "Cloud Security",
            "description": "Cloud security company dealing with a major incident",
            "locations": [
                {"name": "CV Seattle", "city": "Seattle", "country": "USA", "timezone": "US/Pacific", "type": "headquarters"},
                {"name": "CV Tel Aviv", "city": "Tel Aviv", "country": "Israel", "timezone": "Asia/Jerusalem", "type": "branch"},
                {"name": "CV Remote", "city": "Distributed", "country": "Global", "timezone": "UTC", "type": "remote"},
            ],
            "teams": [
                {
                    "name": "Security Response", "location_index": 1, "focus": "incident response and threat analysis",
                    "agents": [
                        {"name": "Noam Levine", "role": "manager", "persona_template": "visionary_ceo",
                         "expertise": ["cybersecurity", "incident command"],
                         "background": "Former IDF cyber unit, calm under pressure"},
                        {"name": "Yael Cohen", "role": "engineer", "persona_template": "quiet_engineer",
                         "expertise": ["forensics", "malware analysis"]},
                    ],
                },
                {
                    "name": "Engineering", "location_index": 0, "focus": "platform reliability and patching",
                    "agents": [
                        {"name": "Chris Malone", "role": "manager", "persona_template": "empathetic_manager",
                         "expertise": ["SRE", "incident management"]},
                        {"name": "Deepa Rajan", "role": "engineer", "persona_template": "data_skeptic",
                         "expertise": ["infrastructure", "monitoring"]},
                        {"name": "Ryan Foster", "role": "engineer", "persona_template": "ambitious_newcomer",
                         "expertise": ["backend", "API security"]},
                    ],
                },
                {
                    "name": "Communications", "location_index": 2, "focus": "customer communication and PR",
                    "agents": [
                        {"name": "Lila Washington", "role": "marketing", "persona_template": "connector",
                         "expertise": ["crisis communications", "PR"]},
                        {"name": "Oliver Grant", "role": "executive", "persona_template": "process_guardian",
                         "expertise": ["legal", "regulatory response"]},
                    ],
                },
            ],
        },
    ],
))

# --- Scenario 4: Cross-Industry Collaboration ---
_register(ScenarioConfig(
    name="Innovation Alliance",
    description="Three companies from different industries form a joint innovation lab. Watch silos break down (or not) as healthcare, tech, and academia collide.",
    category="collaboration",
    tags=["cross-industry", "innovation", "healthcare", "academia"],
    organizations=[
        {
            "name": "MedCore",
            "industry": "Healthcare",
            "description": "Mid-size healthcare tech company",
            "locations": [
                {"name": "MedCore HQ", "city": "Boston", "country": "USA", "timezone": "US/Eastern", "type": "headquarters"},
            ],
            "teams": [
                {
                    "name": "Clinical AI", "location_index": 0, "focus": "AI-assisted diagnostics",
                    "agents": [
                        {"name": "Dr. Sarah Kim", "role": "researcher", "persona_template": "research_purist",
                         "expertise": ["radiology AI", "clinical validation"]},
                        {"name": "Ben Okafor", "role": "engineer", "persona_template": "quiet_engineer",
                         "expertise": ["medical imaging", "DICOM"]},
                        {"name": "Lisa Park", "role": "manager", "persona_template": "empathetic_manager",
                         "expertise": ["healthcare compliance", "HIPAA"]},
                    ],
                },
            ],
        },
        {
            "name": "NeuroTech",
            "industry": "Technology",
            "description": "AI infrastructure company providing compute",
            "locations": [
                {"name": "NT Bay Area", "city": "Palo Alto", "country": "USA", "timezone": "US/Pacific", "type": "headquarters"},
            ],
            "teams": [
                {
                    "name": "Applied AI", "location_index": 0, "focus": "model deployment and optimization",
                    "agents": [
                        {"name": "Kevin Zhang", "role": "engineer", "persona_template": "ambitious_newcomer",
                         "expertise": ["GPU clusters", "model serving"]},
                        {"name": "Rachel Green", "role": "manager", "persona_template": "connector",
                         "expertise": ["partnerships", "business development"]},
                    ],
                },
            ],
        },
        {
            "name": "Harwell University",
            "industry": "Academia",
            "description": "Research university bringing theoretical expertise",
            "locations": [
                {"name": "Harwell Campus", "city": "Cambridge", "country": "UK", "timezone": "Europe/London", "type": "headquarters"},
            ],
            "teams": [
                {
                    "name": "AI Ethics Lab", "location_index": 0, "focus": "responsible AI and fairness in healthcare",
                    "agents": [
                        {"name": "Prof. Eleanor Voss", "role": "researcher", "persona_template": "research_purist",
                         "expertise": ["AI ethics", "fairness", "bias detection"],
                         "background": "Published 200+ papers, concerned about AI hype"},
                        {"name": "Marco Silva", "role": "researcher", "persona_template": "creative_rebel",
                         "expertise": ["interpretability", "adversarial ML"],
                         "background": "PhD student, challenges established wisdom"},
                    ],
                },
            ],
        },
    ],
))

# --- Scenario 5: Merger Chaos ---
_register(ScenarioConfig(
    name="Merger Mayhem",
    description="Two companies are merging. Duplicate teams, conflicting cultures, and power struggles play out on the internal social platform.",
    category="corporate",
    tags=["merger", "culture", "politics", "restructuring"],
    organizations=[
        {
            "name": "Pinnacle Software",
            "industry": "Enterprise Software",
            "description": "Process-heavy, traditional enterprise software company (acquirer)",
            "locations": [
                {"name": "Pinnacle Tower", "city": "Dallas", "country": "USA", "timezone": "US/Central", "type": "headquarters"},
            ],
            "teams": [
                {
                    "name": "Engineering", "location_index": 0, "focus": "legacy ERP platform maintenance",
                    "agents": [
                        {"name": "Bob Harrison", "role": "manager", "persona_template": "process_guardian",
                         "expertise": ["Java", "enterprise architecture", "waterfall"],
                         "background": "20 years at Pinnacle, resistant to change"},
                        {"name": "Karen Mitchell", "role": "engineer", "persona_template": "data_skeptic",
                         "expertise": ["Oracle DB", "performance tuning"]},
                        {"name": "Tom Bradley", "role": "engineer", "persona_template": "quiet_engineer",
                         "expertise": ["Java", "Spring Boot"]},
                    ],
                },
                {
                    "name": "HR & Integration", "location_index": 0, "focus": "merger integration and culture",
                    "agents": [
                        {"name": "Patricia Gomez", "role": "hr", "persona_template": "empathetic_manager",
                         "expertise": ["change management", "org design"]},
                    ],
                },
            ],
        },
        {
            "name": "Agilify",
            "industry": "Enterprise Software",
            "description": "Modern, agile SaaS startup being acquired",
            "locations": [
                {"name": "Agilify Loft", "city": "Portland", "country": "USA", "timezone": "US/Pacific", "type": "headquarters"},
            ],
            "teams": [
                {
                    "name": "Engineering", "location_index": 0, "focus": "modern cloud-native platform",
                    "agents": [
                        {"name": "Sky Nakamura", "role": "manager", "persona_template": "creative_rebel",
                         "expertise": ["microservices", "DevOps", "agile"],
                         "background": "Co-founder of Agilify, worried about culture post-merger"},
                        {"name": "Ash Patel", "role": "engineer", "persona_template": "ambitious_newcomer",
                         "expertise": ["Go", "Kubernetes", "CI/CD"]},
                        {"name": "Rio Santos", "role": "designer", "persona_template": "social_butterfly",
                         "expertise": ["product design", "user research"]},
                    ],
                },
            ],
        },
    ],
))


def list_scenarios() -> list[dict]:
    """Return metadata for all available pre-made scenarios."""
    return [
        {
            "name": s.name,
            "description": s.description,
            "category": s.category,
            "tags": s.tags,
            "org_count": len(s.organizations),
            "agent_count": sum(
                len(a) for o in s.organizations
                for t in o.get("teams", [])
                for a in [t.get("agents", [])]
            ),
        }
        for s in SCENARIOS.values()
    ]


def list_persona_templates() -> list[dict]:
    """Return metadata for all available persona templates."""
    return [
        {
            "name": name,
            "mbti": t.get("mbti", ""),
            "communication_style": t.get("communication_style", ""),
            "emotional_tendency": t.get("emotional_tendency", ""),
            "social_media_behavior": t.get("social_media_behavior", ""),
            "traits": t.get("traits", []),
            "worldview": t.get("worldview", ""),
        }
        for name, t in PERSONA_TEMPLATES.items()
    ]
