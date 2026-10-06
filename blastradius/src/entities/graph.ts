/**
 * Entity graph and the query scoring uses for inherited entity risk (PLAN §3.6 step 2):
 *
 *   entityPathsToIncidents(purl, maxHops = 3)
 *     → every simple path  pkg → e₁ → … → eₙ  (n ≤ maxHops) where eₙ is referenced by an incident.
 *
 * Links are walked in either direction (pkg ← account --member_of--> org ← funder ...), but a path
 * never passes through another package node, and links that still need review (probabilistic,
 * confidence < 0.8, not reviewed) are skipped unless `includeUnreviewed` is set.
 *
 * This module does not apply severity / status / age / hop decay; scoring does. `confidence` on a
 * result is Π(link confidence) × incident-entity confidence, as a convenience.
 */
import { unversionedPurl, type Entity, type EntityLink, type Incident, type PurlString } from '../core/types.js';
import type { EntityGraphData } from './resolve.js';
import { isLinkUsable } from './review.js';

export interface EntityIncidentPath {
  /** [unversioned purl, e₁, …, eₙ]; eₙ is the entity the incident references. */
  path: string[];
  /** links[i] connects path[i] and path[i + 1] (in either direction). */
  links: EntityLink[];
  incident: Incident;
  /** The incident's entry for eₙ. */
  incidentEntity: Incident['entities'][number];
  /** Number of links traversed (= links.length, 1…maxHops). */
  hops: number;
  /** Π link.confidence × incidentEntity.confidence. */
  confidence: number;
}

export interface EntityGraphOptions {
  /** Also traverse links that still need review. Default false (scoring must not use them). */
  includeUnreviewed?: boolean;
  /** Safety cap on returned paths. Default 1000. */
  maxResults?: number;
}

function isPurlNode(id: string): boolean {
  return id.startsWith('pkg:');
}

export class EntityGraph {
  readonly entities: ReadonlyMap<string, Entity>;
  readonly links: readonly EntityLink[];
  readonly incidents: readonly Incident[];
  private readonly adjacency = new Map<string, { link: EntityLink; other: string }[]>();
  private readonly incidentsByRef = new Map<string, { incident: Incident; entry: Incident['entities'][number] }[]>();
  private readonly maxResults: number;

  constructor(data: EntityGraphData, incidents: readonly Incident[] = [], opts: EntityGraphOptions = {}) {
    this.entities = new Map(data.entities.map((e) => [e.id, e]));
    this.links = data.links;
    this.incidents = incidents;
    this.maxResults = opts.maxResults ?? 1000;
    for (const link of data.links) {
      if (!opts.includeUnreviewed && !isLinkUsable(link)) continue;
      if (link.from === link.to) continue;
      this.addEdge(link.from, link.to, link);
      this.addEdge(link.to, link.from, link);
    }
    for (const incident of incidents) {
      for (const entry of incident.entities) {
        const list = this.incidentsByRef.get(entry.ref) ?? [];
        list.push({ incident, entry });
        this.incidentsByRef.set(entry.ref, list);
      }
    }
  }

  private addEdge(a: string, b: string, link: EntityLink): void {
    const list = this.adjacency.get(a) ?? [];
    list.push({ link, other: b });
    this.adjacency.set(a, list);
  }

  /** Usable links touching a node (entity id or unversioned purl). */
  linksOf(id: string): EntityLink[] {
    return (this.adjacency.get(id) ?? []).map((x) => x.link);
  }

  /**
   * All entity paths from the component to incidents, sorted by confidence (desc), then hops (asc).
   * `purl` may be versioned; it is matched in its unversioned form.
   */
  entityPathsToIncidents(purl: PurlString, maxHops = 3): EntityIncidentPath[] {
    let start: string;
    try {
      start = unversionedPurl(purl);
    } catch {
      return [];
    }
    const hopsLimit = Math.max(0, Math.min(Math.floor(maxHops), 6));
    const results: EntityIncidentPath[] = [];
    const path = [start];
    const links: EntityLink[] = [];
    const onPath = new Set([start]);

    const visit = (node: string): void => {
      if (results.length >= this.maxResults) return;
      if (links.length > 0) {
        for (const { incident, entry } of this.incidentsByRef.get(node) ?? []) {
          const linkConf = links.reduce((p, l) => p * l.confidence, 1);
          results.push({
            path: [...path],
            links: [...links],
            incident,
            incidentEntity: entry,
            hops: links.length,
            confidence: linkConf * entry.confidence,
          });
        }
      }
      if (links.length >= hopsLimit) return;
      for (const { link, other } of this.adjacency.get(node) ?? []) {
        if (onPath.has(other) || isPurlNode(other)) continue;
        onPath.add(other);
        path.push(other);
        links.push(link);
        visit(other);
        links.pop();
        path.pop();
        onPath.delete(other);
      }
    };
    visit(start);

    return results.sort((a, b) => b.confidence - a.confidence || a.hops - b.hops || (a.incident.id < b.incident.id ? -1 : 1));
  }
}

/** Convenience constructor. */
export function buildEntityGraph(
  data: EntityGraphData,
  incidents: readonly Incident[] = [],
  opts: EntityGraphOptions = {},
): EntityGraph {
  return new EntityGraph(data, incidents, opts);
}

/** Functional form of `EntityGraph#entityPathsToIncidents`. */
export function entityPathsToIncidents(graph: EntityGraph, purl: PurlString, maxHops = 3): EntityIncidentPath[] {
  return graph.entityPathsToIncidents(purl, maxHops);
}
