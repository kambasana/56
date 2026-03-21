#!/usr/bin/env python3
"""NexusSocial - Multi-Agent Social Platform powered by CAMEL AI.

A scenario-driven, multi-agent social platform. Define personas, groups,
teams, locations, and organizations - then watch them interact. Pick
pre-made scenarios or build custom ones.

Usage:
    python main.py                              # Start with scenario picker
    python main.py --scenario "Tech Rivalry"    # Start with a specific scenario
    python main.py --headless 20                # Run 20 ticks, no UI
    python main.py --list-scenarios             # List available scenarios
    python main.py --port 8080                  # Custom port
"""

import argparse
import logging

from nexus_social.camel_engine.brain import CamelBrain
from nexus_social.core.scenarios import (
    SCENARIOS,
    ScenarioBuilder,
    list_scenarios,
)
from nexus_social.core.world import build_default_world
from nexus_social.documents.intelligence import DocumentIntelligence
from nexus_social.social.platform import SocialPlatform
from nexus_social.visualization.server import create_app

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger("nexus_social")


def _load_scenario(scenario_name: str | None, brain: CamelBrain):
    """Load a scenario by name or fall back to default world."""
    if scenario_name and scenario_name in SCENARIOS:
        config = SCENARIOS[scenario_name]
        builder = ScenarioBuilder()
        orgs, agents = builder.build(config)
        print(f"Loaded scenario: {config.name}")
        print(f"  {config.description}")
    else:
        if scenario_name:
            print(f"Scenario '{scenario_name}' not found, using default world.")
        orgs, agents = build_default_world()

    return orgs, agents


def run_headless(ticks: int, scenario_name: str | None = None):
    """Run simulation without web UI and print results."""
    brain = CamelBrain()
    platform = SocialPlatform(brain)
    doc_intel = DocumentIntelligence()

    orgs, agents = _load_scenario(scenario_name, brain)
    platform.register_agents(agents)

    print(f"\n=== NexusSocial Simulation ===")
    print(f"Organizations: {', '.join(o.name for o in orgs)}")
    print(f"Agents: {len(agents)}")
    print(f"Locations: {sum(len(o.locations) for o in orgs)}")
    print(f"Teams: {sum(len(o.teams) for o in orgs)}")
    print(f"Running {ticks} ticks...\n")

    for i in range(ticks):
        events = platform.simulate_tick()
        for doc in platform.documents:
            if doc not in doc_intel.documents:
                doc_intel.ingest(doc)
        print(f"  Tick {i+1}: {len(events)} events")

    analytics = platform.get_analytics()
    print(f"\n=== Results ===")
    print(f"Total Posts: {analytics['total_posts']}")
    print(f"Total Comments: {analytics['total_comments']}")
    print(f"Total Reactions: {analytics['total_reactions']}")
    print(f"Direct Messages: {analytics['total_dms']}")
    print(f"Documents Created: {analytics['total_documents']}")
    print(f"Cross-Org Interactions: {analytics['cross_org_interactions']}")

    print(f"\n--- Activity by Organization ---")
    for org, count in sorted(analytics.get("org_activity", {}).items(), key=lambda x: -x[1]):
        print(f"  {org}: {count} posts")

    print(f"\n--- Activity by Location ---")
    for loc, count in sorted(analytics.get("location_activity", {}).items(), key=lambda x: -x[1]):
        print(f"  {loc}: {count} posts")

    print(f"\n--- Sentiment Distribution ---")
    for sentiment, count in analytics.get("sentiment_distribution", {}).items():
        print(f"  {sentiment}: {count}")

    if doc_intel.documents:
        print(f"\n--- Trending Topics ---")
        for topic in doc_intel.get_trending_topics(5):
            print(f"  {topic['topic']}: {topic['count']} mentions")

    feed = platform.get_feed(limit=5)
    print(f"\n--- Latest Posts ---")
    for post in feed:
        print(f"\n  [{post['author_org']}] {post['author']} ({post['author_role']})")
        print(f"  {post['content']}")
        if post['comments']:
            for c in post['comments'][:2]:
                print(f"    -> {c['author']}: {c['content']}")

    graph = platform.get_network_graph()
    print(f"\n--- Network ---")
    print(f"  Nodes: {len(graph['nodes'])}")
    print(f"  Connections: {len(graph['edges'])}")

    return analytics


def run_server(port: int, host: str, scenario_name: str | None = None):
    """Run the web visualization server."""
    brain = CamelBrain()
    platform = SocialPlatform(brain)
    doc_intel = DocumentIntelligence()

    orgs, agents = _load_scenario(scenario_name, brain)
    platform.register_agents(agents)

    print(f"\n=== NexusSocial Platform ===")
    print(f"Organizations: {', '.join(o.name for o in orgs)}")
    print(f"Agents: {len(agents)}")
    print(f"Teams: {sum(len(o.teams) for o in orgs)}")
    print(f"Engine: {'CAMEL AI' if brain.use_camel else 'Built-in Simulation'}")
    print(f"\nDashboard: http://{host}:{port}")
    print(f"Use the Scenario Builder tab to switch scenarios or build custom ones.\n")

    print(f"Available pre-made scenarios:")
    for s in list_scenarios():
        print(f"  - {s['name']}: {s['description'][:60]}... ({s['agent_count']} agents)")

    app = create_app(platform, doc_intel, brain)
    app.run(host=host, port=port, debug=False)


def main():
    parser = argparse.ArgumentParser(description="NexusSocial - Multi-Agent Social Platform")
    parser.add_argument("--scenario", type=str, help="Load a pre-made scenario by name")
    parser.add_argument("--headless", type=int, metavar="TICKS",
                        help="Run N simulation ticks without web UI")
    parser.add_argument("--list-scenarios", action="store_true",
                        help="List all available pre-made scenarios")
    parser.add_argument("--port", type=int, default=5000, help="Web server port")
    parser.add_argument("--host", default="0.0.0.0", help="Web server host")
    args = parser.parse_args()

    if args.list_scenarios:
        print("\n=== Available Scenarios ===\n")
        for s in list_scenarios():
            print(f"  {s['name']}")
            print(f"    {s['description']}")
            print(f"    Category: {s['category']} | Orgs: {s['org_count']} | Agents: {s['agent_count']}")
            print(f"    Tags: {', '.join(s['tags'])}")
            print()
        return

    if args.headless:
        run_headless(args.headless, args.scenario)
    else:
        run_server(args.port, args.host, args.scenario)


if __name__ == "__main__":
    main()
