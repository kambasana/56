#!/usr/bin/env python3
"""NexusSocial - Multi-Agent Social Platform powered by CAMEL AI.

A multi-agent, multi-org, multi-location social platform that simulates
real social media interactions between agents across organizations.

Combines:
- CAMEL AI for intelligent agent interactions (role-playing, memory, communication)
- MiroFish-inspired document intelligence with knowledge graphs
- Active social media simulation (posts, comments, reactions, DMs)
- Multi-org/team/location dynamics with cross-org interactions
- Interactive visualization dashboard

Usage:
    python main.py                    # Start with default world
    python main.py --headless 20      # Run 20 ticks without UI
    python main.py --port 8080        # Start on custom port
"""

import argparse
import json
import logging
import sys

from nexus_social.camel_engine.brain import CamelBrain
from nexus_social.core.world import build_default_world
from nexus_social.documents.intelligence import DocumentIntelligence
from nexus_social.social.platform import SocialPlatform
from nexus_social.visualization.server import create_app

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger("nexus_social")


def run_headless(ticks: int):
    """Run simulation without web UI and print results."""
    brain = CamelBrain()
    platform = SocialPlatform(brain)
    doc_intel = DocumentIntelligence()

    orgs, agents = build_default_world()
    platform.register_agents(agents)

    print(f"\n=== NexusSocial Simulation ===")
    print(f"Organizations: {', '.join(o.name for o in orgs)}")
    print(f"Agents: {len(agents)}")
    print(f"Locations: {sum(len(o.locations) for o in orgs)}")
    print(f"Teams: {sum(len(o.teams) for o in orgs)}")
    print(f"Running {ticks} ticks...\n")

    for i in range(ticks):
        events = platform.simulate_tick()
        # Sync docs
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

    # Print sample feed
    feed = platform.get_feed(limit=5)
    print(f"\n--- Latest Posts ---")
    for post in feed:
        print(f"\n  [{post['author_org']}] {post['author']} ({post['author_role']})")
        print(f"  {post['content']}")
        if post['comments']:
            for c in post['comments'][:2]:
                print(f"    -> {c['author']}: {c['content']}")

    # Network stats
    graph = platform.get_network_graph()
    print(f"\n--- Network ---")
    print(f"  Nodes: {len(graph['nodes'])}")
    print(f"  Connections: {len(graph['edges'])}")

    return analytics


def run_server(port: int, host: str):
    """Run the web visualization server."""
    brain = CamelBrain()
    platform = SocialPlatform(brain)
    doc_intel = DocumentIntelligence()

    orgs, agents = build_default_world()
    platform.register_agents(agents)

    print(f"\n=== NexusSocial Platform ===")
    print(f"Organizations: {', '.join(o.name for o in orgs)}")
    print(f"Agents: {len(agents)}")
    print(f"Teams: {sum(len(o.teams) for o in orgs)}")
    print(f"Engine: {'CAMEL AI' if brain.use_camel else 'Built-in Simulation'}")
    print(f"\nDashboard: http://{host}:{port}")
    print(f"Click 'Simulate' in the UI to start generating interactions.\n")

    app = create_app(platform, doc_intel)
    app.run(host=host, port=port, debug=False)


def main():
    parser = argparse.ArgumentParser(description="NexusSocial - Multi-Agent Social Platform")
    parser.add_argument("--headless", type=int, metavar="TICKS",
                        help="Run N simulation ticks without web UI")
    parser.add_argument("--port", type=int, default=5000, help="Web server port (default: 5000)")
    parser.add_argument("--host", default="0.0.0.0", help="Web server host (default: 0.0.0.0)")
    args = parser.parse_args()

    if args.headless:
        run_headless(args.headless)
    else:
        run_server(args.port, args.host)


if __name__ == "__main__":
    main()
