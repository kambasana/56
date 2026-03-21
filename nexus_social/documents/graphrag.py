"""GraphRAG document processing — MiroFish-inspired knowledge graph extraction.

Two input modes for the platform:
1. Scenario mode (primary): narrative arcs, persona-driven, agents create artifacts
2. Document mode (this): upload a doc, extract knowledge graph, agents react

This module handles mode 2: extracting entities, relationships, and context
from uploaded documents and writing them to SurrealDB as a knowledge graph
that agents can reason against.
"""

from __future__ import annotations

import re
import logging
from collections import Counter
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class Entity:
    """An entity extracted from a document."""
    name: str
    entity_type: str  # "person", "organization", "location", "event", "concept", "technology"
    description: str = ""
    mentions: int = 1
    properties: dict[str, Any] = field(default_factory=dict)


@dataclass
class EntityRelation:
    """A relationship between two entities."""
    source: str       # entity name
    target: str       # entity name
    relation_type: str  # "works_for", "opposes", "allied_with", "located_in", etc.
    description: str = ""
    strength: float = 0.5  # 0-1


@dataclass
class KnowledgeGraph:
    """A knowledge graph extracted from documents."""
    entities: dict[str, Entity] = field(default_factory=dict)
    relations: list[EntityRelation] = field(default_factory=list)
    topics: list[str] = field(default_factory=list)
    source_doc_ids: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "entities": {
                name: {
                    "type": e.entity_type,
                    "description": e.description,
                    "mentions": e.mentions,
                    "properties": e.properties,
                }
                for name, e in self.entities.items()
            },
            "relations": [
                {
                    "source": r.source,
                    "target": r.target,
                    "type": r.relation_type,
                    "description": r.description,
                    "strength": r.strength,
                }
                for r in self.relations
            ],
            "topics": self.topics,
            "sources": self.source_doc_ids,
        }


class GraphRAGProcessor:
    """Extracts knowledge graphs from documents.

    Two modes:
    - LLM-powered extraction (preferred): uses an LLM to identify entities
      and relationships from document text
    - Rule-based extraction (fallback): uses NER patterns and keyword matching

    The extracted knowledge graph gets written to SurrealDB, and agents
    use it as context for their behavior.
    """

    def __init__(self, llm_extract: bool = True):
        self.llm_extract = llm_extract
        self.knowledge_graph = KnowledgeGraph()

        # Common entity patterns for rule-based extraction
        self._org_indicators = {
            "inc", "corp", "ltd", "llc", "group", "agency", "department",
            "ministry", "bureau", "commission", "force", "command",
            "foundation", "institute", "organization", "authority",
        }
        self._role_indicators = {
            "president", "director", "commander", "general", "admiral",
            "secretary", "minister", "ambassador", "chief", "head",
            "ceo", "cto", "cfo", "officer", "analyst", "engineer",
            "advisor", "specialist", "coordinator", "manager",
        }

    def build_llm_extraction_prompt(self, text: str) -> str:
        """Build the prompt for LLM-based entity/relation extraction.

        The caller sends this to their LLM and passes the response to
        parse_llm_extraction().
        """
        return f"""Analyze this document and extract entities and relationships.

DOCUMENT:
{text[:4000]}

Return a JSON object with:
1. "entities": array of {{"name": str, "type": "person|organization|location|event|concept|technology", "description": str}}
2. "relations": array of {{"source": str, "target": str, "type": "works_for|opposes|allied_with|located_in|controls|threatens|supports|created_by|related_to", "description": str, "strength": 0.0-1.0}}
3. "topics": array of key topic strings
4. "sentiment": overall document sentiment ("positive", "negative", "neutral", "alarming", "hopeful")
5. "key_claims": array of the document's main claims or assertions

Return ONLY valid JSON."""

    def parse_llm_extraction(self, llm_response: str,
                             doc_id: str) -> KnowledgeGraph:
        """Parse LLM extraction response into a KnowledgeGraph."""
        import json

        try:
            # Try to extract JSON from the response
            json_match = re.search(r'\{[\s\S]*\}', llm_response)
            if not json_match:
                logger.warning("No JSON found in LLM response, falling back to rule-based")
                return self.knowledge_graph

            data = json.loads(json_match.group())

            for entity_data in data.get("entities", []):
                name = entity_data.get("name", "")
                if not name:
                    continue
                if name in self.knowledge_graph.entities:
                    self.knowledge_graph.entities[name].mentions += 1
                else:
                    self.knowledge_graph.entities[name] = Entity(
                        name=name,
                        entity_type=entity_data.get("type", "concept"),
                        description=entity_data.get("description", ""),
                    )

            for rel_data in data.get("relations", []):
                self.knowledge_graph.relations.append(EntityRelation(
                    source=rel_data.get("source", ""),
                    target=rel_data.get("target", ""),
                    relation_type=rel_data.get("type", "related_to"),
                    description=rel_data.get("description", ""),
                    strength=rel_data.get("strength", 0.5),
                ))

            for topic in data.get("topics", []):
                if topic not in self.knowledge_graph.topics:
                    self.knowledge_graph.topics.append(topic)

            self.knowledge_graph.source_doc_ids.append(doc_id)

        except (json.JSONDecodeError, KeyError) as e:
            logger.error(f"Failed to parse LLM extraction: {e}")

        return self.knowledge_graph

    def extract_rule_based(self, text: str, doc_id: str) -> KnowledgeGraph:
        """Rule-based entity extraction fallback.

        Less accurate than LLM but works without API calls.
        """
        # Extract capitalized phrases as potential entities
        cap_phrases = re.findall(r'\b([A-Z][a-z]+(?: [A-Z][a-z]+)+)\b', text)
        phrase_counts = Counter(cap_phrases)

        for phrase, count in phrase_counts.most_common(20):
            words_lower = phrase.lower().split()
            # Classify by context
            if any(ind in words_lower for ind in self._org_indicators):
                entity_type = "organization"
            elif any(ind in words_lower for ind in self._role_indicators):
                entity_type = "person"
            elif count >= 3:
                entity_type = "concept"
            else:
                entity_type = "person"  # default for capitalized phrases

            if phrase not in self.knowledge_graph.entities:
                self.knowledge_graph.entities[phrase] = Entity(
                    name=phrase, entity_type=entity_type, mentions=count
                )
            else:
                self.knowledge_graph.entities[phrase].mentions += count

        # Extract locations (simple pattern: "in [City/Country]")
        locations = re.findall(r'\bin ([A-Z][a-z]+(?: [A-Z][a-z]+)*)\b', text)
        for loc in set(locations):
            if loc not in self.knowledge_graph.entities:
                self.knowledge_graph.entities[loc] = Entity(
                    name=loc, entity_type="location", mentions=locations.count(loc)
                )

        # Extract topic keywords
        stop_words = {
            "the", "a", "an", "is", "are", "was", "were", "be", "been",
            "have", "has", "had", "do", "does", "did", "will", "would",
            "could", "should", "may", "might", "this", "that", "these",
            "those", "not", "but", "and", "for", "with", "from", "into",
        }
        words = re.findall(r'\b[a-z]{4,}\b', text.lower())
        word_counts = Counter(w for w in words if w not in stop_words)
        self.knowledge_graph.topics = [
            w for w, _ in word_counts.most_common(15)
        ]

        # Infer relations from co-occurrence in sentences
        sentences = re.split(r'[.!?]+', text)
        entity_names = list(self.knowledge_graph.entities.keys())
        for sent in sentences:
            found_in_sent = [e for e in entity_names if e in sent]
            for i, e1 in enumerate(found_in_sent):
                for e2 in found_in_sent[i+1:]:
                    self.knowledge_graph.relations.append(EntityRelation(
                        source=e1, target=e2,
                        relation_type="co_mentioned",
                        description=f"Co-mentioned in: {sent[:100]}",
                        strength=0.3,
                    ))

        self.knowledge_graph.source_doc_ids.append(doc_id)
        return self.knowledge_graph

    async def write_to_surrealdb(self, storage: Any):
        """Write the knowledge graph to SurrealDB."""
        kg = self.knowledge_graph

        # Define knowledge graph tables
        await storage.db.query("""
            DEFINE TABLE kg_entity SCHEMAFULL;
            DEFINE FIELD name ON kg_entity TYPE string;
            DEFINE FIELD entity_type ON kg_entity TYPE string;
            DEFINE FIELD description ON kg_entity TYPE string DEFAULT '';
            DEFINE FIELD mentions ON kg_entity TYPE int DEFAULT 1;
            DEFINE FIELD properties ON kg_entity TYPE object FLEXIBLE;
            DEFINE INDEX idx_entity_name ON kg_entity FIELDS name UNIQUE;

            DEFINE TABLE kg_relates SCHEMAFULL TYPE RELATION IN kg_entity OUT kg_entity;
            DEFINE FIELD relation_type ON kg_relates TYPE string;
            DEFINE FIELD description ON kg_relates TYPE string DEFAULT '';
            DEFINE FIELD strength ON kg_relates TYPE float DEFAULT 0.5;

            DEFINE TABLE kg_topic SCHEMAFULL;
            DEFINE FIELD name ON kg_topic TYPE string;
            DEFINE INDEX idx_topic_name ON kg_topic FIELDS name UNIQUE;

            DEFINE TABLE kg_about SCHEMAFULL TYPE RELATION IN kg_entity OUT kg_topic;
        """)

        # Write entities
        for name, entity in kg.entities.items():
            safe_id = re.sub(r'[^a-zA-Z0-9_]', '_', name.lower())
            await storage.db.create(f"kg_entity:{safe_id}", {
                "name": entity.name,
                "entity_type": entity.entity_type,
                "description": entity.description,
                "mentions": entity.mentions,
                "properties": entity.properties,
            })

        # Write relations
        for rel in kg.relations:
            source_id = re.sub(r'[^a-zA-Z0-9_]', '_', rel.source.lower())
            target_id = re.sub(r'[^a-zA-Z0-9_]', '_', rel.target.lower())
            await storage.db.query(
                "RELATE $from->kg_relates->$to SET "
                "relation_type = $type, description = $desc, strength = $strength",
                {
                    "from": f"kg_entity:{source_id}",
                    "to": f"kg_entity:{target_id}",
                    "type": rel.relation_type,
                    "desc": rel.description,
                    "strength": rel.strength,
                }
            )

        # Write topics
        for topic in kg.topics:
            safe_id = re.sub(r'[^a-zA-Z0-9_]', '_', topic.lower())
            await storage.db.create(f"kg_topic:{safe_id}", {"name": topic})

        logger.info(
            f"Knowledge graph written to SurrealDB: "
            f"{len(kg.entities)} entities, {len(kg.relations)} relations, "
            f"{len(kg.topics)} topics"
        )

    def get_context_for_agent(self, agent_org: str, agent_role: str,
                              agent_expertise: list[str]) -> str:
        """Build knowledge graph context relevant to a specific agent.

        Filters the knowledge graph to entities/relations relevant to
        the agent's org, role, and expertise. This gets injected into
        the agent's system prompt so they reason with domain knowledge.
        """
        kg = self.knowledge_graph
        relevant_entities = []
        relevant_relations = []

        # Find entities relevant to this agent
        for name, entity in kg.entities.items():
            relevance = 0.0
            name_lower = name.lower()

            # Same org mentioned
            if agent_org.lower() in name_lower:
                relevance += 1.0

            # Expertise overlap
            for exp in agent_expertise:
                if exp.lower() in name_lower or exp.lower() in entity.description.lower():
                    relevance += 0.5

            # High-mention entities are generally relevant
            if entity.mentions >= 5:
                relevance += 0.3

            if relevance > 0.2:
                relevant_entities.append((name, entity, relevance))

        # Sort by relevance, take top 10
        relevant_entities.sort(key=lambda x: x[2], reverse=True)
        relevant_entities = relevant_entities[:10]
        relevant_names = {e[0] for e in relevant_entities}

        # Find relations involving relevant entities
        for rel in kg.relations:
            if rel.source in relevant_names or rel.target in relevant_names:
                relevant_relations.append(rel)

        if not relevant_entities:
            return ""

        # Build context string
        parts = ["KNOWLEDGE CONTEXT:"]
        for name, entity, _ in relevant_entities:
            desc = f" - {entity.description}" if entity.description else ""
            parts.append(f"- {name} ({entity.entity_type}){desc}")

        if relevant_relations:
            parts.append("KEY RELATIONSHIPS:")
            for rel in relevant_relations[:8]:
                parts.append(
                    f"- {rel.source} {rel.relation_type} {rel.target}"
                    + (f": {rel.description}" if rel.description else "")
                )

        if kg.topics:
            parts.append(f"ACTIVE TOPICS: {', '.join(kg.topics[:8])}")

        return "\n".join(parts)
