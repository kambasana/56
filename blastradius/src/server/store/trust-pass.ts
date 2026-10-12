/**
 * Tier 0 trust pass for stored entity data (migration 13; docs/WHO-BEHIND-PLAN.md "Tier 0").
 *
 * Scans stored before this build carry three overstatements that the engine no longer makes:
 *  - every machine link said `reviewed: true` → now false unless a human review decision says so
 *    (the KB incident hop stays reviewed: KB entries are hand-curated);
 *  - every repository owner whose type was unknown was typed `org:github/<login>` → the stored data
 *    cannot tell which ones were known, so every `org:github/` becomes `owner:github/` (type
 *    unknown). Leaving a type out is better than guessing; a rescan restores known orgs;
 *  - GitHub Sponsors handles stored as `account:github/<h> linked_to` → `funding:github/<h>`
 *    `receives_funding_at` (a funding page, not a person typed from a funding file);
 *  - Open Collective `funds` edges (backers of a collective attributed to the repo owner, and the
 *    collective itself typed as a funder) → removed. A rescan adds the neutral
 *    `receives_funding_at` link where the package names its own funding page.
 *
 * Pure functions: the migration applies them to scan.result_json, finding.finding_json and
 * finding.behind, and recomputes the stored hashes.
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { EntityChainEntry, Finding, HealthEntry, ScanResult } from '../../core/types.js';
import { renderJson } from '../../report/json.js';
import { deriveFinding } from './findings.js';

const KB_INCIDENT_ID = /^INC-\d{4}-\d{4}$/;

/** `org:github/x` → `owner:github/x`; other ids unchanged. */
export function untypedOwner(id: string): string {
  return id.startsWith('org:github/') ? `owner:github/${id.slice('org:github/'.length)}` : id;
}

/** One stored chain or behind list, after the trust pass. Returns the input when nothing changed. */
export function trustPassEntries(entries: readonly EntityChainEntry[] | undefined): EntityChainEntry[] | undefined {
  if (!entries) return entries;
  const out: EntityChainEntry[] = [];
  for (const e of entries) {
    if (e.relation === 'funds' || e.entityId.startsWith('funder:') || e.from?.startsWith('funder:')) continue;
    const next: EntityChainEntry = { ...e, entityId: untypedOwner(e.entityId) };
    // GitHub Sponsors handles were typed as accounts linked to the package; they are funding pages.
    const sponsor = /^account:github\/(.+)$/.exec(e.entityId);
    if (e.relation === 'linked_to' && sponsor && e.evidence?.[0]?.startsWith('https://github.com/sponsors/')) {
      next.entityId = `funding:github/${sponsor[1]}`;
      next.relation = 'receives_funding_at';
    }
    if (e.from !== undefined) next.from = untypedOwner(e.from);
    if (e.relation === 'incident') next.reviewed = KB_INCIDENT_ID.test(e.entityId);
    else if (e.reviewed !== undefined) next.reviewed = e.method === 'probabilistic' ? e.reviewed : false;
    out.push(next);
  }
  return out;
}

function passFinding<T extends Pick<Finding, 'entityChain' | 'behind'>>(f: T): T {
  const out = { ...f, entityChain: trustPassEntries(f.entityChain) ?? [] };
  if (f.behind) out.behind = trustPassEntries(f.behind)!;
  return out;
}

function passHealth(h: HealthEntry): HealthEntry {
  return h.behind ? { ...h, behind: trustPassEntries(h.behind)! } : h;
}

/** A stored scan result after the trust pass. */
export function trustPassResult(result: ScanResult): ScanResult {
  return {
    ...result,
    findings: (result.findings ?? []).map(passFinding),
    ...(result.health ? { health: result.health.map(passHealth) } : {}),
  };
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** Run inside migration 13's transaction: rewrite stored results, findings and their hashes, and fill scan_package_behind. */
export function trustPassMigration(db: DatabaseSync): void {
  const scans = db.prepare("SELECT id FROM scan WHERE result_json IS NOT NULL").all() as { id: string }[];
  const read = db.prepare('SELECT result_json FROM scan WHERE id = ?');
  const write = db.prepare('UPDATE scan SET result_json = ?, result_sha256 = ?, report_sha256 = ? WHERE id = ?');
  const behindRow = db.prepare('INSERT OR REPLACE INTO scan_package_behind (scan_id, purl, name, behind_json) VALUES (?, ?, ?, ?)');
  for (const { id } of scans) {
    const row = read.get(id) as { result_json: string } | undefined;
    let result: ScanResult;
    try {
      result = JSON.parse(row!.result_json) as ScanResult;
    } catch {
      continue;
    }
    const next = trustPassResult(result);
    const text = JSON.stringify(next);
    write.run(text, sha256(text), sha256(renderJson(next)), id);
    for (const r of packageBehindRows(next)) behindRow.run(id, r.purl, r.name, r.behindJson);
  }
  const findings = db.prepare('SELECT id, finding_json FROM finding').all() as { id: string; finding_json: string }[];
  const writeFinding = db.prepare('UPDATE finding SET finding_json = ?, behind = ? WHERE id = ?');
  for (const f of findings) {
    let parsed: Finding;
    try {
      parsed = JSON.parse(f.finding_json) as Finding;
    } catch {
      continue;
    }
    const next = passFinding(parsed);
    const behind = deriveFinding(next).behind;
    writeFinding.run(JSON.stringify(next), behind ? JSON.stringify(behind) : null, f.id);
  }
}

/** Unversioned npm name of a purl ("pkg:npm/%40babel/core@7.0.0" → "@babel/core"), else the purl. */
function nameOfPurl(purl: string): string {
  const m = /^pkg:[^/]+\/(.+?)(?:@[^@/]*)?$/.exec(purl);
  return m ? decodeURIComponent(m[1]!) : purl;
}

/** One row per health entry with a `behind` list (the "who is behind" graph of packages without findings). */
export function packageBehindRows(result: Pick<ScanResult, 'health'>): { purl: string; name: string; behindJson: string }[] {
  const out: { purl: string; name: string; behindJson: string }[] = [];
  for (const h of result.health ?? []) {
    if (!h.behind?.length) continue;
    out.push({ purl: h.purl, name: nameOfPurl(h.purl), behindJson: JSON.stringify(h.behind) });
  }
  return out;
}

export { passFinding as trustPassFinding };
