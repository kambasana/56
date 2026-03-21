"""Storage layer — SurrealDB + igraph for the social platform.

SurrealDB: single source of truth, graph-native persistence.
igraph: in-memory graph algorithms (PageRank, community detection, centrality).
"""

from nexus_social.storage.surrealdb import SurrealStorage
from nexus_social.storage.graph import GraphAnalytics

__all__ = ["SurrealStorage", "GraphAnalytics"]
