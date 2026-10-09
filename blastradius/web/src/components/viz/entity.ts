/**
 * Entity chain model (design system: EntityChain): who is behind a package as a short top-down
 * tree, package → accounts → organisations → funders. Pure functions: naming, confidence words,
 * and a layout that opens one hop deep, hides unreviewed low-confidence links by default, and
 * never draws more than 50 nodes.
 */
import type { PackageBehindResponse } from '@server/api-types-incidents';

export type BehindLink = PackageBehindResponse['links'][number];
export type EntityKind = 'package' | 'account' | 'org' | 'funder' | 'person' | 'repo' | 'other';
export type Confidence = 'High' | 'Medium' | 'Low';

export const MAX_NODES = 50;
/** Siblings drawn per parent before "+N more". */
export const MAX_SIBLINGS = 6;

export function entityKind(id: string): EntityKind {
  if (id.startsWith('pkg:')) return 'package';
  const prefix = id.slice(0, id.indexOf(':'));
  if (prefix === 'account' || prefix === 'org' || prefix === 'funder' || prefix === 'person' || prefix === 'repo') return prefix;
  return 'other';
}

export const KIND_LABEL: Record<EntityKind, string> = { package: 'Package', account: 'Account', org: 'Organisation', funder: 'Funder', person: 'Person', repo: 'Repository', other: 'Entity' };

const HOSTS: Record<string, string> = { npm: 'npm', github: 'GitHub', gitlab: 'GitLab', opencollective: 'Open Collective', github_sponsors: 'GitHub Sponsors', tidelift: 'Tidelift', patreon: 'Patreon' };

/** "account:npm/right9ctrl" → "npm · right9ctrl"; "org:github/chalk" → "GitHub · chalk (org)". */
export function entityLabel(id: string): string {
  const kind = entityKind(id);
  if (kind === 'package') {
    const body = decodeURIComponent(id.replace(/^pkg:[^/]+\//, ''));
    return body.replace(/@[^@/]*$/, '') || body;
  }
  const rest = id.slice(id.indexOf(':') + 1);
  const slash = rest.indexOf('/');
  if (slash < 0) return rest;
  const host = HOSTS[rest.slice(0, slash)] ?? rest.slice(0, slash);
  const name = rest.slice(slash + 1);
  return `${host} · ${name}${kind === 'org' ? ' (org)' : kind === 'repo' ? ' (repo)' : ''}`;
}

export function confidenceWord(c: number): Confidence {
  return c >= 0.8 ? 'High' : c >= 0.5 ? 'Medium' : 'Low';
}

/** Below 0.8 and never reviewed: shown only on request, and never affects a score. */
export function isUnreviewed(l: Pick<BehindLink, 'confidence' | 'reviewed'>): boolean {
  return !l.reviewed && l.confidence < 0.8;
}

const RELATION: Record<string, string> = { maintains: 'maintains', publishes: 'publishes', owns: 'owns the repository', funds: 'funding link', member_of: 'member of', linked_to: 'linked to' };

/** The link in words, read from the parent: "maintained by", "member of", … */
export function relationText(relation: string): string {
  return RELATION[relation] ?? relation.replace(/_/g, ' ');
}

export interface ChainNode {
  id: string;
  kind: EntityKind;
  label: string;
  depth: number;
  x: number;
  y: number;
  /** The link from the parent (none for the root). */
  link: BehindLink | null;
  /** Children not drawn (not expanded yet, or past the sibling cap). */
  hidden: number;
  expanded: boolean;
}

export interface ChainLayout {
  width: number;
  height: number;
  nodes: ChainNode[];
  /** Unreviewed links left out (when not shown). */
  unreviewedHidden: number;
  /** Links reachable from the root but not drawn. */
  linksHidden: number;
}

/** Children per node from the visible links (first link wins for a node reached twice). */
function childrenOf(links: readonly BehindLink[]): Map<string, BehindLink[]> {
  const m = new Map<string, BehindLink[]>();
  for (const l of links) (m.get(l.from) ?? m.set(l.from, []).get(l.from)!).push(l);
  for (const list of m.values()) list.sort((a, b) => b.confidence - a.confidence || a.entityId.localeCompare(b.entityId));
  return m;
}

export function layoutChain(
  rootId: string,
  allLinks: readonly BehindLink[],
  opts: { showUnreviewed: boolean; expanded: ReadonlySet<string>; width?: number; levelHeight?: number },
): ChainLayout {
  const width = opts.width ?? 760;
  const levelHeight = opts.levelHeight ?? 130;
  const links = opts.showUnreviewed ? allLinks : allLinks.filter((l) => !isUnreviewed(l));
  const kids = childrenOf(links);
  const seen = new Set([rootId]);
  const nodes: ChainNode[] = [{ id: rootId, kind: entityKind(rootId), label: entityLabel(rootId), depth: 0, x: 0, y: 0, link: null, hidden: 0, expanded: opts.expanded.has(rootId) }];
  const queue: ChainNode[] = [nodes[0]!];
  let drawnLinks = 0;
  while (queue.length) {
    const n = queue.shift()!;
    const list = (kids.get(n.id) ?? []).filter((l) => !seen.has(l.entityId));
    if (!n.expanded) {
      n.hidden = list.length;
      continue;
    }
    const room = Math.max(0, Math.min(MAX_SIBLINGS, MAX_NODES - nodes.length));
    const drawn = list.slice(0, room);
    n.hidden = list.length - drawn.length;
    for (const l of drawn) {
      seen.add(l.entityId);
      const c: ChainNode = { id: l.entityId, kind: entityKind(l.entityId), label: entityLabel(l.entityId), depth: n.depth + 1, x: 0, y: 0, link: l, hidden: 0, expanded: opts.expanded.has(l.entityId) };
      nodes.push(c);
      queue.push(c);
      drawnLinks++;
    }
  }
  // Count every link reachable from the root, to say how many are not drawn.
  const reach = new Set([rootId]);
  const q = [rootId];
  let reachable = 0;
  while (q.length) {
    const id = q.shift()!;
    for (const l of kids.get(id) ?? []) {
      if (reach.has(l.entityId)) continue;
      reach.add(l.entityId);
      reachable++;
      q.push(l.entityId);
    }
  }
  // Positions: rows by depth, evenly spread.
  const byDepth = new Map<number, ChainNode[]>();
  for (const n of nodes) (byDepth.get(n.depth) ?? byDepth.set(n.depth, []).get(n.depth)!).push(n);
  for (const [depth, row] of byDepth) {
    row.forEach((n, i) => {
      n.x = Math.round(((i + 0.5) * width) / row.length);
      n.y = 40 + depth * levelHeight;
    });
  }
  const depthMax = Math.max(...nodes.map((n) => n.depth));
  return {
    width,
    height: 40 + depthMax * levelHeight + 90,
    nodes,
    unreviewedHidden: opts.showUnreviewed ? 0 : allLinks.filter(isUnreviewed).length,
    linksHidden: reachable - drawnLinks,
  };
}
