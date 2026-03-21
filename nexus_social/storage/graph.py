"""igraph analytics layer — heavy graph algorithms on top of SurrealDB.

SurrealDB handles persistence and graph traversal queries.
igraph handles the algorithms SurrealDB doesn't have built-in:
PageRank, community detection (Louvain/Leiden), centrality metrics,
influence scoring, and topology generation.

Reads from SurrealDB, computes in-memory, results can be written back.
"""

from __future__ import annotations

import logging
from typing import Any

import igraph as ig

logger = logging.getLogger(__name__)


class GraphAnalytics:
    """In-memory graph analytics using igraph.

    Builds an igraph.Graph from SurrealDB data, runs algorithms,
    and returns results. Rebuilt on each call to ensure freshness.
    """

    def __init__(self, storage: Any = None):
        """Initialize with a SurrealStorage instance."""
        self.storage = storage
        self._graph: ig.Graph | None = None

    async def build_graph(self) -> ig.Graph:
        """Build an igraph.Graph from SurrealDB relationship data."""
        if not self.storage:
            raise RuntimeError("No storage backend configured")

        network = await self.storage.get_network_graph()
        nodes = network.get("nodes", [])
        edges = network.get("edges", [])

        g = ig.Graph(directed=True)

        # Add vertices with attributes
        id_map = {}
        for i, node in enumerate(nodes):
            if not isinstance(node, dict):
                continue
            raw_id = node.get("id", "")
            node_id = str(raw_id)
            # Strip SurrealDB record prefix if present
            if ":" in node_id:
                node_id = node_id.split(":", 1)[1]
            id_map[node_id] = i
            g.add_vertex(
                name=node_id,
                label=node.get("name", ""),
                org=node.get("org", ""),
                team=node.get("team", ""),
                role=node.get("role", ""),
                location=node.get("location", ""),
                country=node.get("country", ""),
                stress=node.get("stress", 0.0),
                morale=node.get("morale", 0.5),
            )

        # Add edges with attributes
        for edge in edges:
            source = str(edge.get("source", ""))
            target = str(edge.get("target", ""))
            if ":" in source:
                source = source.split(":", 1)[1]
            if ":" in target:
                target = target.split(":", 1)[1]

            if source in id_map and target in id_map:
                attrs = {}
                if "trust" in edge:
                    attrs["trust"] = edge["trust"]
                    attrs["respect"] = edge.get("respect", 0.5)
                    attrs["warmth"] = edge.get("warmth", 0.4)
                    attrs["tension"] = edge.get("tension", 0.0)
                    attrs["weight"] = edge.get("weight", 1)
                    attrs["edge_type"] = "trust"
                elif edge.get("type") == "follows":
                    attrs["weight"] = 1
                    attrs["edge_type"] = "follows"

                g.add_edge(id_map[source], id_map[target], **attrs)

        self._graph = g
        logger.info(f"Built igraph: {g.vcount()} vertices, {g.ecount()} edges")
        return g

    @property
    def graph(self) -> ig.Graph:
        if self._graph is None:
            raise RuntimeError("Graph not built. Call build_graph() first.")
        return self._graph

    # ── Influence & Centrality ──────────────────────────────────────

    async def pagerank(self, damping: float = 0.85) -> list[dict]:
        """Compute PageRank — who has the most influence in the network."""
        g = await self.build_graph()
        if g.vcount() == 0:
            return []

        weights = g.es["weight"] if "weight" in g.es.attributes() else None
        scores = g.pagerank(damping=damping, weights=weights)

        results = []
        for i, score in enumerate(scores):
            results.append({
                "agent_id": g.vs[i]["name"],
                "name": g.vs[i]["label"],
                "org": g.vs[i]["org"],
                "pagerank": round(score, 6),
            })
        return sorted(results, key=lambda x: x["pagerank"], reverse=True)

    async def betweenness_centrality(self) -> list[dict]:
        """Find bridge agents — those connecting different communities."""
        g = await self.build_graph()
        if g.vcount() == 0:
            return []

        scores = g.betweenness()
        max_score = max(scores) if scores and max(scores) > 0 else 1

        results = []
        for i, score in enumerate(scores):
            results.append({
                "agent_id": g.vs[i]["name"],
                "name": g.vs[i]["label"],
                "org": g.vs[i]["org"],
                "betweenness": round(score / max_score, 4),
            })
        return sorted(results, key=lambda x: x["betweenness"], reverse=True)

    async def closeness_centrality(self) -> list[dict]:
        """Who can reach everyone else fastest — information hubs."""
        g = await self.build_graph()
        if g.vcount() == 0:
            return []

        scores = g.closeness()

        results = []
        for i, score in enumerate(scores):
            results.append({
                "agent_id": g.vs[i]["name"],
                "name": g.vs[i]["label"],
                "org": g.vs[i]["org"],
                "closeness": round(score, 4) if score is not None else 0,
            })
        return sorted(results, key=lambda x: x["closeness"], reverse=True)

    # ── Community Detection ─────────────────────────────────────────

    async def detect_communities(self, method: str = "louvain") -> list[dict]:
        """Detect communities — groups that interact more internally.

        Methods: 'louvain' (default), 'leiden', 'label_propagation'
        """
        g = await self.build_graph()
        if g.vcount() == 0:
            return []

        # Work on undirected copy for community detection
        g_undirected = g.as_undirected(mode="collapse")
        weights = (g_undirected.es["weight"]
                   if "weight" in g_undirected.es.attributes() else None)

        if method == "leiden":
            partition = g_undirected.community_leiden(
                objective_function="modularity", weights=weights
            )
        elif method == "label_propagation":
            partition = g_undirected.community_label_propagation(weights=weights)
        else:
            partition = g_undirected.community_multilevel(weights=weights)

        results = []
        for i, community_id in enumerate(partition.membership):
            results.append({
                "agent_id": g.vs[i]["name"],
                "name": g.vs[i]["label"],
                "org": g.vs[i]["org"],
                "community": community_id,
            })

        return results

    async def community_summary(self, method: str = "louvain") -> list[dict]:
        """Summarize detected communities — size, dominant org, cohesion."""
        members = await self.detect_communities(method)
        if not members:
            return []

        communities: dict[int, list[dict]] = {}
        for m in members:
            cid = m["community"]
            if cid not in communities:
                communities[cid] = []
            communities[cid].append(m)

        summaries = []
        for cid, agents in communities.items():
            orgs = [a["org"] for a in agents]
            org_counts = {}
            for o in orgs:
                org_counts[o] = org_counts.get(o, 0) + 1
            dominant_org = max(org_counts, key=org_counts.get)

            summaries.append({
                "community_id": cid,
                "size": len(agents),
                "agents": [a["name"] for a in agents],
                "dominant_org": dominant_org,
                "org_breakdown": org_counts,
                "is_cross_org": len(org_counts) > 1,
            })

        return sorted(summaries, key=lambda x: x["size"], reverse=True)

    # ── Influence Propagation ───────────────────────────────────────

    async def simulate_influence_spread(self, seed_agent_id: str,
                                        threshold: float = 0.3,
                                        max_steps: int = 5) -> list[dict]:
        """Simulate how influence/information spreads from a seed agent.

        Uses trust-weighted cascade: an agent is 'influenced' if the
        combined trust from already-influenced neighbors exceeds threshold.

        Returns the spread timeline: which agents get influenced at each step.
        """
        g = await self.build_graph()
        if g.vcount() == 0:
            return []

        # Find seed vertex
        try:
            seed_idx = g.vs.find(name=seed_agent_id).index
        except ValueError:
            return []

        influenced = {seed_idx}
        timeline = [{
            "step": 0,
            "newly_influenced": [{
                "agent_id": g.vs[seed_idx]["name"],
                "name": g.vs[seed_idx]["label"],
                "org": g.vs[seed_idx]["org"],
            }],
        }]

        for step in range(1, max_steps + 1):
            newly = set()
            for v_idx in range(g.vcount()):
                if v_idx in influenced:
                    continue

                # Sum trust from influenced neighbors
                incoming_trust = 0.0
                for e_idx in g.incident(v_idx, mode="in"):
                    edge = g.es[e_idx]
                    source = edge.source
                    if source in influenced and "trust" in edge.attributes():
                        trust_val = edge["trust"]
                        if trust_val is not None:
                            incoming_trust += trust_val

                if incoming_trust >= threshold:
                    newly.add(v_idx)

            if not newly:
                break

            influenced |= newly
            timeline.append({
                "step": step,
                "newly_influenced": [{
                    "agent_id": g.vs[i]["name"],
                    "name": g.vs[i]["label"],
                    "org": g.vs[i]["org"],
                } for i in newly],
            })

        return timeline

    # ── Topology Generation ─────────────────────────────────────────

    @staticmethod
    def generate_realistic_topology(n_agents: int,
                                    topology: str = "barabasi_albert",
                                    **kwargs) -> list[tuple[int, int]]:
        """Generate a realistic social network topology.

        Returns a list of (source, target) edges to seed follow relationships.

        Topologies:
            - 'barabasi_albert': Scale-free (few hubs, many peripheral) — most
              realistic for social networks. Power-law degree distribution.
            - 'watts_strogatz': Small-world (high clustering, short paths).
            - 'erdos_renyi': Random baseline.
        """
        if topology == "watts_strogatz":
            k = kwargs.get("k", min(6, n_agents - 1))
            p = kwargs.get("p", 0.3)
            g = ig.Graph.Watts_Strogatz(1, n_agents, k // 2, p)
        elif topology == "erdos_renyi":
            p = kwargs.get("p", 0.1)
            g = ig.Graph.Erdos_Renyi(n_agents, p, directed=True)
        else:
            m = kwargs.get("m", min(3, n_agents - 1))
            g = ig.Graph.Barabasi(n_agents, m, directed=True)

        return [(e.source, e.target) for e in g.es]

    # ── Stress & Morale Analysis ────────────────────────────────────

    async def stress_clusters(self) -> list[dict]:
        """Find clusters of high-stress agents — stress contagion zones."""
        g = await self.build_graph()
        if g.vcount() == 0:
            return []

        high_stress = [v.index for v in g.vs if v["stress"] > 0.6]
        if not high_stress:
            return []

        # Find connected components among high-stress agents
        subgraph = g.subgraph(high_stress)
        components = subgraph.connected_components(mode="weak")

        clusters = []
        for comp in components:
            agents = [subgraph.vs[i] for i in comp]
            clusters.append({
                "size": len(agents),
                "agents": [{"name": a["label"], "org": a["org"],
                            "stress": a["stress"]} for a in agents],
                "avg_stress": sum(a["stress"] for a in agents) / len(agents),
                "orgs": list(set(a["org"] for a in agents)),
            })

        return sorted(clusters, key=lambda x: x["size"], reverse=True)
