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


# =============================================================================
# Narrative Arcs - Story engines for each scenario
# =============================================================================

from nexus_social.core.narrative import NarrativeArc, NarrativeEvent, NarrativePhase

NARRATIVE_ARCS: dict[str, NarrativeArc] = {}


def _register_arc(arc: NarrativeArc):
    NARRATIVE_ARCS[arc.scenario_name] = arc


# --- Coalition Strike Narrative ---
_register_arc(NarrativeArc(
    scenario_name="Coalition Strike",
    phases=[
        NarrativePhase(
            name="Planning",
            description="Coalition forces are in the planning phase. Intelligence is being gathered, targets identified, and operational plans drafted. Tension between US-led ground forces and UK intelligence over threat assessment methodology.",
            start_tick=0,
            base_tension=0.3,
            base_urgency=0.3,
            active_themes=["target selection", "intel sharing", "rules of engagement", "coalition coordination"],
            situation_details=[
                "SIGINT intercepts suggest adversary is reinforcing defensive positions.",
                "Satellite imagery shows new vehicle movements near the target area.",
                "Coalition partners disagree on the timeline - UK wants more intel, US wants to move.",
                "Local source reports indicate civilian presence near primary target.",
                "Weather window for the operation is narrowing.",
            ],
        ),
        NarrativePhase(
            name="Escalation",
            description="An IED attack on a coalition patrol kills two soldiers and wounds four. Pressure mounts to accelerate the operation. Media coverage intensifies. NGOs demand humanitarian corridors.",
            start_tick=5,
            base_tension=0.6,
            base_urgency=0.6,
            active_themes=["casualties", "retaliation pressure", "media scrutiny", "humanitarian concerns"],
            situation_details=[
                "Medevac helicopters are running constant sorties.",
                "Command is under pressure from politicians to show results.",
                "Sara Al-Rashid's reporting on civilian impact is going viral.",
                "Intelligence suggests a mole may be leaking operational plans.",
                "Forward Element reports increased hostile activity near FOB Sentinel.",
            ],
        ),
        NarrativePhase(
            name="Execution",
            description="The strike operation is underway. Cyber operations have degraded adversary communications. Ground forces are moving to contact. Everything is happening fast and fog of war is thick.",
            start_tick=10,
            base_tension=0.85,
            base_urgency=0.9,
            active_themes=["fog of war", "communications breakdown", "civilian risk", "mission success"],
            situation_details=[
                "Ground forces report contact with hostiles at two locations simultaneously.",
                "Drone feed shows movement near the secondary target - could be civilians.",
                "Cyber ops has taken down adversary C2 network but it may come back.",
                "Friendly fire incident reported but unconfirmed.",
                "Coalition partner forces are 30 minutes behind schedule.",
            ],
        ),
        NarrativePhase(
            name="Aftermath",
            description="The operation is complete. Assessing damage, casualties, and political fallout. Media is asking hard questions. Intel is being reviewed for lessons learned.",
            start_tick=15,
            base_tension=0.5,
            base_urgency=0.3,
            active_themes=["battle damage assessment", "lessons learned", "media response", "political fallout"],
            situation_details=[
                "Initial BDA shows primary target destroyed but secondary target status unclear.",
                "Three coalition casualties and an unknown number of adversary KIA.",
                "NGO reports of civilian casualties near the strike zone.",
                "Political leadership wants a full briefing within 24 hours.",
                "Intelligence is reviewing whether the pre-strike assessment was accurate.",
            ],
        ),
    ],
    events=[
        NarrativeEvent(tick_trigger=1, name="Intel Disagreement",
                       description="UK intelligence challenges US threat assessment. Dr. Blackwood's analysis contradicts Maj. Vasquez's SIGINT conclusions. Tension in the joint intel cell.",
                       stress_impact=0.1, morale_impact=-0.05,
                       tags=["intel", "disagreement"]),
        NarrativeEvent(tick_trigger=3, name="Media Leak",
                       description="Sara Al-Rashid publishes a report suggesting the coalition is planning strikes near populated areas. Command is furious about the leak.",
                       stress_impact=0.15, morale_impact=-0.1,
                       tags=["media", "leak", "opsec"]),
        NarrativeEvent(tick_trigger=5, name="IED Attack",
                       description="URGENT: IED attack on coalition patrol near FOB Sentinel. 2 KIA, 4 WIA. Medevac inbound. All units on high alert.",
                       stress_impact=0.3, morale_impact=-0.25,
                       tags=["attack", "casualties", "ied"]),
        NarrativeEvent(tick_trigger=7, name="Humanitarian Demand",
                       description="Dr. Lindgren and MSF formally demand a 48-hour humanitarian pause. Coalition command must respond.",
                       stress_impact=0.1, morale_impact=0.0,
                       target_orgs=["Task Force Vanguard", "International Crisis Watch"],
                       tags=["humanitarian", "pause", "demand"]),
        NarrativeEvent(tick_trigger=10, name="Operation Launched",
                       description="EXECUTE EXECUTE EXECUTE. Operation Thunderclap is go. All elements moving to their assault positions. Radio discipline in effect.",
                       stress_impact=0.25, morale_impact=0.1,
                       target_orgs=["Task Force Vanguard"],
                       tags=["operation", "execute", "assault"]),
        NarrativeEvent(tick_trigger=12, name="Civilian Casualty Report",
                       description="FLASH: Reports of civilian casualties at Grid Reference 4827. Drone footage being reviewed. Media already asking questions.",
                       stress_impact=0.3, morale_impact=-0.3,
                       tags=["civcas", "investigation", "media"]),
        NarrativeEvent(tick_trigger=15, name="Mission Complete",
                       description="Operation Thunderclap declared complete. Primary objective achieved. Full BDA and AAR to follow. But questions remain about the civilian casualty reports.",
                       stress_impact=-0.1, morale_impact=0.15,
                       tags=["complete", "bda", "review"]),
    ],
    baked_tensions={
        "Col. Hawkins vs Dr. Blackwood": "Hawkins thinks Blackwood's analysis is too cautious and is slowing the operation. Blackwood thinks Hawkins is rushing to action without sufficient intel.",
        "Sara Al-Rashid vs Maj. Reeves": "Al-Rashid suspects Reeves' PSYOP division is planting stories. Reeves sees Al-Rashid as a security risk who could compromise operations.",
        "Dr. Lindgren vs Col. Hawkins": "Lindgren blames military operations for civilian suffering. Hawkins sees NGO demands as naive interference in military necessity.",
        "Maj. Vasquez vs Dr. Blackwood": "Vasquez trusts SIGINT data. Blackwood distrusts raw signals and wants HUMINT verification. Their analyses keep contradicting each other.",
    },
))


# --- Cyber Siege Narrative ---
_register_arc(NarrativeArc(
    scenario_name="Cyber Siege",
    phases=[
        NarrativePhase(
            name="Detection",
            description="Anomalous network activity detected across multiple critical infrastructure sectors. Initial indicators suggest a sophisticated nation-state actor. The scope is unclear but growing.",
            start_tick=0, base_tension=0.4, base_urgency=0.5,
            active_themes=["anomaly detection", "attribution", "scope assessment", "coordination"],
            situation_details=[
                "Power grid monitoring systems showing irregular data patterns.",
                "Financial sector CERT reports similar indicators of compromise.",
                "Initial forensics suggest the malware has been dormant for weeks.",
                "Three ISPs report unusual outbound traffic to known C2 infrastructure.",
            ],
        ),
        NarrativePhase(
            name="Containment",
            description="The attack scope is now clear: water treatment, power grid, and financial systems are all compromised. Containment efforts are underway but the adversary is adapting in real time.",
            start_tick=5, base_tension=0.7, base_urgency=0.8,
            active_themes=["containment", "adversary adaptation", "public safety", "political pressure"],
            situation_details=[
                "Water treatment facility in Ohio has lost SCADA control.",
                "Rolling blackouts hitting the Eastern seaboard.",
                "Adversary deploying new malware variants faster than patches can be applied.",
                "White House demanding hourly updates. Congressional briefing scheduled.",
            ],
        ),
        NarrativePhase(
            name="Counterattack",
            description="Offensive cyber operations authorized. The team is fighting back while simultaneously trying to restore critical services. Attribution is confirmed but the political response is still being debated.",
            start_tick=10, base_tension=0.85, base_urgency=0.9,
            active_themes=["offensive operations", "attribution", "restoration", "escalation risk"],
            situation_details=[
                "Counter-operations targeting adversary C2 infrastructure.",
                "Partial power grid restoration in progress.",
                "Adversary threatening to release stolen data if operations continue.",
                "Diplomatic back-channel activated to de-escalate.",
            ],
        ),
    ],
    events=[
        NarrativeEvent(tick_trigger=2, name="SCADA Breach Confirmed",
                       description="CRITICAL: SCADA breach confirmed at 3 water treatment facilities. Adversary has the ability to alter chemical treatment levels. Public safety at risk.",
                       stress_impact=0.25, morale_impact=-0.2, tags=["scada", "water", "critical"]),
        NarrativeEvent(tick_trigger=5, name="Grid Goes Down",
                       description="FLASH: Eastern seaboard power grid experiencing cascading failures. 12 million people without power. Emergency services overwhelmed.",
                       stress_impact=0.35, morale_impact=-0.3, tags=["grid", "blackout", "emergency"]),
        NarrativeEvent(tick_trigger=8, name="Attribution Confirmed",
                       description="NSA confirms attribution to Unit 74455 (Sandworm). Evidence chain is solid. President convening NSC meeting.",
                       stress_impact=0.1, morale_impact=0.1, tags=["attribution", "nsc", "policy"]),
        NarrativeEvent(tick_trigger=10, name="Offensive Ops Authorized",
                       description="POTUS has authorized offensive cyber operations against adversary infrastructure. Cyber Command executing Operation Digital Storm.",
                       stress_impact=0.15, morale_impact=0.2,
                       target_orgs=["Cyber Command Unit"], tags=["offensive", "authorized"]),
        NarrativeEvent(tick_trigger=13, name="Data Ransom Threat",
                       description="Adversary threatens to dump 2TB of stolen government data unless offensive operations cease within 24 hours.",
                       stress_impact=0.25, morale_impact=-0.15, tags=["ransom", "data", "threat"]),
    ],
    baked_tensions={
        "Col. Chen vs Director Hale": "Chen wants to go full offensive. Hale worries about escalation and wants to prioritize civilian infrastructure restoration.",
        "Capt. Okonkwo vs Agent Liu Wei": "Okonkwo found suspicious traffic patterns that Liu Wei dismissed. Building mistrust about whether counter-intel is compromised.",
        "Sen. Advisor Brennan vs Col. Chen": "Brennan is focused on political optics and congressional fallout. Chen thinks politics are getting in the way of the mission.",
    },
))


# --- Evacuation Under Fire Narrative ---
_register_arc(NarrativeArc(
    scenario_name="Evacuation Under Fire",
    phases=[
        NarrativePhase(
            name="Alert",
            description="Embassy ordered to prepare for emergency evacuation. Fighting has reached the outskirts of the capital. Task Force Extraction is staging offshore.",
            start_tick=0, base_tension=0.5, base_urgency=0.6,
            active_themes=["evacuation planning", "route security", "classified destruction", "civilian protection"],
            situation_details=[
                "Militia forces have seized 2 of 3 bridges leading to the airport.",
                "Ambassador Holt refuses to leave until all 47 staff are accounted for.",
                "RSO Gutierrez reports the compound perimeter is secure but won't hold long.",
                "Drone ISR shows armed technicals moving toward the embassy district.",
            ],
        ),
        NarrativePhase(
            name="Insertion",
            description="Assault Element has been inserted at Rally Point Alpha. They must reach the embassy compound through hostile territory. Communication is intermittent.",
            start_tick=4, base_tension=0.75, base_urgency=0.85,
            active_themes=["urban movement", "hostile contact", "comm breakdown", "time pressure"],
            situation_details=[
                "Assault Element took small arms fire during insertion.",
                "Two embassy staff unaccounted for - possibly at a separate safe house.",
                "Local militia leader offering safe passage in exchange for unspecified concession.",
                "USS Resolute reports helicopter assets are 45 minutes out.",
            ],
        ),
        NarrativePhase(
            name="Extraction",
            description="Link-up with embassy complete. Now fighting their way to the extraction point while protecting 47 civilians. Every minute counts.",
            start_tick=8, base_tension=0.95, base_urgency=0.95,
            active_themes=["fighting withdrawal", "civilian protection", "helicopter extraction", "casualties"],
            situation_details=[
                "Heavy contact at the intersection of Al-Gamhoria and Nile Street.",
                "Doc Rivera treating multiple casualties while on the move.",
                "Helicopters inbound but LZ is not yet secured.",
                "Ambassador insisting on bringing locally employed staff - 12 additional people.",
            ],
        ),
    ],
    events=[
        NarrativeEvent(tick_trigger=1, name="Bridge Seized",
                       description="Militia forces have seized the Al-Mak Nimir Bridge. Primary extraction route is now compromised. Planning alternate routes.",
                       stress_impact=0.2, morale_impact=-0.15, tags=["bridge", "route", "compromised"]),
        NarrativeEvent(tick_trigger=4, name="Contact on Insertion",
                       description="Assault Element taking fire during infiltration. One operator wounded. SSgt. Kim Soo-jin returning fire. Continuing to push through.",
                       stress_impact=0.25, morale_impact=-0.2,
                       target_orgs=["Task Force Extraction"], tags=["contact", "wounded"]),
        NarrativeEvent(tick_trigger=6, name="Missing Staff",
                       description="Two embassy staff confirmed at a secondary safe house 3km from compound. Someone has to go get them.",
                       stress_impact=0.2, morale_impact=-0.1, tags=["missing", "rescue", "diversion"]),
        NarrativeEvent(tick_trigger=8, name="Embassy Link-Up",
                       description="Assault Element has reached the embassy compound. Perimeter is holding. Beginning evacuation preparations. 47 civilians plus 12 local staff.",
                       stress_impact=-0.05, morale_impact=0.2, tags=["linkup", "embassy", "evacuation"]),
        NarrativeEvent(tick_trigger=10, name="Heavy Contact",
                       description="TROOPS IN CONTACT. Heavy fire from multiple directions en route to LZ. Two casualties. Doc Rivera working under fire. Requesting immediate air support.",
                       stress_impact=0.35, morale_impact=-0.25, tags=["tic", "casualties", "air_support"]),
        NarrativeEvent(tick_trigger=12, name="Helicopters Inbound",
                       description="Two MH-60 Black Hawks inbound. ETA 8 minutes. LZ must be secured. Barrett's team pushing to clear the landing zone.",
                       stress_impact=0.1, morale_impact=0.15, tags=["helo", "extraction", "lz"]),
    ],
    baked_tensions={
        "Maj. Barrett vs Amb. Holt": "Barrett wants to leave now with who they have. Holt won't leave without every staff member, including local employees.",
        "Capt. Osman vs Maj. Barrett": "Osman wants to control the operation from offshore. Barrett thinks she can't see the ground truth from the ship.",
        "RSO Gutierrez vs Advisor Ibrahim": "Gutierrez has a by-the-book evacuation plan. Ibrahim says the militia leader's offer of safe passage is the smarter play.",
    },
))
