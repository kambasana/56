"""Observer agent — watches the simulation and detects emergent patterns.

MiroFish-inspired but goes further. Instead of just generating a report
at the end, this runs every tick and flags emerging dynamics:
- Coalition formation / fracturing
- Narrative drift (topic shifting, framing changes)
- Stress cascades (contagion spreading through the network)
- Influence concentration (one agent dominating discourse)
- Echo chambers forming
- Cross-org bridge building or breakdown
- Sentiment shifts (org-wide or network-wide)

The observer doesn't participate — it watches and reports.
"""

from __future__ import annotations

import logging
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class EmergentPattern:
    """A pattern the observer detected."""
    pattern_type: str       # "coalition", "stress_cascade", "narrative_drift", etc.
    description: str        # human-readable description
    severity: float         # 0-1, how significant
    tick: int
    agents_involved: list[str] = field(default_factory=list)
    orgs_involved: list[str] = field(default_factory=list)
    evidence: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "type": self.pattern_type,
            "description": self.description,
            "severity": round(self.severity, 2),
            "tick": self.tick,
            "agents": self.agents_involved,
            "orgs": self.orgs_involved,
            "evidence": self.evidence,
        }


class ObserverAgent:
    """Watches the simulation every tick and detects emergent behavior.

    Maintains a rolling window of observations to detect trends,
    not just point-in-time snapshots.
    """

    def __init__(self, window_size: int = 10):
        self.window_size = window_size
        self.tick_history: list[dict] = []  # rolling window of tick summaries
        self.detected_patterns: list[EmergentPattern] = []
        self.sentiment_history: dict[str, list[float]] = defaultdict(list)  # org -> [sentiments]
        self.activity_history: dict[str, list[int]] = defaultdict(list)    # org -> [post_counts]
        self.stress_history: dict[str, list[float]] = defaultdict(list)    # agent -> [stress_levels]

    def observe(self, tick: int, tick_data: dict[str, Any]) -> list[EmergentPattern]:
        """Process one tick of simulation data. Returns newly detected patterns."""
        self.tick_history.append({"tick": tick, **tick_data})
        if len(self.tick_history) > self.window_size:
            self.tick_history.pop(0)

        # Update histories
        self._update_histories(tick_data)

        # Run all detectors
        new_patterns = []
        new_patterns.extend(self._detect_stress_cascade(tick, tick_data))
        new_patterns.extend(self._detect_coalition_formation(tick, tick_data))
        new_patterns.extend(self._detect_echo_chamber(tick, tick_data))
        new_patterns.extend(self._detect_influence_concentration(tick, tick_data))
        new_patterns.extend(self._detect_sentiment_shift(tick, tick_data))
        new_patterns.extend(self._detect_silence(tick, tick_data))
        new_patterns.extend(self._detect_cross_org_bridge(tick, tick_data))

        self.detected_patterns.extend(new_patterns)
        return new_patterns

    def _update_histories(self, tick_data: dict):
        """Update rolling history trackers."""
        agents = tick_data.get("agents", {})
        for agent_id, agent_data in agents.items():
            stress = agent_data.get("stress", 0)
            org = agent_data.get("org", "unknown")
            self.stress_history[agent_id].append(stress)
            if len(self.stress_history[agent_id]) > self.window_size:
                self.stress_history[agent_id].pop(0)

        org_posts = tick_data.get("org_post_counts", {})
        for org, count in org_posts.items():
            self.activity_history[org].append(count)
            if len(self.activity_history[org]) > self.window_size:
                self.activity_history[org].pop(0)

    def _detect_stress_cascade(self, tick: int,
                                tick_data: dict) -> list[EmergentPattern]:
        """Detect when stress is spreading through connected agents."""
        patterns = []
        agents = tick_data.get("agents", {})

        # Find agents whose stress increased significantly this tick
        newly_stressed = []
        for agent_id, history in self.stress_history.items():
            if len(history) < 2:
                continue
            delta = history[-1] - history[-2]
            if delta > 0.15 and history[-1] > 0.5:
                agent_info = agents.get(agent_id, {})
                newly_stressed.append({
                    "id": agent_id,
                    "name": agent_info.get("name", agent_id),
                    "org": agent_info.get("org", "unknown"),
                    "stress": history[-1],
                    "delta": delta,
                })

        if len(newly_stressed) >= 3:
            # Check if they're connected (same org or team)
            orgs = [a["org"] for a in newly_stressed]
            org_counts = Counter(orgs)
            dominant_org, count = org_counts.most_common(1)[0]

            if count >= 2:
                patterns.append(EmergentPattern(
                    pattern_type="stress_cascade",
                    description=(
                        f"Stress spreading through {dominant_org}: "
                        f"{count} agents showing stress spike this tick"
                    ),
                    severity=min(1.0, len(newly_stressed) * 0.2),
                    tick=tick,
                    agents_involved=[a["id"] for a in newly_stressed],
                    orgs_involved=list(org_counts.keys()),
                    evidence={"stressed_agents": newly_stressed},
                ))

        return patterns

    def _detect_coalition_formation(self, tick: int,
                                     tick_data: dict) -> list[EmergentPattern]:
        """Detect when agents from different orgs start interacting frequently."""
        patterns = []
        interactions = tick_data.get("cross_org_interactions", [])

        if len(interactions) < 3:
            return patterns

        # Group by org pairs
        pair_counts: Counter = Counter()
        pair_agents: dict[tuple, list] = defaultdict(list)
        for interaction in interactions:
            org1 = interaction.get("org1", "")
            org2 = interaction.get("org2", "")
            if org1 and org2 and org1 != org2:
                pair = tuple(sorted([org1, org2]))
                pair_counts[pair] += 1
                pair_agents[pair].extend([
                    interaction.get("agent1", ""),
                    interaction.get("agent2", ""),
                ])

        for pair, count in pair_counts.most_common(3):
            if count >= 3:
                patterns.append(EmergentPattern(
                    pattern_type="coalition_forming",
                    description=(
                        f"Increasing cross-org engagement between {pair[0]} "
                        f"and {pair[1]}: {count} interactions this tick"
                    ),
                    severity=min(1.0, count * 0.15),
                    tick=tick,
                    agents_involved=list(set(pair_agents[pair])),
                    orgs_involved=list(pair),
                    evidence={"interaction_count": count},
                ))

        return patterns

    def _detect_echo_chamber(self, tick: int,
                              tick_data: dict) -> list[EmergentPattern]:
        """Detect when an org is only talking to itself."""
        patterns = []
        org_interactions = tick_data.get("org_interaction_matrix", {})

        for org, targets in org_interactions.items():
            total = sum(targets.values())
            if total < 3:
                continue
            self_count = targets.get(org, 0)
            if total > 0 and self_count / total > 0.8:
                patterns.append(EmergentPattern(
                    pattern_type="echo_chamber",
                    description=(
                        f"{org} is {int(self_count/total*100)}% talking to itself. "
                        f"Echo chamber forming."
                    ),
                    severity=self_count / total,
                    tick=tick,
                    orgs_involved=[org],
                    evidence={"self_interaction_rate": round(self_count / total, 2),
                              "total_interactions": total},
                ))

        return patterns

    def _detect_influence_concentration(self, tick: int,
                                         tick_data: dict) -> list[EmergentPattern]:
        """Detect when one agent is dominating the discourse."""
        patterns = []
        post_counts = tick_data.get("agent_post_counts", {})
        if not post_counts:
            return patterns

        total_posts = sum(post_counts.values())
        if total_posts < 5:
            return patterns

        for agent_id, count in post_counts.items():
            share = count / total_posts
            if share > 0.3:
                agent_info = tick_data.get("agents", {}).get(agent_id, {})
                patterns.append(EmergentPattern(
                    pattern_type="influence_concentration",
                    description=(
                        f"{agent_info.get('name', agent_id)} is producing "
                        f"{int(share*100)}% of all content. Discourse dominated."
                    ),
                    severity=share,
                    tick=tick,
                    agents_involved=[agent_id],
                    orgs_involved=[agent_info.get("org", "")] if agent_info.get("org") else [],
                    evidence={"post_share": round(share, 2), "post_count": count},
                ))

        return patterns

    def _detect_sentiment_shift(self, tick: int,
                                 tick_data: dict) -> list[EmergentPattern]:
        """Detect significant sentiment shifts in an org."""
        patterns = []
        org_sentiment = tick_data.get("org_sentiment", {})

        for org, sentiment in org_sentiment.items():
            history = self.sentiment_history.get(org, [])
            self.sentiment_history[org].append(sentiment)
            if len(self.sentiment_history[org]) > self.window_size:
                self.sentiment_history[org].pop(0)

            if len(history) < 3:
                continue

            recent_avg = sum(history[-3:]) / 3
            older_avg = sum(history[:-3]) / max(1, len(history) - 3) if len(history) > 3 else recent_avg
            shift = recent_avg - older_avg

            if abs(shift) > 0.2:
                direction = "more negative" if shift < 0 else "more positive"
                patterns.append(EmergentPattern(
                    pattern_type="sentiment_shift",
                    description=f"{org} sentiment shifting {direction} (delta: {shift:.2f})",
                    severity=min(1.0, abs(shift) * 2),
                    tick=tick,
                    orgs_involved=[org],
                    evidence={"shift": round(shift, 2), "current": round(recent_avg, 2)},
                ))

        return patterns

    def _detect_silence(self, tick: int, tick_data: dict) -> list[EmergentPattern]:
        """Detect when a normally active agent or org goes silent."""
        patterns = []

        for org, history in self.activity_history.items():
            if len(history) < 4:
                continue
            older_avg = sum(history[:-2]) / max(1, len(history) - 2)
            recent_avg = sum(history[-2:]) / 2

            if older_avg > 2 and recent_avg < older_avg * 0.3:
                patterns.append(EmergentPattern(
                    pattern_type="suspicious_silence",
                    description=(
                        f"{org} has gone quiet. Activity dropped from "
                        f"~{older_avg:.0f} to ~{recent_avg:.0f} posts/tick"
                    ),
                    severity=min(1.0, (older_avg - recent_avg) / max(1, older_avg)),
                    tick=tick,
                    orgs_involved=[org],
                    evidence={"old_avg": round(older_avg, 1),
                              "recent_avg": round(recent_avg, 1)},
                ))

        return patterns

    def _detect_cross_org_bridge(self, tick: int,
                                  tick_data: dict) -> list[EmergentPattern]:
        """Detect agents acting as bridges between orgs."""
        patterns = []
        bridge_agents = tick_data.get("bridge_agents", [])

        for agent in bridge_agents:
            if agent.get("betweenness", 0) > 0.5:
                patterns.append(EmergentPattern(
                    pattern_type="bridge_agent",
                    description=(
                        f"{agent.get('name', '')} is acting as a key bridge "
                        f"between organizations (betweenness: {agent['betweenness']:.2f})"
                    ),
                    severity=agent["betweenness"],
                    tick=tick,
                    agents_involved=[agent.get("agent_id", "")],
                    orgs_involved=[agent.get("org", "")],
                    evidence=agent,
                ))

        return patterns

    def get_summary(self, last_n_ticks: int = 5) -> dict:
        """Get a summary of all detected patterns."""
        recent = [p for p in self.detected_patterns
                  if p.tick >= max(0, self.tick_history[-1]["tick"] - last_n_ticks)
                  ] if self.tick_history else []

        by_type = defaultdict(list)
        for p in recent:
            by_type[p.pattern_type].append(p.to_dict())

        return {
            "total_patterns": len(recent),
            "by_type": dict(by_type),
            "high_severity": [p.to_dict() for p in recent if p.severity > 0.7],
            "ticks_observed": len(self.tick_history),
        }

    def get_all_patterns(self) -> list[dict]:
        return [p.to_dict() for p in self.detected_patterns]
