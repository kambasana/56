/**
 * Inherited entity risk (PLAN §3.6 step 2):
 *
 *   entity_risk(p) = max over paths p → e₁ → … → eₙ → incident of
 *                    severity · status_weight · Π confidence(link) · age_decay · hop_decay(n)
 *
 * Paths come from an `EntityPathProvider` — `EntityGraph` from src/entities satisfies it
 * structurally — or from the small built-in traversal over links (`createLinkPathProvider`).
 * Links that still need review are ignored either way.
 */
import { unversionedPurl, type Component, type EntityChainEntry, type EntityLink, type Incident, type Reason } from '../core/types.js';
import { incidentMatch } from './incidents.js';
import {
  COMPROMISED_RELEASE_TYPES,
  HOP_DECAY,
  INCIDENT_HALF_LIFE_YEARS,
  MAX_ENTITY_HOPS,
  REVIEW_CONFIDENCE_THRESHOLD,
  SEVERITY_WEIGHT,
  STATUS_WEIGHT,
} from './weights.js';
import { clamp01, cleanEvidence, cmpStr, DAY_MS, round, short } from './util.js';

/** Structural subset of `EntityIncidentPath` (src/entities/graph.ts). */
export interface EntityPathLike {
  /** [unversioned purl, e₁, …, eₙ]. */
  path: string[];
  /** links[i] connects path[i] and path[i+1]. */
  links: EntityLink[];
  incident: Incident;
  incidentEntity: { ref: string; role: string; confidence: number };
  hops: number;
}

export interface EntityPathProvider {
  entityPathsToIncidents(purl: string, maxHops?: number): EntityPathLike[];
}

export type { EntityChainEntry } from '../core/types.js';

/** Chain entry for the final hop to a KB incident (curated, so deterministic and reviewed). */
function incidentHop(from: string, inc: Incident, confidence: number): EntityChainEntry {
  return { from, entityId: inc.id, relation: 'incident', confidence, evidence: cleanEvidence(inc.evidence), method: 'deterministic', reviewed: true };
}

function safeUnversioned(purl: string): string {
  try {
    return unversionedPurl(purl);
  } catch {
    return purl;
  }
}

export interface EntityRiskResult {
  /** 0–1. */
  risk: number;
  /** One reason per contributing incident (the max is used for the score). */
  reasons: Reason[];
  /** Chain of the strongest path: entities then the incident. */
  chain: EntityChainEntry[];
}

/** Same rule as src/entities `isLinkUsable`: probabilistic links < 0.8 need review. */
export function isLinkUsableForScoring(link: EntityLink): boolean {
  if (!(link.confidence > 0) || !Array.isArray(link.evidence) || link.evidence.length === 0) return false;
  if (link.method === 'deterministic' || link.reviewed) return true;
  return link.confidence >= REVIEW_CONFIDENCE_THRESHOLD;
}

/** 0.5^(years / half-life); incidents in the future or undated count as fresh. */
export function ageDecay(date: string, now: Date): number {
  const t = Date.parse(date);
  if (Number.isNaN(t)) return 1;
  const years = Math.max(0, (now.getTime() - t) / (365.25 * DAY_MS));
  return 0.5 ** (years / INCIDENT_HALF_LIFE_YEARS);
}

export function hopDecay(hops: number): number {
  return HOP_DECAY[hops] ?? 0;
}

/** Built-in bounded traversal: links walked in either direction, never through another package. */
export function createLinkPathProvider(links: readonly EntityLink[], incidents: readonly Incident[], maxResults = 1000): EntityPathProvider {
  const adj = new Map<string, { link: EntityLink; other: string }[]>();
  const add = (a: string, b: string, link: EntityLink): void => {
    const list = adj.get(a) ?? [];
    list.push({ link, other: b });
    adj.set(a, list);
  };
  const sorted = [...links].sort((a, b) => cmpStr(a.from, b.from) || cmpStr(a.to, b.to) || cmpStr(a.relation, b.relation));
  for (const l of sorted) {
    if (!isLinkUsableForScoring(l) || l.from === l.to) continue;
    add(l.from, l.to, l);
    add(l.to, l.from, l);
  }
  const byRef = new Map<string, { incident: Incident; entry: Incident['entities'][number] }[]>();
  for (const incident of incidents)
    for (const entry of incident.entities) {
      const list = byRef.get(entry.ref) ?? [];
      list.push({ incident, entry });
      byRef.set(entry.ref, list);
    }

  return {
    entityPathsToIncidents(purl: string, maxHops = MAX_ENTITY_HOPS): EntityPathLike[] {
      let start: string;
      try {
        start = unversionedPurl(purl);
      } catch {
        return [];
      }
      const limit = Math.max(0, Math.min(maxHops, MAX_ENTITY_HOPS));
      const out: EntityPathLike[] = [];
      const path = [start];
      const via: EntityLink[] = [];
      const onPath = new Set(path);
      const visit = (node: string): void => {
        if (out.length >= maxResults) return;
        if (via.length > 0)
          for (const { incident, entry } of byRef.get(node) ?? [])
            out.push({ path: [...path], links: [...via], incident, incidentEntity: entry, hops: via.length });
        if (via.length >= limit) return;
        for (const { link, other } of adj.get(node) ?? []) {
          if (onPath.has(other) || other.startsWith('pkg:')) continue;
          onPath.add(other);
          path.push(other);
          via.push(link);
          visit(other);
          via.pop();
          path.pop();
          onPath.delete(other);
        }
      };
      visit(start);
      return out;
    },
  };
}

interface Scored {
  risk: number;
  reason: Reason;
  chain: EntityChainEntry[];
  key: string;
}

export function scoreEntityRisk(
  component: Component,
  opts: { now: Date; incidents?: readonly Incident[]; paths?: EntityPathProvider },
): EntityRiskResult {
  const now = opts.now;
  const scored: Scored[] = [];
  const start = safeUnversioned(component.purl);
  /** Chains for confirmed compromised-release incidents naming this exact version (the malware override). */
  const overrideChains: { key: string; chain: EntityChainEntry[] }[] = [];

  // Hop 0: the package version itself is named by an incident.
  for (const inc of opts.incidents ?? []) {
    const match = incidentMatch(component, inc);
    if (!match) continue;
    const compromised = COMPROMISED_RELEASE_TYPES.includes(inc.type);
    if (compromised && inc.status === 'confirmed' && match === 'exact') {
      // Scored by the malware override in intrinsic.ts; still reported as the entity chain.
      overrideChains.push({ key: inc.id, chain: [incidentHop(start, inc, 1)] });
      continue;
    }
    const status = STATUS_WEIGHT[inc.status] ?? 0;
    // An exact compromised version stays compromised; a wildcard ("all versions") entry fades with age.
    const decay = compromised && match === 'exact' ? 1 : ageDecay(inc.date, now);
    const risk = clamp01((SEVERITY_WEIGHT[inc.severity] ?? 0) * status * decay * hopDecay(0));
    if (risk <= 0) continue;
    scored.push({
      risk,
      key: `0|${inc.id}`,
      chain: [incidentHop(start, inc, 1)],
      reason: {
        factor: 'incident_affected',
        value: round(risk),
        weight: 1,
        contribution: 0,
        detail:
          `Listed as affected by ${inc.id} (${inc.type}, ${inc.status}, ${inc.severity}, ${short(inc.date, 10)})` +
          `${match === 'wildcard' ? ' for all versions; this exact version is not listed' : ''}: ${short(inc.title)}`,
        evidence: cleanEvidence(inc.evidence),
      },
    });
  }

  for (const p of opts.paths?.entityPathsToIncidents(component.purl, MAX_ENTITY_HOPS) ?? []) {
    if (p.hops < 1 || p.hops > MAX_ENTITY_HOPS || p.links.length !== p.hops) continue;
    if (!p.links.every(isLinkUsableForScoring)) continue;
    const inc = p.incident;
    const linkConf = p.links.reduce((acc, l) => acc * clamp01(l.confidence), 1);
    const conf = linkConf * clamp01(p.incidentEntity.confidence);
    const risk = clamp01(
      (SEVERITY_WEIGHT[inc.severity] ?? 0) * (STATUS_WEIGHT[inc.status] ?? 0) * conf * ageDecay(inc.date, now) * hopDecay(p.hops),
    );
    if (risk <= 0) continue;
    const chain: EntityChainEntry[] = p.links.map((l, i) => ({
      from: p.path[i] ?? '',
      entityId: p.path[i + 1] ?? '',
      relation: l.relation,
      confidence: round(clamp01(l.confidence)),
      evidence: cleanEvidence(l.evidence),
      method: l.method,
      reviewed: l.reviewed,
    }));
    chain.push(incidentHop(p.path[p.path.length - 1] ?? start, inc, round(clamp01(p.incidentEntity.confidence))));
    const via = chain
      .slice(0, -1)
      .map((c) => `${short(c.entityId, 80)} (${c.relation}, confidence ${c.confidence})`)
      .join(' → ');
    scored.push({
      risk,
      key: `${p.hops}|${inc.id}|${p.path.join('>')}`,
      chain,
      reason: {
        factor: 'entity_incident',
        value: round(risk),
        weight: 1,
        contribution: 0,
        detail:
          `Linked to ${inc.id} (${inc.type}, ${inc.status}, ${inc.severity}, ${short(inc.date, 10)}) via ${via}; ` +
          `incident role of ${short(p.incidentEntity.ref, 80)}: ${short(p.incidentEntity.role, 60)}`,
        evidence: cleanEvidence([...inc.evidence, ...p.links.flatMap((l) => l.evidence)]),
      },
    });
  }

  overrideChains.sort((a, b) => cmpStr(a.key, b.key));
  const overrideChain = overrideChains[0]?.chain;
  if (scored.length === 0) return { risk: 0, reasons: [], chain: overrideChain ?? [] };
  scored.sort((a, b) => b.risk - a.risk || cmpStr(a.key, b.key));
  // Keep the strongest path per incident.
  const seen = new Set<string>();
  const best = scored.filter((s) => {
    const id = s.chain[s.chain.length - 1]!.entityId;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  // The override (score 100) is the decisive signal, so its incident hop is the chain to show.
  return { risk: best[0]!.risk, reasons: best.slice(0, 5).map((s) => s.reason), chain: overrideChain ?? best[0]!.chain };
}
