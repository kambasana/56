"""Web server for the NexusSocial visualization dashboard.

Powered by OASIS + SurrealDB + igraph + behavior engine + observer agent.
All analysis endpoints are async, querying SurrealDB for graph-native results.
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import TYPE_CHECKING

from flask import Flask, jsonify, render_template, request

from nexus_social.core.memory import MemorySystem
from nexus_social.core.narrative import NarrativeEngine
from nexus_social.core.scenarios import (
    SCENARIOS,
    ScenarioBuilder,
    ScenarioConfig,
    list_persona_templates,
    list_scenarios,
)
from nexus_social.documents.intelligence import DocumentIntelligence
from nexus_social.oasis_engine.analysis import SocialAnalyzer
from nexus_social.oasis_engine.bridge import OASISBridge
from nexus_social.oasis_engine.runner import SimulationRunner
from nexus_social.storage.graph import GraphAnalytics
from nexus_social.storage.surrealdb import SurrealStorage

logger = logging.getLogger(__name__)

# Global state for hot-swapping scenarios
_state: dict = {}


def _run_async(coro):
    """Run an async coroutine from synchronous Flask context."""
    loop = _state.get("loop")
    if loop and loop.is_running():
        future = asyncio.run_coroutine_threadsafe(coro, loop)
        return future.result(timeout=120)
    else:
        return asyncio.run(coro)


def create_app(
    runner: SimulationRunner,
    analyzer: SocialAnalyzer,
    doc_intel: DocumentIntelligence,
    storage: SurrealStorage | None = None,
    loop: asyncio.AbstractEventLoop | None = None,
) -> Flask:
    """Create and configure the Flask application."""

    template_dir = os.path.join(os.path.dirname(__file__), "templates")
    static_dir = os.path.join(os.path.dirname(__file__), "static")
    app = Flask(__name__, template_folder=template_dir, static_folder=static_dir)

    _state["runner"] = runner
    _state["analyzer"] = analyzer
    _state["doc_intel"] = doc_intel
    _state["storage"] = storage
    _state["loop"] = loop

    def _runner() -> SimulationRunner:
        return _state["runner"]

    def _analyzer() -> SocialAnalyzer:
        return _state["analyzer"]

    def _doc_intel() -> DocumentIntelligence:
        return _state["doc_intel"]

    def _storage() -> SurrealStorage | None:
        return _state.get("storage")

    @app.route("/")
    def index():
        return render_template("index.html")

    # === Social Feed & Simulation ===

    @app.route("/api/feed")
    def feed():
        limit = request.args.get("limit", 50, type=int)
        return jsonify(_run_async(_analyzer().get_feed(limit=limit)))

    @app.route("/api/analytics")
    def analytics():
        return jsonify(_run_async(_analyzer().get_analytics()))

    @app.route("/api/network")
    def network():
        return jsonify(_run_async(_analyzer().get_network_graph()))

    @app.route("/api/events")
    def events():
        """Return tick log as events."""
        limit = request.args.get("limit", 100, type=int)
        log = _runner().tick_log[-limit:]
        return jsonify(list(reversed(log)))

    @app.route("/api/agents")
    def agents():
        return jsonify(_run_async(_analyzer().get_agent_details()))

    @app.route("/api/simulate", methods=["POST"])
    def simulate():
        ticks = request.json.get("ticks", 1) if request.json else 1
        ticks = min(ticks, 20)

        results = _run_async(_runner().run(ticks))

        return jsonify({
            "ticks_run": ticks,
            "tick_results": results,
            "analytics": _run_async(_analyzer().get_analytics()),
        })

    # === Analysis ===

    @app.route("/api/analysis/geo")
    def geo_breakdown():
        return jsonify(_run_async(_analyzer().get_geo_breakdown()))

    @app.route("/api/analysis/factions")
    def faction_analysis():
        return jsonify(_run_async(_analyzer().get_faction_analysis()))

    @app.route("/api/analysis/narrative")
    def narrative_state():
        return jsonify(_runner().narrative.to_dict())

    @app.route("/api/analysis/memory")
    def memory_state():
        return jsonify(_runner().memory.to_dict())

    # === Observer Agent (emergent pattern detection) ===

    @app.route("/api/observer/summary")
    def observer_summary():
        """Get the observer agent's current analysis."""
        return jsonify(_runner().get_observer_summary())

    @app.route("/api/observer/patterns")
    def observer_patterns():
        """Get all detected emergent patterns."""
        return jsonify(_runner().get_all_patterns())

    # === Graph Analytics (igraph) ===

    @app.route("/api/graph/influence")
    def influence_rankings():
        """Agent influence rankings via PageRank."""
        return jsonify(_run_async(_runner().get_influence_rankings()))

    @app.route("/api/graph/communities")
    def communities():
        """Detected communities via Louvain/Leiden."""
        method = request.args.get("method", "louvain")
        return jsonify(_run_async(_analyzer().get_communities(method=method)))

    @app.route("/api/graph/bridges")
    def bridge_agents():
        """Bridge agents connecting different communities."""
        return jsonify(_run_async(_analyzer().get_bridge_agents()))

    @app.route("/api/graph/stress-clusters")
    def stress_clusters():
        """Clusters of high-stress agents."""
        return jsonify(_run_async(_analyzer().get_stress_clusters()))

    @app.route("/api/graph/influence-spread", methods=["POST"])
    def influence_spread():
        """Simulate influence spread from a seed agent."""
        data = request.json or {}
        agent_id = data.get("agent_id", "")
        threshold = data.get("threshold", 0.3)
        if not agent_id:
            return jsonify({"error": "agent_id required"}), 400
        return jsonify(_run_async(
            _analyzer().get_influence_spread(agent_id, threshold=threshold)
        ))

    # === Narrative Spread (SurrealDB graph queries) ===

    @app.route("/api/analysis/narrative-spread")
    def narrative_spread():
        """Track how a keyword/narrative spreads through the network."""
        keyword = request.args.get("keyword", "")
        if not keyword:
            return jsonify({"error": "keyword parameter required"}), 400
        return jsonify(_run_async(_analyzer().get_narrative_spread(keyword)))

    @app.route("/api/analysis/cross-org")
    def cross_org_interactions():
        """All interactions between agents of different orgs."""
        return jsonify(_run_async(_analyzer().get_cross_org_interactions()))

    # === Counterfactual Injection ===

    @app.route("/api/inject", methods=["POST"])
    def inject():
        """Inject a counterfactual into the simulation.

        Body: {
            "type": "news_break" | "crisis_event" | "leak" | "agent_defection" | "custom",
            "description": "What happens",
            "tick": optional int (default: next tick),
            ... type-specific params
        }
        """
        data = request.json
        if not data:
            return jsonify({"error": "No data provided"}), 400

        injection_type = data.pop("type", "custom")
        description = data.pop("description", "")
        if not description:
            return jsonify({"error": "description required"}), 400

        result = _run_async(_runner().inject(injection_type, description, **data))
        return jsonify(result)

    @app.route("/api/inject/history")
    def injection_history():
        """Get all applied counterfactual injections."""
        return jsonify(_runner().counterfactual.get_history())

    # === Document Mode (GraphRAG) ===

    @app.route("/api/documents/ingest", methods=["POST"])
    def ingest_document():
        """Ingest a document into the knowledge graph.

        Body: {
            "text": "document content",
            "doc_id": "optional id",
            "use_llm": false  (true for LLM-based extraction)
        }
        """
        data = request.json
        if not data or not data.get("text"):
            return jsonify({"error": "text field required"}), 400

        result = _run_async(_runner().ingest_document(
            text=data["text"],
            doc_id=data.get("doc_id", "uploaded"),
            use_llm=data.get("use_llm", False),
        ))
        return jsonify(result)

    @app.route("/api/documents/knowledge-graph")
    def doc_knowledge_graph():
        """Get the current knowledge graph."""
        if _runner().graphrag:
            return jsonify(_runner().graphrag.knowledge_graph.to_dict())
        return jsonify(_doc_intel().get_knowledge_graph())

    @app.route("/api/documents/timeline")
    def doc_timeline():
        return jsonify(_doc_intel().get_document_timeline())

    @app.route("/api/documents/topics")
    def doc_topics():
        return jsonify(_doc_intel().get_trending_topics())

    @app.route("/api/documents/org-stats")
    def doc_org_stats():
        return jsonify(_doc_intel().get_org_document_stats())

    # === Scenario Builder API ===

    @app.route("/api/scenarios")
    def get_scenarios():
        return jsonify(list_scenarios())

    @app.route("/api/scenarios/<name>")
    def get_scenario(name):
        if name not in SCENARIOS:
            return jsonify({"error": f"Scenario '{name}' not found"}), 404
        return jsonify(SCENARIOS[name].to_dict())

    @app.route("/api/scenarios/load", methods=["POST"])
    def load_scenario():
        """Load a pre-made or custom scenario — resets the simulation."""
        data = request.json
        if not data:
            return jsonify({"error": "No data provided"}), 400

        scenario_name = data.get("name")
        if scenario_name and scenario_name in SCENARIOS:
            config = SCENARIOS[scenario_name]
        else:
            config = ScenarioConfig.from_dict(data)

        builder = ScenarioBuilder()
        orgs, agents = builder.build(config)

        from nexus_social.core.scenarios import NARRATIVE_ARCS
        arc = NARRATIVE_ARCS.get(config.name)

        # Create new SurrealDB storage for this scenario
        db_name = config.name.lower().replace(" ", "_").replace("-", "_")
        new_storage = SurrealStorage(url="mem://", database=db_name)
        _run_async(new_storage.connect())

        new_graph = GraphAnalytics(new_storage)

        # Build new runner with full stack
        bridge = OASISBridge(
            db_path=f"./data/{db_name}.db",
            storage=new_storage,
        )
        narrative = NarrativeEngine(arc)
        memory = MemorySystem()
        new_runner = SimulationRunner(
            bridge, narrative, memory,
            storage=new_storage,
            graph=new_graph,
        )
        new_analyzer = SocialAnalyzer(new_storage, new_graph)

        # Initialize
        _run_async(new_runner.initialize(agents))

        # Update global state
        _state["runner"] = new_runner
        _state["analyzer"] = new_analyzer
        _state["storage"] = new_storage
        _state["doc_intel"] = DocumentIntelligence()

        return jsonify({
            "loaded": config.name,
            "organizations": len(orgs),
            "agents": len(agents),
            "teams": sum(len(o.teams) for o in orgs),
            "has_narrative": arc is not None,
            "orgs": [
                {
                    "name": o.name,
                    "industry": o.industry,
                    "teams": [t.name for t in o.teams],
                    "locations": [l.city for l in o.locations],
                }
                for o in orgs
            ],
        })

    @app.route("/api/persona-templates")
    def get_persona_templates():
        return jsonify(list_persona_templates())

    @app.route("/api/scenario/export")
    def export_scenario():
        """Export current scenario config as JSON."""
        bridge = _runner().bridge
        orgs_data = []
        seen_orgs: dict[str, dict] = {}

        for agent_id, agent in bridge._profile_map.items():
            org = agent.org
            if org.id not in seen_orgs:
                seen_orgs[org.id] = {
                    "name": org.name,
                    "industry": org.industry,
                    "description": org.description,
                    "locations": [
                        {
                            "name": loc.name,
                            "city": loc.city,
                            "country": loc.country,
                            "timezone": loc.timezone,
                            "type": loc.location_type.value,
                        }
                        for loc in org.locations
                    ],
                    "teams": {},
                }

            team = agent.team
            org_data = seen_orgs[org.id]
            if team.id not in org_data["teams"]:
                loc_idx = next(
                    (i for i, loc in enumerate(org.locations) if loc.id == team.location.id),
                    0,
                )
                org_data["teams"][team.id] = {
                    "name": team.name,
                    "location_index": loc_idx,
                    "focus": team.focus,
                    "agents": [],
                }

            persona = bridge.get_persona(agent_id)
            agent_data = {"name": agent.name, "role": agent.role.value}
            if persona:
                agent_data.update(persona.to_dict())
                agent_data["name"] = agent.name

            org_data["teams"][team.id]["agents"].append(agent_data)

        for org_data in seen_orgs.values():
            org_data["teams"] = list(org_data["teams"].values())
            orgs_data.append(org_data)

        config = {
            "name": "Exported Scenario",
            "description": "Exported from running simulation",
            "category": "custom",
            "organizations": orgs_data,
        }
        return jsonify(config)

    return app
