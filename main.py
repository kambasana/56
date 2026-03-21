#!/usr/bin/env python3
"""NexusSocial - Multi-Agent Social Media Analysis Platform.

Powered by CAMEL-AI OASIS for social simulation, with scenario-driven
narratives, deep persona psychology, agent memory, and geo-aware analysis.

Usage:
    python main.py                              # Start with scenario picker
    python main.py --scenario "Coalition Strike" # Start with a specific scenario
    python main.py --headless 20                # Run 20 ticks, no UI
    python main.py --list-scenarios             # List available scenarios
    python main.py --port 8080                  # Custom port
"""

import argparse
import asyncio
import logging
import os
import threading

from nexus_social.core.memory import MemorySystem
from nexus_social.core.narrative import NarrativeEngine
from nexus_social.core.scenarios import (
    NARRATIVE_ARCS,
    SCENARIOS,
    ScenarioBuilder,
    list_scenarios,
)
from nexus_social.documents.intelligence import DocumentIntelligence
from nexus_social.oasis_engine.analysis import SocialAnalyzer
from nexus_social.oasis_engine.bridge import OASISBridge
from nexus_social.oasis_engine.runner import SimulationRunner
from nexus_social.visualization.server import create_app

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger("nexus_social")


def _load_scenario(scenario_name: str | None):
    """Load a scenario and build all components."""
    if scenario_name and scenario_name in SCENARIOS:
        config = SCENARIOS[scenario_name]
        builder = ScenarioBuilder()
        orgs, agents = builder.build(config)
        arc = NARRATIVE_ARCS.get(config.name)
        print(f"Loaded scenario: {config.name}")
        print(f"  {config.description}")
        if arc:
            print(f"  Narrative arc: {len(arc.phases)} phases, {len(arc.events)} events")
    else:
        if scenario_name:
            print(f"Scenario '{scenario_name}' not found.")
            print(f"Available: {', '.join(SCENARIOS.keys())}")
            return None, None, None, None
        # Default to first scenario
        config = list(SCENARIOS.values())[0]
        builder = ScenarioBuilder()
        orgs, agents = builder.build(config)
        arc = NARRATIVE_ARCS.get(config.name)
        print(f"Using default scenario: {config.name}")

    return config, orgs, agents, arc


async def run_headless(ticks: int, scenario_name: str | None = None):
    """Run simulation without web UI and print results."""
    config, orgs, agents, arc = _load_scenario(scenario_name)
    if not agents:
        return

    # Build the stack
    db_path = f"./data/{config.name.lower().replace(' ', '_')}_headless.db"
    bridge = OASISBridge(db_path=db_path)
    narrative = NarrativeEngine(arc)
    memory = MemorySystem()
    runner = SimulationRunner(bridge, narrative, memory)
    analyzer = SocialAnalyzer(bridge, memory)

    print(f"\n=== NexusSocial Simulation (OASIS-powered) ===")
    print(f"Organizations: {', '.join(o.name for o in orgs)}")
    print(f"Agents: {len(agents)}")
    print(f"Locations: {sum(len(o.locations) for o in orgs)}")
    print(f"Running {ticks} ticks...\n")

    # Initialize
    await runner.initialize(agents)

    # Run ticks
    for i in range(ticks):
        summary = await runner.tick()
        phase = summary.get("phase", "?")
        tension = summary.get("tension", 0)
        events = summary.get("narrative_events", [])
        event_str = f" | Events: {', '.join(events)}" if events else ""
        print(f"  Tick {i+1}: {summary['active_agents']} active | "
              f"Phase: {phase} | Tension: {tension:.1f}{event_str}")

    # Results
    analytics = analyzer.get_analytics()
    print(f"\n=== Results ===")
    print(f"Total Posts: {analytics.get('total_posts', 0)}")
    print(f"Total Comments: {analytics.get('total_comments', 0)}")
    print(f"Cross-Org Interactions: {analytics.get('cross_org_interactions', 0)}")

    print(f"\n--- Activity by Organization ---")
    for org, count in sorted(analytics.get("org_activity", {}).items(), key=lambda x: -x[1]):
        print(f"  {org}: {count} posts")

    print(f"\n--- Activity by Geography ---")
    geo = analyzer.get_geo_breakdown()
    for geo_key, data in geo.items():
        print(f"  {geo_key}: {data['post_count']} posts, "
              f"stress={data['avg_stress']:.1f}, morale={data['avg_morale']:.1f}")

    print(f"\n--- Faction Dynamics ---")
    factions = analyzer.get_faction_analysis()
    for org, data in factions.items():
        print(f"  {org}: stress={data['avg_stress']:.1f}, morale={data['avg_morale']:.1f}")
        for target, sent in data.get("sentiment_toward", {}).items():
            print(f"    -> {target}: sentiment={sent['avg_sentiment']:.2f} ({sent['dominant_dynamic']})")

    print(f"\n--- Sentiment Distribution ---")
    for sentiment, count in analytics.get("sentiment_distribution", {}).items():
        print(f"  {sentiment}: {count}")

    feed = analyzer.get_feed(limit=5)
    print(f"\n--- Latest Posts ---")
    for post in feed:
        author = post.get("author_name", post.get("user_id", "?"))
        org = post.get("author_org", "?")
        role = post.get("author_role", "?")
        content = post.get("content", "")
        print(f"\n  [{org}] {author} ({role})")
        print(f"  {content[:200]}")

    # Shutdown
    await runner.shutdown()
    print(f"\n=== Simulation complete ===")


def run_server(port: int, host: str, scenario_name: str | None = None):
    """Run the web visualization server."""
    config, orgs, agents, arc = _load_scenario(scenario_name)
    if not agents:
        return

    # Build the stack
    db_path = f"./data/{config.name.lower().replace(' ', '_')}.db"
    bridge = OASISBridge(db_path=db_path)
    narrative = NarrativeEngine(arc)
    memory = MemorySystem()
    runner = SimulationRunner(bridge, narrative, memory)
    analyzer = SocialAnalyzer(bridge, memory)
    doc_intel = DocumentIntelligence()

    # Initialize OASIS in a background event loop
    loop = asyncio.new_event_loop()

    def run_loop():
        asyncio.set_event_loop(loop)
        loop.run_forever()

    loop_thread = threading.Thread(target=run_loop, daemon=True)
    loop_thread.start()

    # Initialize the runner
    future = asyncio.run_coroutine_threadsafe(runner.initialize(agents), loop)
    future.result(timeout=60)

    print(f"\n=== NexusSocial Platform (OASIS-powered) ===")
    print(f"Organizations: {', '.join(o.name for o in orgs)}")
    print(f"Agents: {len(agents)}")
    print(f"Teams: {sum(len(o.teams) for o in orgs)}")
    print(f"Narrative: {len(arc.phases)} phases, {len(arc.events)} events" if arc else "No narrative arc")
    print(f"\nDashboard: http://{host}:{port}")
    print(f"Use the Scenario Builder tab to switch scenarios.\n")

    print(f"Available scenarios:")
    for s in list_scenarios():
        has_arc = s["name"] in NARRATIVE_ARCS
        arc_str = " [has narrative]" if has_arc else ""
        print(f"  - {s['name']}: {s['description'][:60]}... ({s['agent_count']} agents){arc_str}")

    app = create_app(runner, analyzer, doc_intel, loop=loop)
    app.run(host=host, port=port, debug=False)


def main():
    parser = argparse.ArgumentParser(
        description="NexusSocial - Multi-Agent Social Media Analysis Platform (OASIS-powered)"
    )
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
            has_arc = s["name"] in NARRATIVE_ARCS
            arc_str = " [narrative arc]" if has_arc else ""
            print(f"  {s['name']}{arc_str}")
            print(f"    {s['description']}")
            print(f"    Category: {s['category']} | Orgs: {s['org_count']} | Agents: {s['agent_count']}")
            print(f"    Tags: {', '.join(s['tags'])}")
            print()
        return

    if args.headless:
        asyncio.run(run_headless(args.headless, args.scenario))
    else:
        run_server(args.port, args.host, args.scenario)


if __name__ == "__main__":
    main()
