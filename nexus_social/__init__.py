"""NexusSocial — Multi-agent social simulation platform.

Two input modes:
1. Scenario mode: narrative arcs drive agents who generate artifacts organically
2. Document mode: upload docs, GraphRAG extracts knowledge graph, agents react

Stack: OASIS (LLM agents) + SurrealDB (graph persistence) + igraph (algorithms)
"""

__version__ = "0.2.0"

# Core (no external deps beyond stdlib)
from nexus_social.core.behavior import BehaviorEngine, BehaviorDecision, ActivityType
from nexus_social.core.counterfactual import CounterfactualEngine, InjectionType
from nexus_social.core.memory import MemorySystem, AgentMemory, Relationship
from nexus_social.core.narrative import NarrativeEngine, NarrativeArc, NarrativeEvent
from nexus_social.core.observer import ObserverAgent, EmergentPattern
from nexus_social.core.personas import Persona, create_persona_from_template

# Documents (no heavy deps)
from nexus_social.documents.graphrag import GraphRAGProcessor
from nexus_social.documents.intelligence import DocumentIntelligence


def get_storage(**kwargs):
    """Lazy import for SurrealDB storage."""
    from nexus_social.storage.surrealdb import SurrealStorage
    return SurrealStorage(**kwargs)


def get_graph_analytics(storage=None):
    """Lazy import for igraph analytics."""
    from nexus_social.storage.graph import GraphAnalytics
    return GraphAnalytics(storage)


__all__ = [
    # Core
    "BehaviorEngine", "BehaviorDecision", "ActivityType",
    "CounterfactualEngine", "InjectionType",
    "MemorySystem", "AgentMemory", "Relationship",
    "NarrativeEngine", "NarrativeArc", "NarrativeEvent",
    "ObserverAgent", "EmergentPattern",
    "Persona", "create_persona_from_template",
    # Documents
    "GraphRAGProcessor", "DocumentIntelligence",
    # Factory functions (lazy imports)
    "get_storage", "get_graph_analytics",
]
