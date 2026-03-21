"""Document intelligence module - MiroFish-inspired document-centric features."""

from __future__ import annotations

import re
from collections import Counter
from datetime import datetime
from typing import Any

from nexus_social.core.models import AgentProfile, Document


class DocumentIntelligence:
    """Analyzes documents for keywords, topics, relationships, and insights.

    Inspired by MiroFish's document-centric approach but enhanced with
    social interaction context.
    """

    def __init__(self):
        self.documents: list[Document] = []
        self.keyword_index: dict[str, list[str]] = {}  # keyword -> doc_ids
        self.topic_clusters: dict[str, list[str]] = {}  # topic -> doc_ids

    def ingest(self, document: Document):
        """Index a document for intelligence analysis."""
        self.documents.append(document)
        keywords = self._extract_keywords(document)
        document.keywords = keywords
        for kw in keywords:
            if kw not in self.keyword_index:
                self.keyword_index[kw] = []
            self.keyword_index[kw].append(document.id)

    def _extract_keywords(self, doc: Document) -> list[str]:
        """Extract key terms from document content and metadata."""
        stop_words = {
            "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
            "have", "has", "had", "do", "does", "did", "will", "would", "could",
            "should", "may", "might", "shall", "can", "need", "dare", "ought",
            "used", "to", "of", "in", "for", "on", "with", "at", "by", "from",
            "as", "into", "through", "during", "before", "after", "above", "below",
            "between", "out", "off", "over", "under", "again", "further", "then",
            "once", "here", "there", "when", "where", "why", "how", "all", "each",
            "every", "both", "few", "more", "most", "other", "some", "such", "no",
            "not", "only", "own", "same", "so", "than", "too", "very", "just",
            "because", "but", "and", "or", "if", "while", "this", "that", "these",
            "those", "it", "its", "our", "their", "we", "they", "them", "him",
            "her", "his", "my", "your", "up",
        }

        text = f"{doc.title} {doc.content}".lower()
        words = re.findall(r'\b[a-z]{3,}\b', text)
        filtered = [w for w in words if w not in stop_words]
        counts = Counter(filtered)
        top_keywords = [word for word, _ in counts.most_common(10)]

        # Add tags as keywords
        for tag in doc.tags:
            if tag.lower() not in top_keywords:
                top_keywords.append(tag.lower())

        return top_keywords

    def find_related_documents(self, doc: Document, limit: int = 5) -> list[Document]:
        """Find documents related to a given document by keyword overlap."""
        if not doc.keywords:
            return []

        scores: dict[str, float] = {}
        for kw in doc.keywords:
            for doc_id in self.keyword_index.get(kw, []):
                if doc_id != doc.id:
                    scores[doc_id] = scores.get(doc_id, 0) + 1

        doc_map = {d.id: d for d in self.documents}
        ranked = sorted(scores.items(), key=lambda x: x[1], reverse=True)[:limit]
        return [doc_map[doc_id] for doc_id, _ in ranked if doc_id in doc_map]

    def get_trending_topics(self, top_n: int = 10) -> list[dict[str, Any]]:
        """Identify trending topics across all documents."""
        all_keywords: list[str] = []
        for doc in self.documents:
            all_keywords.extend(doc.keywords)

        counts = Counter(all_keywords)
        return [
            {"topic": topic, "count": count, "docs": len(self.keyword_index.get(topic, []))}
            for topic, count in counts.most_common(top_n)
        ]

    def get_knowledge_graph(self) -> dict:
        """Build a knowledge graph from document relationships."""
        nodes = []
        edges = []
        doc_nodes = set()
        author_nodes = set()

        for doc in self.documents:
            if doc.id not in doc_nodes:
                nodes.append({
                    "id": f"doc_{doc.id}",
                    "type": "document",
                    "label": doc.title,
                    "doc_type": doc.doc_type,
                    "author": doc.author.name,
                })
                doc_nodes.add(doc.id)

            author_key = doc.author.id
            if author_key not in author_nodes:
                nodes.append({
                    "id": f"agent_{author_key}",
                    "type": "agent",
                    "label": doc.author.name,
                    "org": doc.author.org.name,
                })
                author_nodes.add(author_key)

            edges.append({
                "source": f"agent_{author_key}",
                "target": f"doc_{doc.id}",
                "type": "authored",
            })

            # Keyword-based edges between documents
            related = self.find_related_documents(doc, limit=3)
            for rel in related:
                common = set(doc.keywords) & set(rel.keywords)
                edges.append({
                    "source": f"doc_{doc.id}",
                    "target": f"doc_{rel.id}",
                    "type": "related",
                    "common_keywords": list(common),
                })

        # Add topic nodes
        for topic_data in self.get_trending_topics(5):
            topic = topic_data["topic"]
            nodes.append({
                "id": f"topic_{topic}",
                "type": "topic",
                "label": topic,
                "doc_count": topic_data["docs"],
            })
            for doc_id in self.keyword_index.get(topic, [])[:5]:
                edges.append({
                    "source": f"doc_{doc_id}",
                    "target": f"topic_{topic}",
                    "type": "topic_link",
                })

        return {"nodes": nodes, "edges": edges}

    def get_document_timeline(self) -> list[dict]:
        """Get documents organized as a timeline."""
        sorted_docs = sorted(self.documents, key=lambda d: d.created)
        return [doc.to_dict() for doc in sorted_docs]

    def get_org_document_stats(self) -> dict[str, dict]:
        """Get document statistics per organization."""
        stats: dict[str, dict] = {}
        for doc in self.documents:
            org = doc.author.org.name
            if org not in stats:
                stats[org] = {"count": 0, "types": {}, "top_keywords": []}
            stats[org]["count"] += 1
            dt = doc.doc_type
            stats[org]["types"][dt] = stats[org]["types"].get(dt, 0) + 1

        for org in stats:
            org_docs = [d for d in self.documents if d.author.org.name == org]
            all_kw = []
            for d in org_docs:
                all_kw.extend(d.keywords)
            stats[org]["top_keywords"] = [
                kw for kw, _ in Counter(all_kw).most_common(5)
            ]

        return stats
