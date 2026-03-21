"""FastAPI server for the NexusSocial platform.

Fully async — no sync wrappers. Native WebSocket support for real-time
simulation streaming. Auto-generated OpenAPI docs at /docs.

WebSocket streams:
- /ws/simulation — live tick updates as simulation runs
- /ws/observer — real-time emergent pattern alerts
- /ws/agent/{agent_id} — watch a specific agent's activity
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query, Body, HTTPException
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

from nexus_social.core.counterfactual import CounterfactualEngine
from nexus_social.core.memory import MemorySystem
from nexus_social.core.narrative import NarrativeEngine
from nexus_social.core.observer import ObserverAgent
from nexus_social.documents.intelligence import DocumentIntelligence
from nexus_social.oasis_engine.analysis import SocialAnalyzer
from nexus_social.oasis_engine.bridge import OASISBridge
from nexus_social.oasis_engine.runner import SimulationRunner
from nexus_social.storage.graph import GraphAnalytics
from nexus_social.storage.surrealdb import SurrealStorage

logger = logging.getLogger(__name__)


class ConnectionManager:
    """Manages WebSocket connections for real-time streaming."""

    def __init__(self):
        self.simulation_clients: list[WebSocket] = []
        self.observer_clients: list[WebSocket] = []
        self.agent_clients: dict[str, list[WebSocket]] = {}  # agent_id -> [ws]

    async def connect_simulation(self, ws: WebSocket):
        await ws.accept()
        self.simulation_clients.append(ws)

    async def connect_observer(self, ws: WebSocket):
        await ws.accept()
        self.observer_clients.append(ws)

    async def connect_agent(self, ws: WebSocket, agent_id: str):
        await ws.accept()
        if agent_id not in self.agent_clients:
            self.agent_clients[agent_id] = []
        self.agent_clients[agent_id].append(ws)

    def disconnect_simulation(self, ws: WebSocket):
        self.simulation_clients = [c for c in self.simulation_clients if c != ws]

    def disconnect_observer(self, ws: WebSocket):
        self.observer_clients = [c for c in self.observer_clients if c != ws]

    def disconnect_agent(self, ws: WebSocket, agent_id: str):
        if agent_id in self.agent_clients:
            self.agent_clients[agent_id] = [
                c for c in self.agent_clients[agent_id] if c != ws
            ]

    async def broadcast_tick(self, tick_data: dict):
        """Broadcast tick summary to all simulation watchers."""
        dead = []
        for ws in self.simulation_clients:
            try:
                await ws.send_json(tick_data)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect_simulation(ws)

    async def broadcast_patterns(self, patterns: list[dict]):
        """Broadcast emergent patterns to observer watchers."""
        if not patterns:
            return
        dead = []
        for ws in self.observer_clients:
            try:
                await ws.send_json({"patterns": patterns})
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect_observer(ws)

    async def broadcast_agent_activity(self, agent_id: str, activity: dict):
        """Broadcast activity for a specific agent."""
        clients = self.agent_clients.get(agent_id, [])
        dead = []
        for ws in clients:
            try:
                await ws.send_json(activity)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect_agent(ws, agent_id)


# Global state
_state: dict[str, Any] = {}
_ws = ConnectionManager()


def _runner() -> SimulationRunner:
    return _state["runner"]


def _analyzer() -> SocialAnalyzer:
    return _state["analyzer"]


def _storage() -> SurrealStorage | None:
    return _state.get("storage")


def create_app(
    runner: SimulationRunner,
    analyzer: SocialAnalyzer,
    doc_intel: DocumentIntelligence,
    storage: SurrealStorage | None = None,
) -> FastAPI:
    """Create the FastAPI application."""

    _state["runner"] = runner
    _state["analyzer"] = analyzer
    _state["doc_intel"] = doc_intel
    _state["storage"] = storage

    app = FastAPI(
        title="NexusSocial",
        description="Multi-agent social simulation platform",
        version="0.2.0",
    )

    # Static files
    static_dir = os.path.join(os.path.dirname(__file__), "static")
    template_dir = os.path.join(os.path.dirname(__file__), "templates")
    if os.path.isdir(static_dir):
        app.mount("/static", StaticFiles(directory=static_dir), name="static")

    # ── Health & System ──────────────────────────────────────────────

    @app.get("/api/health")
    async def health():
        return {
            "status": "ok",
            "version": "0.2.0",
            "tick": _runner().tick_count,
            "agents": len(_runner().bridge._profile_map),
            "patterns": len(_runner().get_all_patterns()),
            "storage": _storage() is not None,
        }

    @app.post("/api/reset")
    async def reset():
        """Reset simulation state (tick counter, logs, observer, counterfactual)."""
        runner = _runner()
        runner.tick_count = 0
        runner.tick_log.clear()
        runner.observer = ObserverAgent(window_size=10)
        runner.counterfactual = CounterfactualEngine()
        runner._last_post_count = 0
        runner._last_comment_count = 0
        return {"reset": True, "tick": 0}

    # ── Pages ───────────────────────────────────────────────────────

    @app.get("/", response_class=HTMLResponse)
    async def index():
        index_path = os.path.join(template_dir, "index.html")
        if os.path.exists(index_path):
            with open(index_path) as f:
                return HTMLResponse(f.read())
        return HTMLResponse("<h1>NexusSocial</h1><p>API docs at <a href='/docs'>/docs</a></p>")

    # ── Social Feed & Simulation ────────────────────────────────────

    @app.get("/api/feed")
    async def feed(limit: int = 50):
        return await _analyzer().get_feed(limit=limit)

    @app.get("/api/analytics")
    async def analytics():
        return await _analyzer().get_analytics()

    @app.get("/api/network")
    async def network():
        return await _analyzer().get_network_graph()

    @app.get("/api/events")
    async def events(limit: int = 100):
        log = _runner().tick_log[-limit:]
        return list(reversed(log))

    @app.get("/api/agents")
    async def agents():
        return await _analyzer().get_agent_details()

    @app.post("/api/simulate")
    async def simulate(ticks: int = Body(1, embed=True)):
        ticks = min(ticks, 20)

        async def tick_callback(summary):
            # Stream each tick to WebSocket clients
            await _ws.broadcast_tick(summary)
            # Stream patterns
            patterns = summary.get("emergent_patterns", [])
            await _ws.broadcast_patterns(patterns)
            # Stream per-agent decisions
            for decision in summary.get("decisions", []):
                await _ws.broadcast_agent_activity(
                    decision["agent"], decision
                )

        results = await _runner().run(ticks, callback=tick_callback)

        return {
            "ticks_run": ticks,
            "tick_results": results,
            "analytics": await _analyzer().get_analytics(),
        }

    # ── Analysis ────────────────────────────────────────────────────

    @app.get("/api/analysis/geo")
    async def geo_breakdown():
        return await _analyzer().get_geo_breakdown()

    @app.get("/api/analysis/factions")
    async def faction_analysis():
        return await _analyzer().get_faction_analysis()

    @app.get("/api/analysis/narrative")
    async def narrative_state():
        return _runner().narrative.to_dict()

    @app.get("/api/analysis/memory")
    async def memory_state():
        return _runner().memory.to_dict()

    @app.get("/api/analysis/narrative-spread")
    async def narrative_spread(keyword: str = Query(...)):
        return await _analyzer().get_narrative_spread(keyword)

    @app.get("/api/analysis/cross-org")
    async def cross_org_interactions():
        return await _analyzer().get_cross_org_interactions()

    # ── Observer Agent ──────────────────────────────────────────────

    @app.get("/api/observer/summary")
    async def observer_summary():
        return _runner().get_observer_summary()

    @app.get("/api/observer/patterns")
    async def observer_patterns():
        return _runner().get_all_patterns()

    # ── Graph Analytics (igraph) ────────────────────────────────────

    @app.get("/api/graph/influence")
    async def influence_rankings():
        return await _runner().get_influence_rankings()

    @app.get("/api/graph/communities")
    async def communities(method: str = "louvain"):
        return await _analyzer().get_communities(method=method)

    @app.get("/api/graph/bridges")
    async def bridge_agents():
        return await _analyzer().get_bridge_agents()

    @app.get("/api/graph/stress-clusters")
    async def stress_clusters():
        return await _analyzer().get_stress_clusters()

    @app.post("/api/graph/influence-spread")
    async def influence_spread(agent_id: str = Body(...), threshold: float = Body(0.3)):
        return await _analyzer().get_influence_spread(agent_id, threshold=threshold)

    # ── Counterfactual Injection ────────────────────────────────────

    @app.post("/api/inject")
    async def inject(
        type: str = Body("custom"),
        description: str = Body(...),
        tick: int | None = Body(None),
        target_orgs: list[str] = Body(default=[]),
        target_agents: list[str] = Body(default=[]),
    ):
        kwargs = {}
        if target_orgs:
            kwargs["target_orgs"] = target_orgs
        if target_agents:
            kwargs["target_agents"] = target_agents
        result = await _runner().inject(type, description, tick=tick, **kwargs)
        return result

    @app.get("/api/inject/history")
    async def injection_history():
        return _runner().counterfactual.get_history()

    # ── Document Mode (GraphRAG) ────────────────────────────────────

    @app.post("/api/documents/ingest")
    async def ingest_document(
        text: str = Body(...),
        doc_id: str = Body("uploaded"),
        use_llm: bool = Body(False),
    ):
        return await _runner().ingest_document(
            text=text, doc_id=doc_id, use_llm=use_llm,
        )

    @app.get("/api/documents/knowledge-graph")
    async def doc_knowledge_graph():
        if _runner().graphrag:
            return _runner().graphrag.knowledge_graph.to_dict()
        return _state["doc_intel"].get_knowledge_graph()

    @app.get("/api/documents/timeline")
    async def doc_timeline():
        return _state["doc_intel"].get_document_timeline()

    @app.get("/api/documents/topics")
    async def doc_topics():
        return _state["doc_intel"].get_trending_topics()

    @app.get("/api/documents/org-stats")
    async def doc_org_stats():
        return _state["doc_intel"].get_org_document_stats()

    # ── Scenario Builder ────────────────────────────────────────────

    @app.get("/api/scenarios")
    async def get_scenarios():
        from nexus_social.core.scenarios import list_scenarios
        return list_scenarios()

    @app.get("/api/scenarios/{name}")
    async def get_scenario(name: str):
        from nexus_social.core.scenarios import SCENARIOS
        if name not in SCENARIOS:
            raise HTTPException(404, f"Scenario '{name}' not found")
        return SCENARIOS[name].to_dict()

    @app.post("/api/scenarios/load")
    async def load_scenario(data: dict = Body(...)):
        from nexus_social.core.scenarios import SCENARIOS, ScenarioBuilder, ScenarioConfig, NARRATIVE_ARCS

        scenario_name = data.get("name")
        if scenario_name and scenario_name in SCENARIOS:
            config = SCENARIOS[scenario_name]
        else:
            config = ScenarioConfig.from_dict(data)

        builder = ScenarioBuilder()
        orgs, agents_list = builder.build(config)

        arc = NARRATIVE_ARCS.get(config.name)
        db_name = config.name.lower().replace(" ", "_").replace("-", "_")

        # Create fresh SurrealDB
        new_storage = SurrealStorage(url="mem://", database=db_name)
        await new_storage.connect()
        new_graph = GraphAnalytics(new_storage)

        bridge = OASISBridge(
            db_path=f"./data/{db_name}.db",
            storage=new_storage,
        )
        narrative = NarrativeEngine(arc)
        memory = MemorySystem()
        new_runner = SimulationRunner(
            bridge, narrative, memory,
            storage=new_storage, graph=new_graph,
        )
        new_analyzer = SocialAnalyzer(new_storage, new_graph)

        await new_runner.initialize(agents_list)

        _state["runner"] = new_runner
        _state["analyzer"] = new_analyzer
        _state["storage"] = new_storage
        _state["doc_intel"] = DocumentIntelligence()

        return {
            "loaded": config.name,
            "organizations": len(orgs),
            "agents": len(agents_list),
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
        }

    @app.get("/api/persona-templates")
    async def get_persona_templates():
        from nexus_social.core.scenarios import list_persona_templates
        return list_persona_templates()

    @app.get("/api/scenario/export")
    async def export_scenario():
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
                            "name": loc.name, "city": loc.city,
                            "country": loc.country, "timezone": loc.timezone,
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
                    (i for i, loc in enumerate(org.locations) if loc.id == team.location.id), 0
                )
                org_data["teams"][team.id] = {
                    "name": team.name, "location_index": loc_idx,
                    "focus": team.focus, "agents": [],
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

        return {
            "name": "Exported Scenario",
            "description": "Exported from running simulation",
            "category": "custom",
            "organizations": orgs_data,
        }

    # ── WebSocket Streams ───────────────────────────────────────────

    @app.websocket("/ws/simulation")
    async def ws_simulation(websocket: WebSocket):
        """Stream live tick updates as simulation runs."""
        await _ws.connect_simulation(websocket)
        try:
            while True:
                # Keep alive — client can also send commands
                data = await websocket.receive_text()
                if data == "ping":
                    await websocket.send_text("pong")
                elif data.startswith("run:"):
                    # Client can trigger ticks: "run:5"
                    try:
                        ticks = min(int(data.split(":")[1]), 20)
                    except (ValueError, IndexError):
                        ticks = 1

                    async def ws_callback(summary):
                        await _ws.broadcast_tick(summary)
                        patterns = summary.get("emergent_patterns", [])
                        await _ws.broadcast_patterns(patterns)

                    await _runner().run(ticks, callback=ws_callback)
        except WebSocketDisconnect:
            _ws.disconnect_simulation(websocket)

    @app.websocket("/ws/observer")
    async def ws_observer(websocket: WebSocket):
        """Stream real-time emergent pattern alerts."""
        await _ws.connect_observer(websocket)
        try:
            # Send existing patterns on connect
            existing = _runner().get_all_patterns()
            if existing:
                await websocket.send_json({"patterns": existing[-10:]})
            while True:
                data = await websocket.receive_text()
                if data == "ping":
                    await websocket.send_text("pong")
        except WebSocketDisconnect:
            _ws.disconnect_observer(websocket)

    @app.websocket("/ws/agent/{agent_id}")
    async def ws_agent(websocket: WebSocket, agent_id: str):
        """Watch a specific agent's activity in real-time."""
        await _ws.connect_agent(websocket, agent_id)
        try:
            while True:
                data = await websocket.receive_text()
                if data == "ping":
                    await websocket.send_text("pong")
        except WebSocketDisconnect:
            _ws.disconnect_agent(websocket, agent_id)

    return app
