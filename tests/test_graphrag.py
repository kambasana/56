"""Tests for GraphRAG document processing."""

import pytest

from nexus_social.documents.graphrag import (
    Entity,
    EntityRelation,
    GraphRAGProcessor,
    KnowledgeGraph,
)


@pytest.fixture
def processor():
    return GraphRAGProcessor(llm_extract=False)


SAMPLE_DOC = """
The United Nations Security Council met today to discuss the escalating situation
in Eastern Europe. Secretary General Antonio Guterres warned that diplomatic
channels are narrowing. NATO Commander General Mark Johnson briefed the council
on military preparedness. The Pentagon confirmed that cyber defense units are
on high alert following attacks on critical infrastructure in Ukraine.

Meanwhile, the European Central Bank announced emergency measures to stabilize
markets. China's Foreign Ministry issued a statement calling for restraint from
all parties. Russia's Ambassador Viktor Petrov dismissed allegations of
provocation, stating that Russia is acting in self-defense.

Technology companies including Microsoft and CrowdStrike reported a significant
increase in state-sponsored cyber attacks targeting government systems across
Europe. The attacks have been attributed to APT28, a group linked to Russian
military intelligence.
"""


class TestRuleBasedExtraction:
    def test_extracts_entities(self, processor):
        kg = processor.extract_rule_based(SAMPLE_DOC, "doc1")
        assert len(kg.entities) > 0
        entity_names = list(kg.entities.keys())
        # Should find capitalized phrases
        assert any("Security Council" in name or "United Nations" in name
                    for name in entity_names)

    def test_extracts_topics(self, processor):
        kg = processor.extract_rule_based(SAMPLE_DOC, "doc1")
        assert len(kg.topics) > 0

    def test_extracts_relations(self, processor):
        kg = processor.extract_rule_based(SAMPLE_DOC, "doc1")
        assert len(kg.relations) > 0
        # Relations should be co-occurrence based
        assert all(r.relation_type == "co_mentioned" for r in kg.relations)

    def test_tracks_source_doc(self, processor):
        kg = processor.extract_rule_based(SAMPLE_DOC, "doc1")
        assert "doc1" in kg.source_doc_ids

    def test_multiple_documents_accumulate(self, processor):
        processor.extract_rule_based(SAMPLE_DOC, "doc1")
        processor.extract_rule_based("Apple Inc announced a new product line.", "doc2")
        kg = processor.knowledge_graph
        assert "doc1" in kg.source_doc_ids
        assert "doc2" in kg.source_doc_ids


class TestLLMExtractionPrompt:
    def test_builds_prompt(self, processor):
        prompt = processor.build_llm_extraction_prompt(SAMPLE_DOC)
        assert "entities" in prompt
        assert "relations" in prompt
        assert "DOCUMENT" in prompt

    def test_parse_valid_json(self, processor):
        llm_response = '''
        {
            "entities": [
                {"name": "NATO", "type": "organization", "description": "Military alliance"},
                {"name": "Ukraine", "type": "location", "description": "Country in Eastern Europe"}
            ],
            "relations": [
                {"source": "NATO", "target": "Ukraine", "type": "supports", "description": "Military support", "strength": 0.8}
            ],
            "topics": ["military", "diplomacy", "cyber"],
            "sentiment": "alarming",
            "key_claims": ["Diplomatic channels narrowing"]
        }
        '''
        kg = processor.parse_llm_extraction(llm_response, "doc1")
        assert "NATO" in kg.entities
        assert "Ukraine" in kg.entities
        assert len(kg.relations) >= 1
        assert "military" in kg.topics

    def test_parse_invalid_json_doesnt_crash(self, processor):
        kg = processor.parse_llm_extraction("not json at all", "doc1")
        # Should not crash, just return existing (empty) graph
        assert isinstance(kg, KnowledgeGraph)


class TestAgentContext:
    def test_context_filters_by_org(self, processor):
        processor.knowledge_graph.entities["TechCorp HQ"] = Entity(
            name="TechCorp HQ", entity_type="organization", mentions=5
        )
        processor.knowledge_graph.entities["Random Entity"] = Entity(
            name="Random Entity", entity_type="concept", mentions=1
        )

        ctx = processor.get_context_for_agent("TechCorp", "engineer", [])
        assert "TechCorp" in ctx
        # Low-mention unrelated entity should not appear
        assert "Random Entity" not in ctx

    def test_context_filters_by_expertise(self, processor):
        processor.knowledge_graph.entities["Cyber Defense"] = Entity(
            name="Cyber Defense", entity_type="concept",
            description="Network security measures", mentions=3,
        )
        ctx = processor.get_context_for_agent("AnyOrg", "engineer", ["cyber"])
        assert "Cyber Defense" in ctx

    def test_empty_graph_returns_empty(self, processor):
        ctx = processor.get_context_for_agent("Org", "role", [])
        assert ctx == ""


class TestKnowledgeGraphDict:
    def test_to_dict(self):
        kg = KnowledgeGraph()
        kg.entities["Test"] = Entity(name="Test", entity_type="concept", mentions=3)
        kg.relations.append(EntityRelation(
            source="A", target="B", relation_type="related_to",
        ))
        kg.topics = ["topic1"]

        d = kg.to_dict()
        assert "Test" in d["entities"]
        assert len(d["relations"]) == 1
        assert d["topics"] == ["topic1"]
