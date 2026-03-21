"""CLI entry point for NexusSocial.

Usage:
    python -m nexus_social serve                          # Start API server
    python -m nexus_social serve --port 8080              # Custom port
    python -m nexus_social run --scenario "name" --ticks 20  # Run simulation headless
    python -m nexus_social ingest --doc report.txt        # Document mode
    python -m nexus_social scenarios                      # List available scenarios
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys


def main():
    parser = argparse.ArgumentParser(
        prog="nexus_social",
        description="NexusSocial — Multi-agent social simulation platform",
    )
    parser.add_argument("--verbose", "-v", action="store_true", help="Debug logging")
    sub = parser.add_subparsers(dest="command")

    # serve
    serve_p = sub.add_parser("serve", help="Start the API server")
    serve_p.add_argument("--host", default="0.0.0.0")
    serve_p.add_argument("--port", type=int, default=8000)
    serve_p.add_argument("--reload", action="store_true")
    serve_p.add_argument("--scenario", help="Auto-load a scenario on startup")
    serve_p.add_argument("--surreal-url", default="mem://",
                         help="SurrealDB URL (mem:// for dev, ws://host:port for prod)")

    # run
    run_p = sub.add_parser("run", help="Run simulation headless")
    run_p.add_argument("--scenario", required=True, help="Scenario name")
    run_p.add_argument("--ticks", type=int, default=10)
    run_p.add_argument("--surreal-url", default="mem://")
    run_p.add_argument("--output", help="Output JSON file for results")

    # ingest
    ingest_p = sub.add_parser("ingest", help="Document mode — ingest and run")
    ingest_p.add_argument("--doc", required=True, help="Path to document")
    ingest_p.add_argument("--ticks", type=int, default=10)
    ingest_p.add_argument("--surreal-url", default="mem://")
    ingest_p.add_argument("--use-llm", action="store_true",
                          help="Use LLM for entity extraction (requires API key)")

    # scenarios
    sub.add_parser("scenarios", help="List available scenarios")

    args = parser.parse_args()

    if args.verbose:
        logging.basicConfig(level=logging.DEBUG)
    else:
        logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    if args.command == "serve":
        _cmd_serve(args)
    elif args.command == "run":
        asyncio.run(_cmd_run(args))
    elif args.command == "ingest":
        asyncio.run(_cmd_ingest(args))
    elif args.command == "scenarios":
        _cmd_scenarios()
    else:
        parser.print_help()


def _cmd_serve(args):
    """Start the FastAPI server."""
    import uvicorn

    # Build the app with initial state
    async def _build_app():
        from nexus_social.core.memory import MemorySystem
        from nexus_social.core.narrative import NarrativeEngine
        from nexus_social.documents.intelligence import DocumentIntelligence
        from nexus_social.oasis_engine.analysis import SocialAnalyzer
        from nexus_social.oasis_engine.bridge import OASISBridge
        from nexus_social.oasis_engine.runner import SimulationRunner
        from nexus_social.storage.graph import GraphAnalytics
        from nexus_social.storage.surrealdb import SurrealStorage
        from nexus_social.visualization.server import create_app

        storage = SurrealStorage(url=args.surreal_url, database="nexus")
        await storage.connect()
        graph = GraphAnalytics(storage)

        bridge = OASISBridge(storage=storage)
        narrative = NarrativeEngine()
        memory = MemorySystem()
        runner = SimulationRunner(
            bridge, narrative, memory, storage=storage, graph=graph,
        )
        analyzer = SocialAnalyzer(storage, graph)
        doc_intel = DocumentIntelligence()

        # Auto-load scenario if specified
        if args.scenario:
            from nexus_social.core.scenarios import SCENARIOS, NARRATIVE_ARCS, ScenarioBuilder
            if args.scenario in SCENARIOS:
                config = SCENARIOS[args.scenario]
                builder = ScenarioBuilder()
                _, agents = builder.build(config)
                arc = NARRATIVE_ARCS.get(config.name)
                runner = SimulationRunner(
                    OASISBridge(
                        db_path=f"./data/{config.name.lower().replace(' ', '_')}.db",
                        storage=storage,
                    ),
                    NarrativeEngine(arc), memory, storage=storage, graph=graph,
                )
                analyzer = SocialAnalyzer(storage, graph)
                await runner.initialize(agents)
                logging.info(f"Loaded scenario: {config.name} ({len(agents)} agents)")
            else:
                logging.warning(f"Scenario '{args.scenario}' not found")

        return create_app(runner, analyzer, doc_intel, storage=storage)

    app = asyncio.run(_build_app())

    print(f"\n  NexusSocial v0.2.0")
    print(f"  API:    http://{args.host}:{args.port}")
    print(f"  Docs:   http://{args.host}:{args.port}/docs")
    print(f"  WS:     ws://{args.host}:{args.port}/ws/simulation")
    print(f"  DB:     {args.surreal_url}\n")

    uvicorn.run(app, host=args.host, port=args.port)


async def _cmd_run(args):
    """Run a simulation headless and output results."""
    from nexus_social.core.memory import MemorySystem
    from nexus_social.core.narrative import NarrativeEngine
    from nexus_social.core.scenarios import SCENARIOS, NARRATIVE_ARCS, ScenarioBuilder
    from nexus_social.oasis_engine.bridge import OASISBridge
    from nexus_social.oasis_engine.runner import SimulationRunner
    from nexus_social.storage.graph import GraphAnalytics
    from nexus_social.storage.surrealdb import SurrealStorage

    if args.scenario not in SCENARIOS:
        print(f"Unknown scenario: {args.scenario}")
        print(f"Available: {', '.join(SCENARIOS.keys())}")
        sys.exit(1)

    config = SCENARIOS[args.scenario]
    builder = ScenarioBuilder()
    orgs, agents = builder.build(config)
    arc = NARRATIVE_ARCS.get(config.name)

    storage = SurrealStorage(url=args.surreal_url, database="nexus_run")
    await storage.connect()
    graph = GraphAnalytics(storage)

    bridge = OASISBridge(
        db_path=f"./data/{config.name.lower().replace(' ', '_')}.db",
        storage=storage,
    )
    memory = MemorySystem()
    runner = SimulationRunner(
        bridge, NarrativeEngine(arc), memory, storage=storage, graph=graph,
    )

    print(f"Scenario: {config.name}")
    print(f"Agents: {len(agents)}, Orgs: {len(orgs)}")
    print(f"Running {args.ticks} ticks...\n")

    await runner.initialize(agents)
    results = await runner.run(args.ticks, callback=lambda s: print(
        f"  Tick {s['tick']}: {s['active_agents']} active, "
        f"{s['new_posts']} posts, {len(s.get('emergent_patterns', []))} patterns"
    ))

    # Summary
    print(f"\n--- Results ---")
    observer = runner.get_observer_summary()
    print(f"Patterns detected: {observer['total_patterns']}")
    for ptype, patterns in observer.get("by_type", {}).items():
        print(f"  {ptype}: {len(patterns)}")

    influence = await runner.get_influence_rankings()
    if influence:
        print(f"\nTop influencers:")
        for r in influence[:5]:
            print(f"  {r['name']} ({r['org']}) — PR: {r['pagerank']:.4f}")

    communities = await runner.get_communities()
    if communities:
        print(f"\nCommunities: {len(communities)}")
        for c in communities:
            print(f"  [{c['size']} agents] {c['dominant_org']}: {', '.join(c['agents'][:5])}")

    # Write output
    if args.output:
        import json
        output = {
            "scenario": config.name,
            "ticks": args.ticks,
            "results": results,
            "observer": observer,
            "influence": influence[:10] if influence else [],
            "communities": communities,
        }
        with open(args.output, "w") as f:
            json.dump(output, f, indent=2, default=str)
        print(f"\nResults written to {args.output}")

    await runner.shutdown()
    await storage.close()


async def _cmd_ingest(args):
    """Document mode — ingest a document and run simulation."""
    from nexus_social.core.memory import MemorySystem
    from nexus_social.core.narrative import NarrativeEngine
    from nexus_social.documents.graphrag import GraphRAGProcessor
    from nexus_social.oasis_engine.bridge import OASISBridge
    from nexus_social.oasis_engine.runner import SimulationRunner
    from nexus_social.storage.graph import GraphAnalytics
    from nexus_social.storage.surrealdb import SurrealStorage

    with open(args.doc) as f:
        text = f.read()

    print(f"Document: {args.doc} ({len(text)} chars)")

    storage = SurrealStorage(url=args.surreal_url, database="nexus_doc")
    await storage.connect()
    graph = GraphAnalytics(storage)

    graphrag = GraphRAGProcessor(llm_extract=args.use_llm)

    bridge = OASISBridge(db_path="./data/doc_simulation.db", storage=storage)
    memory = MemorySystem()
    runner = SimulationRunner(
        bridge, NarrativeEngine(), memory,
        storage=storage, graph=graph, graphrag=graphrag,
    )

    # Ingest document
    result = await runner.ingest_document(text, doc_id=args.doc, use_llm=args.use_llm)

    if result.get("mode") == "llm":
        print("LLM extraction prompt generated. Send to your LLM and use the API to continue.")
        print(f"Prompt:\n{result['prompt'][:500]}...")
        return

    print(f"Extracted: {result.get('entities', 0)} entities, "
          f"{result.get('relations', 0)} relations")
    print(f"Topics: {', '.join(result.get('topics', [])[:10])}")

    if args.ticks > 0:
        print(f"\nRunning {args.ticks} ticks...")
        # Note: agents need to be loaded separately for doc mode
        # This is the knowledge graph seeding — agents come from scenario or are auto-generated
        print("(Document ingested into knowledge graph. Load a scenario to run with agents.)")

    await storage.close()


def _cmd_scenarios():
    """List available scenarios."""
    from nexus_social.core.scenarios import list_scenarios
    scenarios = list_scenarios()
    print("Available scenarios:\n")
    for s in scenarios:
        print(f"  {s['name']}")
        print(f"    {s.get('description', '')}")
        print(f"    Category: {s.get('category', 'general')}")
        print()


if __name__ == "__main__":
    main()
