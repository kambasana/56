"""World builder - sets up multi-org, multi-team, multi-location scenarios."""

from __future__ import annotations

import random

from nexus_social.core.models import (
    AgentProfile,
    AgentRole,
    Location,
    LocationType,
    Organization,
    Team,
)


def build_default_world() -> tuple[list[Organization], list[AgentProfile]]:
    """Build a rich multi-org world with diverse teams and locations."""

    # --- Organizations ---

    # Org 1: Tech company
    nova_hq = Location("Nova HQ", "San Francisco", "USA", "US/Pacific", LocationType.HEADQUARTERS)
    nova_london = Location("Nova London", "London", "UK", "Europe/London", LocationType.BRANCH)
    nova_tokyo = Location("Nova Tokyo", "Tokyo", "Japan", "Asia/Tokyo", LocationType.BRANCH)
    nova_remote = Location("Nova Remote", "Distributed", "Global", "UTC", LocationType.REMOTE)

    nova = Organization(
        name="NovaTech",
        industry="Enterprise Software",
        description="AI-powered enterprise software company",
        locations=[nova_hq, nova_london, nova_tokyo, nova_remote],
    )

    nova_platform = Team(name="Platform Engineering", org=nova, location=nova_hq,
                         focus="cloud infrastructure and developer tools")
    nova_ai = Team(name="AI Research", org=nova, location=nova_hq,
                   focus="machine learning and natural language processing")
    nova_product = Team(name="Product", org=nova, location=nova_london,
                        focus="product strategy and user experience")
    nova_growth = Team(name="Growth", org=nova, location=nova_tokyo,
                       focus="market expansion in Asia-Pacific")
    nova.teams = [nova_platform, nova_ai, nova_product, nova_growth]

    # Org 2: Biotech company
    helix_hq = Location("Helix HQ", "Boston", "USA", "US/Eastern", LocationType.HEADQUARTERS)
    helix_zurich = Location("Helix Zurich", "Zurich", "Switzerland", "Europe/Zurich", LocationType.BRANCH)
    helix_singapore = Location("Helix SG", "Singapore", "Singapore", "Asia/Singapore", LocationType.SATELLITE)

    helix = Organization(
        name="HelixBio",
        industry="Biotechnology",
        description="Computational biology and drug discovery",
        locations=[helix_hq, helix_zurich, helix_singapore],
    )

    helix_research = Team(name="Computational Biology", org=helix, location=helix_hq,
                          focus="protein folding and drug target identification")
    helix_data = Team(name="Data Science", org=helix, location=helix_zurich,
                      focus="clinical trial analytics and biomarker discovery")
    helix_ops = Team(name="Lab Operations", org=helix, location=helix_singapore,
                     focus="high-throughput screening and lab automation")
    helix.teams = [helix_research, helix_data, helix_ops]

    # Org 3: Creative agency
    prism_hq = Location("Prism HQ", "New York", "USA", "US/Eastern", LocationType.HEADQUARTERS)
    prism_berlin = Location("Prism Berlin", "Berlin", "Germany", "Europe/Berlin", LocationType.BRANCH)
    prism_remote = Location("Prism Remote", "Distributed", "Global", "UTC", LocationType.REMOTE)

    prism = Organization(
        name="PrismCreative",
        industry="Creative Agency",
        description="Full-service creative and marketing agency",
        locations=[prism_hq, prism_berlin, prism_remote],
    )

    prism_design = Team(name="Design Studio", org=prism, location=prism_hq,
                        focus="brand identity and visual design")
    prism_content = Team(name="Content Strategy", org=prism, location=prism_berlin,
                         focus="content marketing and storytelling")
    prism_digital = Team(name="Digital Marketing", org=prism, location=prism_remote,
                         focus="paid media and performance marketing")
    prism.teams = [prism_design, prism_content, prism_digital]

    orgs = [nova, helix, prism]

    # --- Agents ---
    agents: list[AgentProfile] = []

    # NovaTech agents
    agents.extend([
        AgentProfile("Sarah Chen", AgentRole.EXECUTIVE, nova_platform,
                     ["visionary", "decisive", "data-driven"], ["cloud architecture", "team leadership"],
                     "direct and inspirational", 0.6),
        AgentProfile("Marcus Johnson", AgentRole.ENGINEER, nova_platform,
                     ["methodical", "curious", "collaborative"], ["Kubernetes", "distributed systems"],
                     "technical and concise", 0.8),
        AgentProfile("Aisha Patel", AgentRole.ENGINEER, nova_platform,
                     ["creative", "persistent", "detail-oriented"], ["API design", "Python"],
                     "friendly and thorough", 0.7),
        AgentProfile("Dr. Wei Zhang", AgentRole.RESEARCHER, nova_ai,
                     ["analytical", "innovative", "patient"], ["deep learning", "NLP", "transformers"],
                     "academic and precise", 0.5),
        AgentProfile("Yuki Tanaka", AgentRole.MANAGER, nova_ai,
                     ["empathetic", "strategic", "organized"], ["project management", "ML ops"],
                     "warm and structured", 0.7),
        AgentProfile("James O'Brien", AgentRole.DESIGNER, nova_product,
                     ["empathetic", "artistic", "user-focused"], ["UX research", "interaction design"],
                     "visual and narrative", 0.8),
        AgentProfile("Priya Sharma", AgentRole.MANAGER, nova_product,
                     ["strategic", "communicative", "data-aware"], ["product strategy", "roadmapping"],
                     "clear and persuasive", 0.75),
        AgentProfile("Kenji Nakamura", AgentRole.SALES, nova_growth,
                     ["charismatic", "resilient", "culturally-aware"], ["enterprise sales", "APAC markets"],
                     "enthusiastic and personable", 0.85),
        AgentProfile("Mei Lin", AgentRole.MARKETING, nova_growth,
                     ["creative", "analytical", "trend-aware"], ["digital marketing", "localization"],
                     "energetic and data-backed", 0.8),
    ])

    # HelixBio agents
    agents.extend([
        AgentProfile("Dr. Elena Vasquez", AgentRole.EXECUTIVE, helix_research,
                     ["brilliant", "driven", "compassionate"], ["molecular biology", "drug discovery"],
                     "scientific and inspiring", 0.5),
        AgentProfile("David Kim", AgentRole.ENGINEER, helix_research,
                     ["meticulous", "quiet", "brilliant"], ["bioinformatics", "Python", "genomics"],
                     "precise and understated", 0.6),
        AgentProfile("Anna Mueller", AgentRole.ANALYST, helix_data,
                     ["rigorous", "curious", "collaborative"], ["statistics", "clinical data"],
                     "evidence-based and clear", 0.7),
        AgentProfile("Dr. Raj Krishnan", AgentRole.RESEARCHER, helix_data,
                     ["passionate", "thorough", "innovative"], ["biomarkers", "machine learning"],
                     "academic with flair", 0.65),
        AgentProfile("Lisa Tan", AgentRole.MANAGER, helix_ops,
                     ["efficient", "practical", "supportive"], ["lab management", "automation"],
                     "direct and helpful", 0.7),
        AgentProfile("Tom Nguyen", AgentRole.ENGINEER, helix_ops,
                     ["inventive", "hands-on", "reliable"], ["robotics", "lab automation"],
                     "casual and practical", 0.75),
    ])

    # PrismCreative agents
    agents.extend([
        AgentProfile("Olivia Foster", AgentRole.EXECUTIVE, prism_design,
                     ["visionary", "bold", "empathetic"], ["brand strategy", "creative direction"],
                     "inspiring and visual", 0.6),
        AgentProfile("Alex Rivera", AgentRole.DESIGNER, prism_design,
                     ["artistic", "experimental", "collaborative"], ["visual design", "motion graphics"],
                     "expressive and playful", 0.85),
        AgentProfile("Nina Petrov", AgentRole.DESIGNER, prism_content,
                     ["storyteller", "empathetic", "strategic"], ["content strategy", "copywriting"],
                     "narrative and engaging", 0.8),
        AgentProfile("Chris Wagner", AgentRole.MARKETING, prism_content,
                     ["analytical", "creative", "trend-savvy"], ["SEO", "content distribution"],
                     "data-informed and witty", 0.75),
        AgentProfile("Sam Brooks", AgentRole.ANALYST, prism_digital,
                     ["numbers-driven", "curious", "proactive"], ["analytics", "ad optimization"],
                     "metric-focused and clear", 0.7),
        AgentProfile("Jordan Lee", AgentRole.MARKETING, prism_digital,
                     ["innovative", "fast-paced", "social-savvy"], ["social media", "influencer marketing"],
                     "trendy and engaging", 0.9),
    ])

    # Assign agents to teams
    for agent in agents:
        agent.team.members.append(agent)

    return orgs, agents


def build_custom_world(config: dict) -> tuple[list[Organization], list[AgentProfile]]:
    """Build a world from a configuration dict.

    Config format:
    {
        "organizations": [
            {
                "name": "...",
                "industry": "...",
                "locations": [{"name": "...", "city": "...", "country": "...", "timezone": "...", "type": "..."}],
                "teams": [{"name": "...", "location_index": 0, "focus": "..."}],
                "agents_per_team": 3
            }
        ]
    }
    """
    orgs = []
    agents = []
    roles = list(AgentRole)
    personality_pool = [
        "analytical", "creative", "strategic", "empathetic", "methodical",
        "innovative", "collaborative", "driven", "curious", "practical",
        "visionary", "detail-oriented", "communicative", "resilient",
    ]
    styles = ["professional", "casual", "technical", "narrative", "direct"]

    first_names = [
        "Alex", "Jordan", "Taylor", "Morgan", "Casey", "Riley", "Quinn",
        "Avery", "Blake", "Cameron", "Dana", "Ellis", "Finley", "Harper",
        "Kai", "Logan", "Mason", "Noah", "Parker", "Reese", "Sage",
    ]
    last_names = [
        "Anderson", "Brown", "Chen", "Davis", "Evans", "Foster", "Garcia",
        "Harris", "Ibrahim", "Jones", "Kim", "Liu", "Martinez", "Nguyen",
        "O'Brien", "Patel", "Quinn", "Rodriguez", "Smith", "Tanaka",
    ]

    name_counter = 0

    for org_cfg in config.get("organizations", []):
        locations = []
        for i, loc_cfg in enumerate(org_cfg.get("locations", [])):
            loc_type = LocationType(loc_cfg.get("type", "branch"))
            locations.append(Location(
                loc_cfg["name"], loc_cfg["city"], loc_cfg["country"],
                loc_cfg.get("timezone", "UTC"), loc_type,
            ))

        org = Organization(
            name=org_cfg["name"],
            industry=org_cfg.get("industry", "Technology"),
            description=org_cfg.get("description", f"{org_cfg['name']} organization"),
            locations=locations,
        )

        teams = []
        for team_cfg in org_cfg.get("teams", []):
            loc_idx = team_cfg.get("location_index", 0)
            location = locations[loc_idx] if loc_idx < len(locations) else locations[0]
            team = Team(
                name=team_cfg["name"], org=org, location=location,
                focus=team_cfg.get("focus", "general operations"),
            )
            teams.append(team)

            # Generate agents for this team
            n_agents = org_cfg.get("agents_per_team", 3)
            for _ in range(n_agents):
                fn = first_names[name_counter % len(first_names)]
                ln = last_names[name_counter % len(last_names)]
                name_counter += 1
                role = random.choice(roles)
                traits = random.sample(personality_pool, 3)
                agent = AgentProfile(
                    name=f"{fn} {ln}",
                    role=role,
                    team=team,
                    personality_traits=traits,
                    expertise=[team_cfg.get("focus", "general")],
                    communication_style=random.choice(styles),
                    activity_level=round(random.uniform(0.4, 0.9), 2),
                )
                team.members.append(agent)
                agents.append(agent)

        org.teams = teams
        orgs.append(org)

    return orgs, agents
