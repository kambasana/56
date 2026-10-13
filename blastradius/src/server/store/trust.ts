/**
 * Tier 0 trust data (migration 13; docs/WHO-BEHIND-PLAN.md "Tier 0"):
 *
 * - entity_link_review: an org's human decisions on "who is behind" links. The only way a link
 *   reads `reviewed: true` in the web app (the CLI uses a --review file). Machine links never are.
 * - registry_advisory: OSV malware advisories (MAL-*) per npm package, for the account pivot. Public
 *   data shared by every org, like registry_package.
 */
import { writeAudit } from './audit.js';
import { all, get, nowIso, parseJson, placeholders, run, tx, type Store } from './db.js';

export interface LinkReview {
  from: string;
  relation: string;
  to: string;
  decision: 'accept' | 'reject';
  reviewer: string;
  note: string | null;
  decidedAt: string;
}

interface LinkReviewRow {
  from_id: string;
  relation: string;
  to_id: string;
  decision: 'accept' | 'reject';
  reviewer: string;
  note: string | null;
  decided_at: string;
}

const toReview = (r: LinkReviewRow): LinkReview => ({ from: r.from_id, relation: r.relation, to: r.to_id, decision: r.decision, reviewer: r.reviewer, note: r.note, decidedAt: r.decided_at });

export const linkReviewKey = (l: { from: string; relation: string; to: string }): string => `${l.from}\u0000${l.relation}\u0000${l.to}`;

/** Every review decision of the org, keyed by from/relation/to. */
export function linkReviews(s: Store, orgId: string): Map<string, LinkReview> {
  const out = new Map<string, LinkReview>();
  for (const r of all<LinkReviewRow>(s, 'SELECT from_id, relation, to_id, decision, reviewer, note, decided_at FROM entity_link_review WHERE org_id = ?', orgId)) {
    const v = toReview(r);
    out.set(linkReviewKey(v), v);
  }
  return out;
}

/** Record (or replace) a human decision on one link; audited. */
export function setLinkReview(
  s: Store,
  orgId: string,
  actor: { id: string; name: string },
  d: { from: string; relation: string; to: string; decision: 'accept' | 'reject'; note?: string | null },
): LinkReview {
  return tx(s, () => {
    const at = nowIso(s);
    run(
      s,
      `INSERT INTO entity_link_review (org_id, from_id, relation, to_id, decision, reviewer, note, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (org_id, from_id, relation, to_id) DO UPDATE SET decision = excluded.decision, reviewer = excluded.reviewer, note = excluded.note, decided_at = excluded.decided_at`,
      orgId,
      d.from,
      d.relation,
      d.to,
      d.decision,
      actor.name,
      d.note ?? null,
      at,
    );
    writeAudit(s, { orgId, actor: actor.id, action: 'entity_link.review', target: `${d.from} ${d.relation} ${d.to}`, detail: { decision: d.decision, note: d.note ?? null } });
    return toReview(get<LinkReviewRow>(s, 'SELECT from_id, relation, to_id, decision, reviewer, note, decided_at FROM entity_link_review WHERE org_id = ? AND from_id = ? AND relation = ? AND to_id = ?', orgId, d.from, d.relation, d.to)!);
  });
}

/** Remove a decision: the link reads as machine-derived (unreviewed) again; audited. */
export function clearLinkReview(s: Store, orgId: string, actor: { id: string; name: string }, d: { from: string; relation: string; to: string }): boolean {
  return tx(s, () => {
    const r = run(s, 'DELETE FROM entity_link_review WHERE org_id = ? AND from_id = ? AND relation = ? AND to_id = ?', orgId, d.from, d.relation, d.to);
    if (r.changes > 0) writeAudit(s, { orgId, actor: actor.id, action: 'entity_link.review_cleared', target: `${d.from} ${d.relation} ${d.to}` });
    return r.changes > 0;
  });
}

// ---------------------------------------------------------------------------
// Malware advisories per npm package (OSV)
// ---------------------------------------------------------------------------

export interface MalwareAdvisory {
  /** OSV id ("MAL-2025-46971"). */
  id: string;
  /** Other ids for the same record (GHSA, CVE). */
  aliases: string[];
  summary: string;
  /** Exact affected versions ("*" when OSV lists none, i.e. every version). */
  versions: string[];
  published: string | null;
  url: string;
}

export interface StoredAdvisories {
  name: string;
  status: 'ok' | 'unavailable';
  fetchedAt: string;
  malware: MalwareAdvisory[];
}

export function upsertRegistryAdvisories(s: Store, name: string, v: { malware: MalwareAdvisory[] } | { unavailable: true }): void {
  const at = nowIso(s);
  if ('unavailable' in v) {
    // Keep the last good answer; only record a first failure.
    run(s, `INSERT INTO registry_advisory (registry, name, status, fetched_at) VALUES ('npm', ?, 'unavailable', ?) ON CONFLICT (registry, name) DO NOTHING`, name, at);
    return;
  }
  run(
    s,
    `INSERT INTO registry_advisory (registry, name, status, fetched_at, malware_json) VALUES ('npm', ?, 'ok', ?, ?)
     ON CONFLICT (registry, name) DO UPDATE SET status = 'ok', fetched_at = excluded.fetched_at, malware_json = excluded.malware_json`,
    name,
    at,
    JSON.stringify(v.malware),
  );
}

export function registryAdvisories(s: Store, names: Iterable<string>): Map<string, StoredAdvisories> {
  const out = new Map<string, StoredAdvisories>();
  const list = [...new Set(names)];
  for (let i = 0; i < list.length; i += 500) {
    const chunk = list.slice(i, i + 500);
    for (const r of all<{ name: string; status: 'ok' | 'unavailable'; fetched_at: string; malware_json: string }>(
      s,
      `SELECT name, status, fetched_at, malware_json FROM registry_advisory WHERE registry = 'npm' AND name IN (${placeholders(chunk.length)})`,
      ...chunk,
    ))
      out.set(r.name, { name: r.name, status: r.status, fetchedAt: r.fetched_at, malware: parseJson<MalwareAdvisory[]>(r.malware_json, []) });
  }
  return out;
}

/** Names whose advisories are missing or older than `olderThan`. */
export function advisoriesToRefresh(s: Store, names: Iterable<string>, olderThan: string): string[] {
  const have = registryAdvisories(s, names);
  return [...new Set(names)].filter((n) => {
    const h = have.get(n);
    return !h || h.fetchedAt < olderThan;
  });
}
