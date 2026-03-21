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


# --- Scenario 1: Coalition Joint Operations ---
_register(ScenarioConfig(
    name="Coalition Strike",
    description="A multinational military coalition coordinates a joint operation against a shared threat. Watch command hierarchies clash, intelligence sharing break down, and field operators improvise.",
    category="military",
    tags=["military", "coalition", "joint-ops", "multi-org"],
    organizations=[
        {
            "name": "Task Force Vanguard",
            "industry": "Military - Ground Forces",
            "description": "US-led ground task force spearheading the coalition operation",
            "locations": [
                {"name": "Camp Liberty", "city": "Kuwait City", "country": "Kuwait", "timezone": "Asia/Kuwait", "type": "headquarters"},
                {"name": "FOB Sentinel", "city": "Erbil", "country": "Iraq", "timezone": "Asia/Baghdad", "type": "branch"},
            ],
            "teams": [
                {
                    "name": "Command Element", "location_index": 0, "focus": "operational planning and force coordination",
                    "agents": [
                        {"name": "Col. James Hawkins", "role": "commander", "persona_template": "commanding_officer",
                         "expertise": ["combined arms", "coalition warfare"],
                         "background": "Three combat deployments, known for aggressive but calculated operations"},
                        {"name": "Maj. Elena Vasquez", "role": "analyst", "persona_template": "intelligence_analyst",
                         "expertise": ["threat assessment", "SIGINT fusion"]},
                        {"name": "Capt. Derek Osei", "role": "operator", "persona_template": "field_operator",
                         "expertise": ["special reconnaissance", "direct action"]},
                    ],
                },
                {
                    "name": "Cyber Operations", "location_index": 0, "focus": "offensive and defensive cyber warfare",
                    "agents": [
                        {"name": "Lt. Yuki Tanaka", "role": "engineer", "persona_template": "cyber_warfare_specialist",
                         "expertise": ["network exploitation", "zero-day research"]},
                        {"name": "Sgt. Marcus Hall", "role": "operator", "persona_template": "drone_operator",
                         "expertise": ["ISR platforms", "target acquisition"]},
                    ],
                },
                {
                    "name": "Forward Element", "location_index": 1, "focus": "forward reconnaissance and target development",
                    "agents": [
                        {"name": "MSgt. Rourke Flynn", "role": "operator", "persona_template": "spec_ops_commander",
                         "expertise": ["unconventional warfare", "indigenous force training"]},
                        {"name": "Sgt. Amira Khoury", "role": "medic", "persona_template": "combat_medic",
                         "expertise": ["trauma surgery", "CASEVAC coordination"]},
                    ],
                },
            ],
        },
        {
            "name": "Allied Intelligence Bureau",
            "industry": "Intelligence",
            "description": "UK-led multinational intelligence fusion center",
            "locations": [
                {"name": "Station Crossroads", "city": "Nicosia", "country": "Cyprus", "timezone": "Asia/Nicosia", "type": "headquarters"},
                {"name": "Station Northgate", "city": "London", "country": "UK", "timezone": "Europe/London", "type": "branch"},
            ],
            "teams": [
                {
                    "name": "Analysis Cell", "location_index": 0, "focus": "all-source intelligence analysis and threat assessment",
                    "agents": [
                        {"name": "Dr. Fiona Blackwood", "role": "analyst", "persona_template": "intelligence_analyst",
                         "expertise": ["geopolitical analysis", "HUMINT evaluation"],
                         "background": "Former MI6 analyst, methodical and distrustful of raw signals intelligence"},
                        {"name": "Lt. Col. Pierre Moreau", "role": "strategist", "persona_template": "defense_strategist",
                         "expertise": ["strategic planning", "NATO doctrine"]},
                    ],
                },
                {
                    "name": "PSYOP Division", "location_index": 1, "focus": "information warfare and influence operations",
                    "agents": [
                        {"name": "Maj. Dominic Reeves", "role": "advisor", "persona_template": "psyops_specialist",
                         "expertise": ["narrative warfare", "social media exploitation"]},
                    ],
                },
            ],
        },
        {
            "name": "International Crisis Watch",
            "industry": "Humanitarian / Media",
            "description": "NGO and press corps monitoring the operation",
            "locations": [
                {"name": "ICW Press Hub", "city": "Amman", "country": "Jordan", "timezone": "Asia/Amman", "type": "headquarters"},
            ],
            "teams": [
                {
                    "name": "Field Coverage", "location_index": 0, "focus": "frontline journalism and humanitarian monitoring",
                    "agents": [
                        {"name": "Sara Al-Rashid", "role": "correspondent", "persona_template": "war_correspondent",
                         "expertise": ["conflict reporting", "Arabic fluency"]},
                        {"name": "Dr. Anna Lindgren", "role": "aid_worker", "persona_template": "ngo_aid_worker",
                         "expertise": ["refugee coordination", "medical logistics"]},
                    ],
                },
            ],
        },
    ],
))

# --- Scenario 2: Cyber Siege ---
_register(ScenarioConfig(
    name="Cyber Siege",
    description="A nation-state cyber attack targets critical infrastructure. Military cyber units, intelligence agencies, and civilian responders race to contain the breach.",
    category="crisis",
    tags=["cyber", "crisis", "infrastructure", "defense"],
    organizations=[
        {
            "name": "Cyber Command Unit",
            "industry": "Military - Cyber",
            "description": "National cyber warfare command responding to the attack",
            "locations": [
                {"name": "Cyber HQ", "city": "Fort Meade", "country": "USA", "timezone": "US/Eastern", "type": "headquarters"},
                {"name": "West Coast Node", "city": "San Antonio", "country": "USA", "timezone": "US/Central", "type": "branch"},
            ],
            "teams": [
                {
                    "name": "Threat Hunt", "location_index": 0, "focus": "identifying and neutralizing adversary presence in networks",
                    "agents": [
                        {"name": "Col. Victor Chen", "role": "commander", "persona_template": "commanding_officer",
                         "expertise": ["cyber operations command", "joint force integration"],
                         "background": "Stood up the first offensive cyber battalion"},
                        {"name": "Capt. Zara Okonkwo", "role": "engineer", "persona_template": "cyber_warfare_specialist",
                         "expertise": ["malware reverse engineering", "threat intelligence"]},
                        {"name": "Spc. Danny Kim", "role": "operator", "persona_template": "drone_operator",
                         "expertise": ["network monitoring", "anomaly detection"],
                         "background": "Former SOC analyst, sees patterns others miss"},
                    ],
                },
                {
                    "name": "Counter-Intel", "location_index": 1, "focus": "attribution and adversary profiling",
                    "agents": [
                        {"name": "Maj. Rachel Torres", "role": "analyst", "persona_template": "intelligence_analyst",
                         "expertise": ["APT tracking", "OSINT"]},
                        {"name": "Agent Liu Wei", "role": "analyst", "persona_template": "psyops_specialist",
                         "expertise": ["deception operations", "counter-propaganda"]},
                    ],
                },
            ],
        },
        {
            "name": "National Crisis Center",
            "industry": "Government - Emergency Management",
            "description": "Civilian crisis coordination center managing the response",
            "locations": [
                {"name": "NCC Operations", "city": "Washington DC", "country": "USA", "timezone": "US/Eastern", "type": "headquarters"},
            ],
            "teams": [
                {
                    "name": "Interagency Response", "location_index": 0, "focus": "coordinating military, civilian, and private sector response",
                    "agents": [
                        {"name": "Director Patricia Hale", "role": "executive", "persona_template": "crisis_coordinator",
                         "expertise": ["interagency coordination", "FEMA protocols"]},
                        {"name": "Sen. Advisor Mark Brennan", "role": "advisor", "persona_template": "political_advisor",
                         "expertise": ["national security policy", "congressional liaison"],
                         "background": "Former NSC staffer, understands the political dimensions of cyber crises"},
                        {"name": "Cmdr. Nadia Petrova", "role": "analyst", "persona_template": "logistics_officer",
                         "expertise": ["supply chain security", "infrastructure resilience"]},
                    ],
                },
            ],
        },
    ],
))

# --- Scenario 3: Peacekeeping Breakdown ---
_register(ScenarioConfig(
    name="Peacekeeping Breakdown",
    description="A UN peacekeeping mission deteriorates as factional violence escalates. Military, diplomatic, and humanitarian actors clash over priorities.",
    category="crisis",
    tags=["peacekeeping", "UN", "humanitarian", "diplomacy"],
    organizations=[
        {
            "name": "UNMIS Force",
            "industry": "Military - Peacekeeping",
            "description": "UN multinational peacekeeping force on the ground",
            "locations": [
                {"name": "UNMIS HQ", "city": "Juba", "country": "South Sudan", "timezone": "Africa/Juba", "type": "headquarters"},
                {"name": "Sector North", "city": "Malakal", "country": "South Sudan", "timezone": "Africa/Juba", "type": "branch"},
            ],
            "teams": [
                {
                    "name": "Force Command", "location_index": 0, "focus": "peacekeeping operations and force protection",
                    "agents": [
                        {"name": "Gen. Kwame Asante", "role": "commander", "persona_template": "commanding_officer",
                         "expertise": ["peacekeeping doctrine", "rules of engagement"],
                         "background": "Ghanaian Army general, 4 peacekeeping tours, believes in restraint"},
                        {"name": "Col. Ingrid Svensson", "role": "strategist", "persona_template": "defense_strategist",
                         "expertise": ["protection of civilians", "conflict de-escalation"]},
                        {"name": "Capt. Jean-Baptiste Noel", "role": "medic", "persona_template": "combat_medic",
                         "expertise": ["mass casualty triage", "tropical medicine"]},
                    ],
                },
                {
                    "name": "Sector North Patrol", "location_index": 1, "focus": "patrol operations and community engagement in contested area",
                    "agents": [
                        {"name": "Lt. Priya Sharma", "role": "operator", "persona_template": "field_operator",
                         "expertise": ["patrol tactics", "local liaison"]},
                        {"name": "Sgt. Thomas Okello", "role": "operator", "persona_template": "spec_ops_commander",
                         "expertise": ["close protection", "checkpoint operations"],
                         "background": "Ugandan NCO, respected by local population"},
                    ],
                },
            ],
        },
        {
            "name": "UN Political Mission",
            "industry": "Diplomacy",
            "description": "UN diplomatic and political affairs team",
            "locations": [
                {"name": "UNMIS Political Office", "city": "Juba", "country": "South Sudan", "timezone": "Africa/Juba", "type": "headquarters"},
            ],
            "teams": [
                {
                    "name": "Political Affairs", "location_index": 0, "focus": "ceasefire negotiations and political dialogue",
                    "agents": [
                        {"name": "Amb. Catherine Dubois", "role": "diplomat", "persona_template": "diplomatic_envoy",
                         "expertise": ["mediation", "ceasefire negotiation"],
                         "background": "French career diplomat, negotiated 3 peace agreements"},
                        {"name": "Dr. Hassan Mahmoud", "role": "advisor", "persona_template": "political_advisor",
                         "expertise": ["regional politics", "factional dynamics"]},
                    ],
                },
            ],
        },
        {
            "name": "Doctors Without Borders",
            "industry": "Humanitarian",
            "description": "MSF medical and humanitarian operation",
            "locations": [
                {"name": "MSF Field Hospital", "city": "Malakal", "country": "South Sudan", "timezone": "Africa/Juba", "type": "headquarters"},
            ],
            "teams": [
                {
                    "name": "Medical Team", "location_index": 0, "focus": "emergency medical care and humanitarian access",
                    "agents": [
                        {"name": "Dr. Lena Hoffmann", "role": "aid_worker", "persona_template": "ngo_aid_worker",
                         "expertise": ["emergency surgery", "humanitarian law"],
                         "background": "German surgeon, furious about restrictions on humanitarian access"},
                        {"name": "Miguel Santos", "role": "correspondent", "persona_template": "war_correspondent",
                         "expertise": ["humanitarian reporting", "documentary"],
                         "background": "Embedded journalist documenting the deteriorating situation"},
                    ],
                },
            ],
        },
    ],
))

# --- Scenario 4: Proxy War Intelligence ---
_register(ScenarioConfig(
    name="Shadow Theater",
    description="Multiple intelligence agencies operate in the same theater, sometimes cooperating, sometimes competing. A proxy war generates conflicting narratives and shifting alliances.",
    category="intelligence",
    tags=["intelligence", "proxy-war", "espionage", "multi-agency"],
    organizations=[
        {
            "name": "Station Blacksite",
            "industry": "Intelligence - Western",
            "description": "CIA-led intelligence station in contested region",
            "locations": [
                {"name": "Station Alpha", "city": "Beirut", "country": "Lebanon", "timezone": "Asia/Beirut", "type": "headquarters"},
                {"name": "Station Bravo", "city": "Istanbul", "country": "Turkey", "timezone": "Europe/Istanbul", "type": "branch"},
            ],
            "teams": [
                {
                    "name": "HUMINT Operations", "location_index": 0, "focus": "human intelligence collection and agent handling",
                    "agents": [
                        {"name": "Case Officer Sarah Mitchell", "role": "operator", "persona_template": "field_operator",
                         "expertise": ["agent recruitment", "denied area operations"],
                         "background": "15 years in the field, trusts no one fully"},
                        {"name": "Analyst David Park", "role": "analyst", "persona_template": "intelligence_analyst",
                         "expertise": ["network mapping", "pattern of life analysis"]},
                        {"name": "Tech Officer Nina Volkov", "role": "engineer", "persona_template": "cyber_warfare_specialist",
                         "expertise": ["covert communications", "surveillance tech"]},
                    ],
                },
                {
                    "name": "Influence Cell", "location_index": 1, "focus": "covert influence and information operations",
                    "agents": [
                        {"name": "Officer James Callahan", "role": "advisor", "persona_template": "psyops_specialist",
                         "expertise": ["covert action", "media manipulation"]},
                    ],
                },
            ],
        },
        {
            "name": "Allied Directorate",
            "industry": "Intelligence - Regional",
            "description": "Regional allied intelligence service with local knowledge",
            "locations": [
                {"name": "Directorate HQ", "city": "Amman", "country": "Jordan", "timezone": "Asia/Amman", "type": "headquarters"},
            ],
            "teams": [
                {
                    "name": "Regional Analysis", "location_index": 0, "focus": "regional threat assessment and liaison",
                    "agents": [
                        {"name": "Dir. Tariq Al-Fayed", "role": "commander", "persona_template": "commanding_officer",
                         "expertise": ["regional security", "counterterrorism"],
                         "background": "Jordanian intelligence veteran, pragmatic and well-connected"},
                        {"name": "Capt. Layla Hassan", "role": "analyst", "persona_template": "intelligence_analyst",
                         "expertise": ["open-source intelligence", "social media analysis"]},
                        {"name": "Envoy Omar Mansour", "role": "diplomat", "persona_template": "diplomatic_envoy",
                         "expertise": ["back-channel negotiations", "tribal liaison"]},
                    ],
                },
            ],
        },
        {
            "name": "War Lens Media",
            "industry": "Media",
            "description": "Independent investigative journalism collective",
            "locations": [
                {"name": "WL Bureau", "city": "Istanbul", "country": "Turkey", "timezone": "Europe/Istanbul", "type": "headquarters"},
            ],
            "teams": [
                {
                    "name": "Investigations", "location_index": 0, "focus": "investigating covert operations and civilian impact",
                    "agents": [
                        {"name": "Yara Nazari", "role": "correspondent", "persona_template": "war_correspondent",
                         "expertise": ["investigative journalism", "source protection"]},
                    ],
                },
            ],
        },
    ],
))

# --- Scenario 5: Evacuation Under Fire ---
_register(ScenarioConfig(
    name="Evacuation Under Fire",
    description="An embassy evacuation turns into a running battle. Spec ops, diplomats, medics, and logistics race against time as the situation deteriorates.",
    category="crisis",
    tags=["evacuation", "embassy", "spec-ops", "time-pressure"],
    organizations=[
        {
            "name": "Task Force Extraction",
            "industry": "Military - Special Operations",
            "description": "Joint special operations task force executing the evacuation",
            "locations": [
                {"name": "USS Resolute (offshore)", "city": "Offshore", "country": "International Waters", "timezone": "UTC", "type": "headquarters"},
                {"name": "Rally Point Alpha", "city": "Khartoum", "country": "Sudan", "timezone": "Africa/Khartoum", "type": "branch"},
            ],
            "teams": [
                {
                    "name": "Assault Element", "location_index": 1, "focus": "direct action and personnel recovery",
                    "agents": [
                        {"name": "Maj. Cole Barrett", "role": "commander", "persona_template": "spec_ops_commander",
                         "expertise": ["hostage rescue", "urban warfare"],
                         "background": "Delta Force veteran, ice cold under fire"},
                        {"name": "SSgt. Kim Soo-jin", "role": "operator", "persona_template": "field_operator",
                         "expertise": ["breaching", "close quarters battle"]},
                        {"name": "Doc Rivera", "role": "medic", "persona_template": "combat_medic",
                         "expertise": ["tactical medicine", "surgical resuscitation"],
                         "background": "PJ turned combat medic, has saved lives under fire more times than he can count"},
                    ],
                },
                {
                    "name": "Command & Control", "location_index": 0, "focus": "overall mission coordination and ISR",
                    "agents": [
                        {"name": "Capt. Nadia Osman", "role": "commander", "persona_template": "commanding_officer",
                         "expertise": ["C2 systems", "air-ground coordination"]},
                        {"name": "Lt. Jake Reiner", "role": "pilot", "persona_template": "drone_operator",
                         "expertise": ["Predator/Reaper", "real-time ISR feed"],
                         "background": "Provides eyes in the sky for the ground team"},
                        {"name": "WO2 Grace Okonkwo", "role": "analyst", "persona_template": "logistics_officer",
                         "expertise": ["airlift coordination", "fuel and ammo logistics"]},
                    ],
                },
            ],
        },
        {
            "name": "US Embassy Khartoum",
            "industry": "Diplomacy",
            "description": "Embassy staff awaiting evacuation",
            "locations": [
                {"name": "Embassy Compound", "city": "Khartoum", "country": "Sudan", "timezone": "Africa/Khartoum", "type": "headquarters"},
            ],
            "teams": [
                {
                    "name": "Embassy Staff", "location_index": 0, "focus": "civilian protection and classified material destruction",
                    "agents": [
                        {"name": "Amb. Richard Holt", "role": "diplomat", "persona_template": "diplomatic_envoy",
                         "expertise": ["crisis diplomacy", "host nation negotiation"],
                         "background": "Career FSO, refuses to leave until all staff are accounted for"},
                        {"name": "RSO Maria Gutierrez", "role": "operator", "persona_template": "field_operator",
                         "expertise": ["diplomatic security", "emergency planning"],
                         "background": "Regional Security Officer, has drilled this scenario a hundred times"},
                        {"name": "Advisor Khalid Ibrahim", "role": "advisor", "persona_template": "political_advisor",
                         "expertise": ["Sudanese politics", "militia factions"]},
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
