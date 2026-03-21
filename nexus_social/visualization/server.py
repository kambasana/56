"""Web server for the NexusSocial visualization dashboard."""

from __future__ import annotations

import json
import logging
import os
from typing import TYPE_CHECKING

from flask import Flask, jsonify, render_template, request

if TYPE_CHECKING:
    from nexus_social.documents.intelligence import DocumentIntelligence
    from nexus_social.social.platform import SocialPlatform

logger = logging.getLogger(__name__)


def create_app(
    platform: SocialPlatform,
    doc_intel: DocumentIntelligence,
) -> Flask:
    """Create and configure the Flask application."""

    template_dir = os.path.join(os.path.dirname(__file__), "templates")
    static_dir = os.path.join(os.path.dirname(__file__), "static")
    app = Flask(__name__, template_folder=template_dir, static_folder=static_dir)

    @app.route("/")
    def index():
        return render_template("index.html")

    @app.route("/api/feed")
    def feed():
        limit = request.args.get("limit", 50, type=int)
        return jsonify(platform.get_feed(limit=limit))

    @app.route("/api/analytics")
    def analytics():
        return jsonify(platform.get_analytics())

    @app.route("/api/network")
    def network():
        return jsonify(platform.get_network_graph())

    @app.route("/api/documents")
    def documents():
        return jsonify(platform.get_analytics().get("total_documents", 0))

    @app.route("/api/documents/timeline")
    def doc_timeline():
        return jsonify(doc_intel.get_document_timeline())

    @app.route("/api/documents/topics")
    def doc_topics():
        return jsonify(doc_intel.get_trending_topics())

    @app.route("/api/documents/knowledge-graph")
    def doc_knowledge_graph():
        return jsonify(doc_intel.get_knowledge_graph())

    @app.route("/api/documents/org-stats")
    def doc_org_stats():
        return jsonify(doc_intel.get_org_document_stats())

    @app.route("/api/events")
    def events():
        limit = request.args.get("limit", 100, type=int)
        recent = platform.events[-limit:]
        return jsonify([e.to_dict() for e in reversed(recent)])

    @app.route("/api/agents")
    def agents():
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
            }
            for a in platform.agents
        ])

    @app.route("/api/simulate", methods=["POST"])
    def simulate():
        ticks = request.json.get("ticks", 1) if request.json else 1
        ticks = min(ticks, 20)  # cap at 20 ticks per request
        all_events = []
        for _ in range(ticks):
            events = platform.simulate_tick()
            all_events.extend(events)

        # Sync documents to intelligence
        for doc in platform.documents:
            if doc not in doc_intel.documents:
                doc_intel.ingest(doc)

        return jsonify({
            "ticks_run": ticks,
            "events": [e.to_dict() for e in all_events],
            "analytics": platform.get_analytics(),
        })

    return app
