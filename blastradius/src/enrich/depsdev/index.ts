/**
 * deps.dev enricher: `provenance`, `repo`, `scorecard` and `dependents` facts
 * for npm components.
 *
 * Per npm component (name/version URL-encoded, so "@scope/name" → "%40scope%2Fname"):
 *   GET /v3/systems/npm/packages/{name}/versions/{version}   → provenance, repo link
 *   GET /v3/projects/{projectId}                              → OpenSSF Scorecard (memoised per project)
 *   GET /v3alpha/systems/npm/packages/{name}/versions/{version}:dependents → dependents
 * When deps.dev has no scorecard for a GitHub project, optionally falls back to
 *   GET https://api.securityscorecards.dev/projects/github.com/{owner}/{repo}
 *
 * Facts: provenance (versioned subject; emitted with hasProvenance=false when
 * deps.dev knows the version but lists no SLSA provenance/attestation), repo /
 * scorecard / dependents (unversioned subject, one per package).
 *
 * A 404 for a version (e.g. a package removed from the registry) yields no facts
 * and no warning. Offline misses are summarised in one warning.
 */
import type { EnrichContext, Enricher } from '../../core/plugin.js';
import { OfflineMissError, SkippedHosts } from '../../core/http.js';
import { makeFact, unversionedPurl } from '../../core/types.js';
import type { Component, DependentsValue, Fact, Inventory, ProvenanceValue, PurlString, RepoValue, ScorecardValue } from '../../core/types.js';
import { normalizeRepoUrl } from './repo.js';
import type { NormalizedRepo } from './repo.js';
import type { DepsDevDependents, DepsDevProject, DepsDevVersion, ScorecardApiResult, ScorecardCheck } from './types.js';
import { cap, errorMessage, isExactVersion, mapLimit, safeHttpUrl } from './util.js';

export { normalizeRepoUrl } from './repo.js';
export type { NormalizedRepo } from './repo.js';
export type * from './types.js';

export const DEPSDEV_API = 'https://api.deps.dev';
export const SCORECARD_API = 'https://api.securityscorecards.dev';

export interface DepsDevEnricherOptions {
  /** deps.dev base URL (default https://api.deps.dev); `/v3` and `/v3alpha` are appended. */
  baseUrl?: string;
  /** Scorecard API base (default https://api.securityscorecards.dev). */
  scorecardBaseUrl?: string;
  /** Query the Scorecard API when deps.dev has no scorecard for a GitHub repo (default true). */
  scorecardFallback?: boolean;
  /** Query the v3alpha dependents endpoint (default true). */
  dependents?: boolean;
  /** Components processed in parallel (default 4; HttpClient also rate-limits per host). */
  concurrency?: number;
}

const SOURCE = 'depsdev';

interface SourcedScorecard {
  value: ScorecardValue;
  /** 'depsdev' (GetProject) or 'scorecard' (Scorecard API fallback). */
  source: string;
}

export function createDepsDevEnricher(opts: DepsDevEnricherOptions = {}): Enricher {
  const base = (opts.baseUrl ?? DEPSDEV_API).replace(/\/+$/, '');
  const scBase = (opts.scorecardBaseUrl ?? SCORECARD_API).replace(/\/+$/, '');
  const scorecardFallback = opts.scorecardFallback ?? true;
  const wantDependents = opts.dependents ?? true;
  const concurrency = opts.concurrency ?? 4;

  return {
    name: SOURCE,
    async enrich(inv: Inventory, ctx: EnrichContext): Promise<Fact[]> {
      const problems = new Problems(ctx);
      const components = inv.components
        .filter((c) => c.ecosystem === 'npm' && c.name.length > 0 && c.name.length <= 214 && isExactVersion(c.version))
        .sort((a, b) => (a.purl < b.purl ? -1 : a.purl > b.purl ? 1 : 0));

      const projects = new Map<string, Promise<SourcedScorecard | undefined>>();
      const perComponent = await mapLimit(components, concurrency, (c) => enrichOne(c));

      // Package-level facts: keep one per (kind, unversioned subject), deterministically.
      const facts: Fact[] = [];
      const pkgSeen = new Set<string>();
      const dependents = new Map<PurlString, Fact & { kind: 'dependents' }>();
      for (const list of perComponent) {
        for (const f of list) {
          if (f.kind === 'provenance') facts.push(f);
          else if (f.kind === 'dependents') {
            const prev = dependents.get(f.subject);
            if (!prev || f.value.count > prev.value.count) dependents.set(f.subject, f);
          } else {
            const key = `${f.kind} ${f.subject}`;
            if (!pkgSeen.has(key)) {
              pkgSeen.add(key);
              facts.push(f);
            }
          }
        }
      }
      facts.push(...dependents.values());
      problems.flush();
      return facts;

      async function enrichOne(c: Component): Promise<Fact[]> {
        const out: Fact[] = [];
        const name = encodeURIComponent(c.name);
        const version = encodeURIComponent(c.version);
        const pkg = unversionedPurl(c.purl);
        const page = `https://deps.dev/npm/${name}/${version}`;
        const meta = (evidence: (string | undefined)[], source = SOURCE) => ({
          source,
          fetchedAt: ctx.now,
          evidence: [...new Set(evidence.filter((e): e is string => !!e))],
        });

        let v: DepsDevVersion | null;
        try {
          v = await ctx.http.fetchJsonOrNull<DepsDevVersion>(`${base}/v3/systems/npm/packages/${name}/versions/${version}`);
        } catch (e) {
          problems.add(e, `version ${c.name}@${c.version}`);
          return out;
        }
        if (!v || typeof v !== 'object') return out;

        const provenance = provenanceOf(v);
        out.push(makeFact('provenance', c.purl, provenance, meta([page, provenance.url])));

        const repo = repoOf(v);
        if (repo) {
          const value: RepoValue = { url: repo.url, host: repo.host, via: repo.via };
          if (repo.owner) value.owner = repo.owner;
          if (repo.name) value.name = repo.name;
          out.push(makeFact('repo', pkg, value, meta([page])));

          if (repo.projectId && repo.host !== 'other') {
            let p = projects.get(repo.projectId);
            if (!p) projects.set(repo.projectId, (p = scorecardFor(repo)));
            const sc = await p;
            if (sc) {
              out.push(makeFact('scorecard', pkg, sc.value, meta([`https://scorecard.dev/viewer/?uri=${repo.projectId}`], sc.source)));
            }
          }
        }

        if (wantDependents) {
          try {
            const d = await ctx.http.fetchJsonOrNull<DepsDevDependents>(
              `${base}/v3alpha/systems/npm/packages/${name}/versions/${version}:dependents`,
            );
            const value = d ? dependentsOf(d) : undefined;
            if (value) out.push(makeFact('dependents', pkg, value, meta([`${page}/dependents`])));
          } catch (e) {
            problems.add(e, `dependents ${c.name}@${c.version}`);
          }
        }
        return out;
      }

      async function scorecardFor(repo: NormalizedRepo): Promise<SourcedScorecard | undefined> {
        const id = repo.projectId!;
        try {
          const p = await ctx.http.fetchJsonOrNull<DepsDevProject>(`${base}/v3/projects/${encodeURIComponent(id)}`);
          const sc = p ? scorecardFromDepsDev(p, id) : undefined;
          if (sc) return { value: sc, source: SOURCE };
        } catch (e) {
          problems.add(e, `project ${id}`);
        }
        if (!scorecardFallback || repo.host !== 'github' || !repo.owner || !repo.name) return undefined;
        try {
          const r = await ctx.http.fetchJsonOrNull<ScorecardApiResult>(
            `${scBase}/projects/github.com/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`,
          );
          const sc = r ? scorecardFromApi(r, id) : undefined;
          return sc ? { value: sc, source: 'scorecard' } : undefined;
        } catch (e) {
          // The fallback is best effort: stay quiet offline, warn on real errors.
          if (!(e instanceof OfflineMissError)) problems.add(e, `scorecard ${id}`);
          return undefined;
        }
      }
    },
  };
}

/** Provenance from a GetVersion response. */
export function provenanceOf(v: DepsDevVersion): ProvenanceValue {
  const slsa = (Array.isArray(v.slsaProvenances) ? v.slsaProvenances : []).filter((p) => p && typeof p === 'object');
  const att = (Array.isArray(v.attestations) ? v.attestations : []).filter((a) => a && typeof a === 'object');
  const pickedSlsa = slsa.find((p) => p.verified === true);
  const pickedAtt = att.find((a) => a.verified === true);
  const picked = pickedSlsa ?? pickedAtt;
  if (!picked) return { hasProvenance: false };
  const value: ProvenanceValue = { hasProvenance: true, type: pickedSlsa ? 'slsa-v1' : 'npm-attestation' };
  const repo = normalizeRepoUrl(picked.sourceRepository);
  if (repo) value.sourceRepo = repo.url;
  const url = safeHttpUrl(picked.url);
  if (url) value.url = url;
  return value;
}

/**
 * Source repository for a version: a SOURCE_REPO related project backed by an
 * SLSA attestation first, then any SOURCE_REPO related project, then the
 * SOURCE_REPO link from package metadata.
 */
export function repoOf(v: DepsDevVersion): (NormalizedRepo & { via: string }) | undefined {
  const related = (Array.isArray(v.relatedProjects) ? v.relatedProjects : []).filter((r) => r?.relationType === 'SOURCE_REPO');
  const ordered = [
    ...related.filter((r) => r.relationProvenance === 'SLSA_ATTESTATION'),
    ...related.filter((r) => r.relationProvenance !== 'SLSA_ATTESTATION'),
  ];
  for (const r of ordered) {
    const n = normalizeRepoUrl(r.projectKey?.id);
    if (n) return { ...n, via: r.relationProvenance === 'SLSA_ATTESTATION' ? 'provenance' : 'depsdev.links' };
  }
  for (const l of Array.isArray(v.links) ? v.links : []) {
    if (l?.label !== 'SOURCE_REPO') continue;
    const n = normalizeRepoUrl(l.url);
    if (n) return { ...n, via: 'depsdev.links' };
  }
  return undefined;
}

export function scorecardFromDepsDev(p: DepsDevProject, projectId: string): ScorecardValue | undefined {
  const sc = p.scorecard;
  if (!sc || typeof sc !== 'object') return undefined;
  return buildScorecard(sc.overallScore, sc.date, sc.repository?.name ?? projectId, sc.checks);
}

export function scorecardFromApi(r: ScorecardApiResult, projectId: string): ScorecardValue | undefined {
  return buildScorecard(r.score, r.date, r.repo?.name ?? projectId, r.checks);
}

function buildScorecard(score: unknown, date: unknown, repo: unknown, checks: unknown): ScorecardValue | undefined {
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0) return undefined;
  const value: ScorecardValue = {
    score: Math.min(10, score),
    repo: typeof repo === 'string' && repo.length <= 300 ? repo : '',
    checks: (Array.isArray(checks) ? (checks as ScorecardCheck[]) : [])
      .filter((c) => typeof c?.name === 'string' && typeof c.score === 'number' && c.score >= 0) // -1 = not applicable
      .slice(0, 50)
      .map((c) => {
        const check: ScorecardValue['checks'][number] = { name: c.name!.slice(0, 100), score: Math.min(10, c.score!) };
        const reason = cap(c.reason, 300);
        if (reason) check.reason = reason;
        return check;
      }),
  };
  if (typeof date === 'string' && date.length <= 40) value.date = date;
  return value;
}

/** deps.dev returns int64 counts as JSON strings or numbers. */
export function dependentsOf(d: DepsDevDependents): DependentsValue | undefined {
  const count = toCount(d.dependentCount);
  if (count === undefined) return undefined;
  const value: DependentsValue = { count };
  const direct = toCount(d.directDependentCount);
  const indirect = toCount(d.indirectDependentCount);
  if (direct !== undefined) value.direct = direct;
  if (indirect !== undefined) value.indirect = indirect;
  return value;
}

function toCount(v: unknown): number | undefined {
  const n = typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : v;
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

class Problems {
  private offlineMisses: string[] = [];
  private readonly skipped = new SkippedHosts();
  constructor(private readonly ctx: EnrichContext) {}
  add(e: unknown, what: string): void {
    if (this.skipped.add(e)) return;
    if (e instanceof OfflineMissError) this.offlineMisses.push(e.key);
    else this.ctx.warn?.(`depsdev: ${what} failed: ${errorMessage(e)}`);
  }
  flush(): void {
    this.skipped.flush('depsdev', this.ctx.warn);
    if (this.offlineMisses.length === 0) return;
    this.ctx.warn?.(
      `depsdev: ${this.offlineMisses.length} request(s) had no fixture or cached response offline (e.g. ${this.offlineMisses[0]})`,
    );
    this.offlineMisses = [];
  }
}
