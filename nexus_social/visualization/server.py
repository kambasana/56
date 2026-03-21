"""Web server for the NexusSocial visualization dashboard."""

from __future__ import annotations

import json
import logging
import os
from typing import TYPE_CHECKING

from flask import Flask, jsonify, render_template, request

from nexus_social.camel_engine.brain import CamelBrain
from nexus_social.core.scenarios import (
    SCENARIOS,
    ScenarioBuilder,
    ScenarioConfig,
    list_persona_templates,
    list_scenarios,
)
from nexus_social.documents.intelligence import DocumentIntelligence
from nexus_social.social.platform import SocialPlatform

logger = logging.getLogger(__name__)

# Global state for hot-swapping scenarios
_state: dict = {}


def create_app(
    platform: SocialPlatform,
    doc_intel: DocumentIntelligence,
    brain: CamelBrain | None = None,
) -> Flask:
    """Create and configure the Flask application."""

    template_dir = os.path.join(os.path.dirname(__file__), "templates")
    static_dir = os.path.join(os.path.dirname(__file__), "static")
    app = Flask(__name__, template_folder=template_dir, static_folder=static_dir)

    _state["platform"] = platform
    _state["doc_intel"] = doc_intel
    _state["brain"] = brain or CamelBrain()

    def _platform() -> SocialPlatform:
        return _state["platform"]

    def _doc_intel() -> DocumentIntelligence:
        return _state["doc_intel"]

    @app.route("/")
    def index():
        return render_template("index.html")

    # === Social Feed & Simulation ===

    @app.route("/api/feed")
    def feed():
        limit = request.args.get("limit", 50, type=int)
        return jsonify(_platform().get_feed(limit=limit))

    @app.route("/api/analytics")
    def analytics():
        return jsonify(_platform().get_analytics())

    @app.route("/api/network")
    def network():
        return jsonify(_platform().get_network_graph())

    @app.route("/api/events")
    def events():
        limit = request.args.get("limit", 100, type=int)
        recent = _platform().events[-limit:]
        return jsonify([e.to_dict() for e in reversed(recent)])

    @app.route("/api/agents")
    def agents():
        p = _platform()
        return jsonify([
            {
                "id": a.id,
                "name": a.name,
                "role": a.role.value,
                "org": a.org.name,
                "team": a.team.name,
                "location": a.location.city,
                "activity_level": a.activity_level,
                "traits": a.personality_traits,
                "expertise": a.expertise,
                "persona": getattr(a, "_persona", None).to_dict() if getattr(a, "_persona", None) else None,
            }
            for a in p.agents
        ])

    @app.route("/api/simulate", methods=["POST"])
    def simulate():
        p = _platform()
        di = _doc_intel()
        ticks = request.json.get("ticks", 1) if request.json else 1
        ticks = min(ticks, 20)
        all_events = []
        for _ in range(ticks):
            evts = p.simulate_tick()
            all_events.extend(evts)

        for doc in p.documents:
            if doc not in di.documents:
                di.ingest(doc)

        return jsonify({
            "ticks_run": ticks,
            "events": [e.to_dict() for e in all_events],
            "analytics": p.get_analytics(),
        })

    # === Documents ===

    @app.route("/api/documents/timeline")
    def doc_timeline():
        return jsonify(_doc_intel().get_document_timeline())

    @app.route("/api/documents/topics")
    def doc_topics():
        return jsonify(_doc_intel().get_trending_topics())

    @app.route("/api/documents/knowledge-graph")
    def doc_knowledge_graph():
        return jsonify(_doc_intel().get_knowledge_graph())

    @app.route("/api/documents/org-stats")
    def doc_org_stats():
        return jsonify(_doc_intel().get_org_document_stats())

    # === Scenario Builder API ===

    @app.route("/api/scenarios")
    def get_scenarios():
        """List all pre-made scenarios."""
        return jsonify(list_scenarios())

    @app.route("/api/scenarios/<name>")
    def get_scenario(name):
        """Get full config for a specific scenario."""
        if name not in SCENARIOS:
            return jsonify({"error": f"Scenario '{name}' not found"}), 404
        return jsonify(SCENARIOS[name].to_dict())

    @app.route("/api/scenarios/load", methods=["POST"])
    def load_scenario():
        """Load a pre-made or custom scenario - resets the simulation."""
        data = request.json
        if not data:
            return jsonify({"error": "No data provided"}), 400

        # If loading by name
        scenario_name = data.get("name")
        if scenario_name and scenario_name in SCENARIOS:
            config = SCENARIOS[scenario_name]
        else:
            # Custom scenario config
            config = ScenarioConfig.from_dict(data)

        builder = ScenarioBuilder()
        orgs, agents = builder.build(config)

        # Reset platform
        brain = _state["brain"]
        brain._agents.clear()
        new_platform = SocialPlatform(brain)
        new_platform.register_agents(agents)

        new_doc_intel = DocumentIntelligence()

        _state["platform"] = new_platform
        _state["doc_intel"] = new_doc_intel

        return jsonify({
            "loaded": config.name,
            "organizations": len(orgs),
            "agents": len(agents),
            "teams": sum(len(o.teams) for o in orgs),
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
        """List all available persona templates."""
        return jsonify(list_persona_templates())

    @app.route("/api/scenario/export")
    def export_scenario():
        """Export current scenario config (agents, orgs, etc.) as JSON."""
        p = _platform()
        orgs_data = []
        seen_orgs: dict[str, dict] = {}

        for agent in p.agents:
            org = agent.org
            if org.id not in seen_orgs:
                seen_orgs[org.id] = {
                    "name": org.name,
                    "industry": org.industry,
                    "description": org.description,
                    "locations": [
                        {
                            "name": l.name,
                            "city": l.city,
                            "country": l.country,
                            "timezone": l.timezone,
                            "type": l.location_type.value,
                        }
                        for l in org.locations
                    ],
                    "teams": {},
                }

            team = agent.team
            org_data = seen_orgs[org.id]
            if team.id not in org_data["teams"]:
                loc_idx = next(
                    (i for i, l in enumerate(org.locations) if l.id == team.location.id),
                    0,
                )
                org_data["teams"][team.id] = {
                    "name": team.name,
                    "location_index": loc_idx,
                    "focus": team.focus,
                    "agents": [],
                }

            persona = getattr(agent, "_persona", None)
            agent_data = {
                "name": agent.name,
                "role": agent.role.value,
            }
            if persona:
                agent_data.update(persona.to_dict())
                del agent_data["name"]
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
