/**
 * OSV enricher: `vuln` and `malware` facts for npm components.
 *
 * 1. POST https://api.osv.dev/v1/querybatch with one query per npm component
 *    (chunks of ≤1000, following `next_page_token`). The batch answer only has
 *    ids, so
 * 2. GET https://api.osv.dev/v1/vulns/{id} for each distinct id (cached by the
 *    shared HttpClient) and turn each record into facts.
 *
 * Malware detection: an id or alias starting with "MAL-", a
 * `database_specific["malicious-packages-origins"]` block (OpenSSF
 * malicious-packages), `database_specific.malicious === true`, CWE-506
 * (Embedded Malicious Code). Free-text summaries are never used: ordinary
 * advisories routinely say "allows attackers to run malicious code", and a
 * text match would wrongly label a package malicious. Non-MAL advisories that are malware
 * (e.g. GitHub's GHSA malware advisories) produce both a `malware` and a
 * `vuln` fact; `MAL-*` records produce only `malware`.
 *
 * EPSS / KEV are not available from OSV; those optional fields are left unset.
 */
import type { EnrichContext, Enricher } from '../../core/plugin.js';
import { OfflineMissError, SkippedHosts } from '../../core/http.js';
import { makeFact } from '../../core/types.js';
import type { Component, Fact, Inventory, MalwareValue, PurlString, Severity, VulnValue } from '../../core/types.js';
import { cvss3BaseScore, severityForCvss, severityFromLabel } from './cvss.js';
import type { OsvBatchResponse, OsvQuery, OsvVuln } from './types.js';
import { cap, errorMessage, isExactVersion, mapLimit, safeHttpUrl } from './util.js';

export { cvss3BaseScore, severityForCvss, severityFromLabel } from './cvss.js';
export type * from './types.js';

export const OSV_API = 'https://api.osv.dev/v1';
/** OSV documents a 1000-query limit per querybatch call. */
export const OSV_BATCH_LIMIT = 1000;

export interface OsvEnricherOptions {
  /** API base URL (default https://api.osv.dev/v1). */
  baseUrl?: string;
  /** Queries per querybatch call (default and max 1000). */
  batchSize?: number;
  /** Parallel GET /vulns/{id} requests (default 8; HttpClient also rate-limits per host). */
  concurrency?: number;
  /** Max pagination rounds for a query with `next_page_token` (default 5). */
  maxPages?: number;
}

const SOURCE = 'osv';

/** A finite integer >= 1 (capped at `max`), or `fallback` for undefined/NaN/non-finite input. */
function positiveInt(v: number | undefined, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const n = v === undefined || !Number.isFinite(v) ? fallback : Math.floor(v);
  return Math.max(1, Math.min(n, max));
}
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function createOsvEnricher(opts: OsvEnricherOptions = {}): Enricher {
  const baseUrl = (opts.baseUrl ?? OSV_API).replace(/\/+$/, '');
  // Normalise numeric options so NaN/0/negative values cannot disable fetching or paging.
  const batchSize = positiveInt(opts.batchSize, OSV_BATCH_LIMIT, OSV_BATCH_LIMIT);
  const concurrency = positiveInt(opts.concurrency, 8);
  const maxPages = positiveInt(opts.maxPages, 5);

  return {
    name: SOURCE,
    async enrich(inv: Inventory, ctx: EnrichContext): Promise<Fact[]> {
      const problems = new Problems(ctx);
      const components = npmComponents(inv);
      if (components.length === 0) return [];

      // purl → OSV ids
      const idsByPurl = new Map<PurlString, Set<string>>();
      for (let i = 0; i < components.length; i += batchSize) {
        const chunk = components.slice(i, i + batchSize);
        await queryChunk(chunk, idsByPurl);
      }

      const allIds = [...new Set([...idsByPurl.values()].flatMap((s) => [...s]))].sort();
      const records = new Map<string, OsvVuln | null>();
      await mapLimit(allIds, concurrency, async (id) => {
        records.set(id, await fetchVuln(id));
      });

      const facts: Fact[] = [];
      for (const c of components) {
        const ids = idsByPurl.get(c.purl);
        if (!ids) continue;
        const recs = [...ids].sort().map((id) => records.get(id) ?? ({ id } as OsvVuln));
        facts.push(...osvRecordsToFacts(c, recs, ctx.now));
      }
      problems.flush();
      return facts;

      async function queryChunk(chunk: Component[], out: Map<PurlString, Set<string>>): Promise<void> {
        let pending: { c: Component; token?: string }[] = chunk.map((c) => ({ c }));
        for (let page = 0; page < maxPages && pending.length > 0; page++) {
          const queries: OsvQuery[] = pending.map(({ c, token }) => {
            const q: OsvQuery = { package: { name: c.name, ecosystem: 'npm' }, version: c.version };
            if (token) q.page_token = token;
            return q;
          });
          let res: OsvBatchResponse;
          try {
            res = await ctx.http.fetchJson<OsvBatchResponse>(`${baseUrl}/querybatch`, {
              method: 'POST',
              body: { queries },
            });
          } catch (e) {
            problems.add(e, `querybatch for ${pending.length} npm package(s)`);
            return;
          }
          const results = Array.isArray(res?.results) ? res.results : [];
          if (results.length !== queries.length) {
            problems.warn(`osv: querybatch returned ${results.length} result(s) for ${queries.length} query(ies); ignoring response`);
            return;
          }
          const next: { c: Component; token?: string }[] = [];
          results.forEach((r, idx) => {
            const c = pending[idx]!.c;
            for (const v of Array.isArray(r?.vulns) ? r.vulns : []) {
              const id = v?.id;
              if (typeof id !== 'string' || !ID_RE.test(id)) continue;
              let set = out.get(c.purl);
              if (!set) out.set(c.purl, (set = new Set()));
              set.add(id);
            }
            const token = r?.next_page_token;
            if (typeof token === 'string' && token.length > 0 && token.length < 4096) next.push({ c, token });
          });
          pending = next;
        }
        if (pending.length > 0) problems.warn(`osv: stopped paging after ${maxPages} page(s) for ${pending.length} package(s)`);
      }

      async function fetchVuln(id: string): Promise<OsvVuln | null> {
        try {
          return await ctx.http.fetchJsonOrNull<OsvVuln>(`${baseUrl}/vulns/${encodeURIComponent(id)}`);
        } catch (e) {
          problems.add(e, `vuln ${id}`);
          return null;
        }
      }
    },
  };
}

/** npm components with an exact version, sorted by purl (deterministic batches). */
function npmComponents(inv: Inventory): Component[] {
  return inv.components
    .filter((c) => c.ecosystem === 'npm' && typeof c.name === 'string' && c.name.length > 0 && c.name.length <= 214 && isExactVersion(c.version))
    .sort((a, b) => (a.purl < b.purl ? -1 : a.purl > b.purl ? 1 : 0));
}

/**
 * Convert OSV records already known to affect `component` into facts.
 * Exported for unit tests and for reuse (e.g. replaying recorded advisories).
 */
export function osvRecordsToFacts(component: Pick<Component, 'purl' | 'name'>, records: readonly OsvVuln[], now: Date): Fact[] {
  const facts: Fact[] = [];
  const malwareSeen = new Set<string>();
  const vulnSeen = new Set<string>();
  const meta = (evidence: string[]) => ({ source: SOURCE, fetchedAt: now, evidence });

  for (const rec of records) {
    if (!rec || typeof rec.id !== 'string' || !ID_RE.test(rec.id)) continue;
    if (typeof rec.withdrawn === 'string' && rec.withdrawn) continue;
    const id = rec.id;
    const aliases = cleanIds(rec.aliases).filter((a) => a !== id);
    const url = `https://osv.dev/vulnerability/${encodeURIComponent(id)}`;
    const evidence = [url, ...advisoryRefs(rec)].slice(0, 5);
    const summary = cap(rec.summary, 300) ?? cap(firstLine(rec.details), 300);
    const published = isoTimestamp(rec.published);

    if (isMalwareRecord(rec)) {
      const group = [id, ...aliases];
      if (!group.some((x) => malwareSeen.has(x))) {
        group.forEach((x) => malwareSeen.add(x));
        const value: MalwareValue = { id, origin: 'osv', url };
        if (summary) value.summary = summary;
        if (published) value.published = published;
        facts.push(makeFact('malware', component.purl, value, meta(evidence)));
      }
      if (id.startsWith('MAL-')) continue;
    }

    const group = [id, ...aliases];
    if (group.some((x) => vulnSeen.has(x))) continue;
    group.forEach((x) => vulnSeen.add(x));

    const value: VulnValue = { id, aliases, severity: 'unknown', fixedVersions: fixedVersions(rec, component.name), url };
    if (summary) value.summary = summary;
    const sev = severityOf(rec);
    value.severity = sev.severity;
    if (sev.cvss !== undefined) value.cvss = sev.cvss;
    if (sev.vector) value.cvssVector = sev.vector;
    if (published) value.published = published;
    facts.push(makeFact('vuln', component.purl, value, meta(evidence)));
  }
  return facts;
}

/** Whether an OSV record describes a malicious package/version rather than a bug. */
export function isMalwareRecord(rec: OsvVuln): boolean {
  const id = typeof rec.id === 'string' ? rec.id : '';
  if (id.startsWith('MAL-')) return true;
  if (cleanIds(rec.aliases).some((a) => a.startsWith('MAL-'))) return true;
  const db = isObject(rec.database_specific) ? rec.database_specific : {};
  if (db['malicious'] === true || 'malicious-packages-origins' in db) return true;
  const cwes = Array.isArray(db['cwe_ids']) ? db['cwe_ids'] : [];
  // Structured markers only; see the module comment for why summaries are not used.
  return cwes.includes('CWE-506');
}

/**
 * Severity of a record: CVSS v3 score computed from the vector when present,
 * otherwise the database's label (GitHub `database_specific.severity`), else
 * 'unknown'. A v4 vector is kept for display but not scored.
 */
export function severityOf(rec: OsvVuln): { severity: Severity; cvss?: number; vector?: string } {
  const sevs = Array.isArray(rec.severity) ? rec.severity : [];
  const v3 = sevs.find((s) => s?.type === 'CVSS_V3' && typeof s.score === 'string');
  if (v3?.score) {
    const score = cvss3BaseScore(v3.score);
    if (score !== undefined) return { severity: severityForCvss(score), cvss: score, vector: v3.score.slice(0, 200) };
  }
  const anyVector = sevs.find((s) => typeof s?.score === 'string' && s.score.startsWith('CVSS:'))?.score?.slice(0, 200);
  const db = isObject(rec.database_specific) ? rec.database_specific : {};
  let severity = severityFromLabel(db['severity']);
  if (severity === 'unknown') {
    // Some databases put the label in affected[].ecosystem_specific.severity / database_specific.severity.
    for (const a of Array.isArray(rec.affected) ? rec.affected : []) {
      severity = severityFromLabel(a?.ecosystem_specific?.['severity'] ?? a?.database_specific?.['severity']);
      if (severity !== 'unknown') break;
    }
  }
  return anyVector ? { severity, vector: anyVector } : { severity };
}

/** "fixed" events from SEMVER/ECOSYSTEM ranges of npm `affected` entries for this package. */
export function fixedVersions(rec: OsvVuln, packageName: string): string[] {
  const out = new Set<string>();
  const want = packageName.toLowerCase();
  for (const a of Array.isArray(rec.affected) ? rec.affected : []) {
    const pkg = a?.package;
    if (pkg?.ecosystem !== 'npm' || typeof pkg.name !== 'string' || pkg.name.toLowerCase() !== want) continue;
    for (const r of Array.isArray(a.ranges) ? a.ranges : []) {
      if (r?.type !== 'SEMVER' && r?.type !== 'ECOSYSTEM') continue;
      for (const ev of Array.isArray(r.events) ? r.events : []) {
        if (typeof ev?.fixed === 'string' && ev.fixed.length <= 128) out.add(ev.fixed);
      }
    }
  }
  return [...out];
}

function advisoryRefs(rec: OsvVuln): string[] {
  const refs = Array.isArray(rec.references) ? rec.references : [];
  const out: string[] = [];
  for (const r of refs) {
    if (r?.type !== 'ADVISORY' && r?.type !== 'REPORT') continue;
    const u = safeHttpUrl(r.url);
    if (u && !out.includes(u)) out.push(u);
  }
  return out;
}

function cleanIds(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && ID_RE.test(x)).slice(0, 50) : [];
}

function firstLine(s: unknown): string | undefined {
  return typeof s === 'string' ? s.split('\n').find((l) => l.trim().length > 0) : undefined;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Collects failures; offline misses are summarised in one warning. */
class Problems {
  private offlineMisses: string[] = [];
  private readonly skipped = new SkippedHosts();
  constructor(private readonly ctx: EnrichContext) {}
  add(e: unknown, what: string): void {
    if (this.skipped.add(e)) return;
    if (e instanceof OfflineMissError) this.offlineMisses.push(e.key);
    else this.warn(`osv: ${what} failed: ${errorMessage(e)}`);
  }
  warn(msg: string): void {
    this.ctx.warn?.(msg);
  }
  flush(): void {
    this.skipped.flush('osv', this.ctx.warn);
    if (this.offlineMisses.length === 0) return;
    this.warn(
      `osv: ${this.offlineMisses.length} request(s) had no fixture or cached response offline (e.g. ${this.offlineMisses[0]})`,
    );
    this.offlineMisses = [];
  }
}

/** Untrusted timestamp → canonical ISO string, or undefined. */
function isoTimestamp(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.length > 64) return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}
