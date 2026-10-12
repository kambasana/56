/**
 * Git history enricher (docs/WHO-BEHIND-PLAN.md P2: S2, C1, C2, C3): `contributors` and
 * `commit_history` facts for every package whose source repository is known from earlier `repo`
 * facts. Opt-in (`--history`), because it clones repositories.
 *
 *   repo facts → blobless bare clone cache (src/history/git.ts) → read in fixed formats, emails
 *   turned into salted hashes / no-reply logins at once → optional GitHub GraphQL login mapping and
 *   verification within a point budget (src/history/graphql.ts) → repo-level aggregates
 *   (src/history/aggregate.ts) → facts. The raw history is never stored.
 *
 * Offline: answers from recorded histories (`recorded`) or skips with one summary warning.
 */
import path from 'node:path';
import { defaultCacheDir } from '../../core/paths.js';
import type { EnrichContext, Enricher } from '../../core/plugin.js';
import { makeFact, npmNameFromPurl, parsePurl, unversionedPurl } from '../../core/types.js';
import type { Fact, Inventory, PurlString, ReleasePublishersValue } from '../../core/types.js';
import { aggregateHistory, mappingLookups } from '../../history/aggregate.js';
import { ensureClone, pruneCache, readHistory, runGit, type GitRun, type HistoryCacheOptions } from '../../history/git.js';
import { GraphqlBudget, mapLogins, DEFAULT_BUDGET_POINTS } from '../../history/graphql.js';
import { npmContinuity } from '../../history/continuity.js';
import { loadSalt, localIdentity } from '../../history/identity.js';
import { renameIds, type HistoryRecord } from '../../history/record.js';
import { mergeIdentities } from '../../history/merge.js';
import { mapLimit } from '../depsdev/util.js';
import { orderRepos } from '../../stability/priority.js';
import { sameRepo } from '../../stability/repo.js';
import { fetchPackument, isObject } from '../npm/registry.js';

export interface HistoryEnricherOptions {
  /** Facts produced earlier in the scan (the `repo` facts). */
  repoFacts: () => readonly Fact[];
  /** Clone cache options; default dir: <cache>/git-history. */
  cache?: Partial<HistoryCacheOptions>;
  /** Salt for email hashes (default: $BLASTRADIUS_HASH_SALT or a secret file next to the cache). */
  salt?: Buffer | string;
  /** GitHub token for the GraphQL mapping; default $GITHUB_TOKEN. Empty = no mapping. */
  token?: string;
  /** GraphQL points per scan (default 2,000). */
  budgetPoints?: number;
  /** Repositories per scan (default 300; CLI --history-max). Picked by priority: direct runtime, then production fan-in. */
  maxRepos?: number;
  /** Receives which repositories were read, left out by the cap, or failed (coverage line). */
  onSelection?: (s: HistorySelection) => void;
  /** Parallel clones (default 2). */
  concurrency?: number;
  /** Recorded histories by repo URL (tests, offline replays). */
  recorded?: (repoUrl: string) => HistoryRecord | undefined;
  /** Injected git runner (tests). */
  git?: GitRun;
  /** Receives the GraphQL budget after the run (tests, logs). */
  onBudget?: (b: GraphqlBudget) => void;
}

export interface HistorySelection {
  /** Repositories declared by packages in the scan. */
  declared: number;
  /** Repositories read (git history facts produced). */
  read: string[];
  /** Left out by the per-scan cap. */
  capped: string[];
  /** Could not be cloned or read, or skipped offline. */
  failed: string[];
  maxRepos: number;
}

export const DEFAULT_HISTORY_MAX = 300;

/** The version in a release tag name: "v19.0.1" → "19.0.1", "xz-5.2" → "5.2", "pkg@1.2.3" → "1.2.3". */
export function releaseVersion(tag: string): string {
  const m = /(\d+(?:\.\d+)+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag);
  return m ? m[1]! : tag;
}

const GITHUB_REPO_RE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;

export function createHistoryEnricher(opts: HistoryEnricherOptions): Enricher {
  return {
    name: 'git',
    usesEarlierFacts: true,
    async enrich(inv: Inventory, ctx: EnrichContext): Promise<Fact[]> {
      const byRepo = new Map<string, Set<PurlString>>();
      // Tier 0: a package that moved is read at the repository its latest release declares
      // (agent-base: TooTallNate/proxy-agents, not the archived node-agent-base).
      const latestRepo = new Map<PurlString, string>();
      for (const f of opts.repoFacts()) if (f.kind === 'release_age' && f.value.latestRepository) latestRepo.set(unversionedPurl(f.subject), f.value.latestRepository.url);
      for (const f of opts.repoFacts()) {
        // A package in a monorepo subdirectory gets the facts of the whole repository (repo-level by
        // design; the stability label says so). One clone per repository either way.
        if (f.kind !== 'repo') continue;
        const latest = latestRepo.get(unversionedPurl(f.subject));
        let url = (latest && !sameRepo(latest, f.value.url) ? latest : f.value.url).replace(/\.git$/, '').replace(/\/+$/, '');
        // GitHub owner and repository names are case-insensitive: one clone per repository.
        if (url.startsWith('https://github.com/')) url = url.toLowerCase();
        if (!/^https:\/\/(github\.com|gitlab\.com|bitbucket\.org)\/[^/]+\/[^/]+$/.test(url)) continue;
        let s = byRepo.get(url);
        if (!s) byRepo.set(url, (s = new Set()));
        s.add(unversionedPurl(f.subject));
      }
      const publishersOf = new Map<PurlString, ReleasePublishersValue>();
      for (const f of opts.repoFacts()) if (f.kind === 'release_publishers') publishersOf.set(unversionedPurl(f.subject), f.value);
      const maxRepos = opts.maxRepos ?? DEFAULT_HISTORY_MAX;
      const ordered = orderRepos(byRepo, inv);
      const repos = ordered.slice(0, maxRepos);
      const selection: HistorySelection = { declared: ordered.length, read: [], capped: ordered.slice(maxRepos), failed: [], maxRepos };
      if (selection.capped.length > 0) ctx.warn?.(`git history: ${ordered.length} repositories declared; read the first ${maxRepos} by priority (direct runtime dependencies, then production fan-in); ${selection.capped.length} left to the Scorecard / npm fallback (raise with --history-max)`);
      if (repos.length === 0) {
        opts.onSelection?.(selection);
        return [];
      }
      const cacheDir = opts.cache?.dir ?? path.join(defaultCacheDir(), 'git-history');
      const cache: HistoryCacheOptions = { ...opts.cache, dir: cacheDir };
      // The salt is loaded only when a repository is actually read (recorded histories are already hashed).
      let salt = opts.salt;
      const getSalt = () => (salt ??= loadSalt(path.join(cacheDir, '..', 'history-salt')));
      const token = opts.token ?? process.env.GITHUB_TOKEN ?? '';
      const budget = new GraphqlBudget(opts.budgetPoints ?? DEFAULT_BUDGET_POINTS);
      const facts: Fact[] = [];
      let skippedOffline = 0;
      let mappingFailed = 0;
      if (!ctx.offline && !opts.recorded) await pruneCache(cache).catch(() => 0);

      await mapLimit(repos, opts.concurrency ?? 2, async (url) => {
        let rec: HistoryRecord | undefined = opts.recorded?.(url);
        if (!rec) {
          if (ctx.offline) {
            skippedOffline++;
            selection.failed.push(url);
            return;
          }
          try {
            const dir = await ensureClone(url, cache, opts.git ?? runGit);
            rec = await readHistory(dir, { repo: url, salt: getSalt(), ...(cache.timeoutMs ? { timeoutMs: cache.timeoutMs } : {}) }, opts.git ?? runGit);
          } catch (err) {
            ctx.warn?.(`git history: ${url}: ${(err as Error).message}`);
            selection.failed.push(url);
            return;
          }
        }
        let verified: { checked: number; verified: number } | undefined;
        const via = ['mailmap', 'github-noreply', 'salted-hash'];
        // S5a npm side (P3) and the npm-publisher identity merge (Tier 0): which ids the registry
        // addresses of each npm account that published a package of this repository hash to.
        if (!rec.npmPublisherIds && !ctx.offline && !opts.recorded) {
          const links: Record<string, string> = {};
          const ids: Record<string, string[]> = {};
          for (const subject of byRepo.get(url) ?? []) {
            if (!publishersOf.has(subject)) continue;
            const l = await publisherLinks(ctx, subject, rec, getSalt);
            for (const [a, list] of Object.entries(l)) {
              links[a] ??= list[0]!;
              ids[a] = [...new Set([...(ids[a] ?? []), ...list])];
            }
          }
          rec = { ...rec, npmPublishers: { ...(rec.npmPublishers ?? {}), ...links }, npmPublisherIds: ids };
        }
        // Tier 0 identity merge: display name plus overlapping activity, then the npm publisher
        // (.mailmap was applied by git while reading).
        const merged = mergeIdentities(rec);
        rec = merged.rec;
        if (merged.namesAvailable) via.splice(1, 0, 'display-name');
        if (rec.npmPublisherIds) via.splice(via.indexOf('salted-hash'), 0, 'npm-publisher');
        const gh = GITHUB_REPO_RE.exec(url);
        if (gh && token && !ctx.offline) {
          try {
            const m = await mapLogins(ctx.http, { owner: gh[1]!, name: gh[2]! }, mappingLookups(rec, ctx.now), { token, budget });
            const rename = new Map(m.logins);
            for (const c of rec.commits) {
              const login = m.commitLogins.get(c.oid);
              if (login && c.author.startsWith('hash:') && !rename.has(c.author)) rename.set(c.author, login);
            }
            rec = renameIds(rec, rename);
            verified = m.verified;
            via.splice(2, 0, 'github-graphql');
          } catch {
            mappingFailed++;
          }
        }
        const agg = aggregateHistory(rec, ctx.now, {
          ...(verified ? { verified } : {}),
          identityVia: via,
          // Identities are resolved when display names were compared or GitHub mapped logins.
          identityResolved: merged.namesAvailable || verified !== undefined,
          merged: merged.merged,
        });
        if (!agg) {
          selection.failed.push(url);
          return;
        }
        selection.read.push(url);
        const meta = { source: 'git', fetchedAt: ctx.now, evidence: [url] };
        for (const subject of byRepo.get(url) ?? []) {
          facts.push(makeFact('contributors', subject, agg.contributors, meta));
          // S5a npm side (P3): per package, from the npm publishers matched to this history.
          const pubs = publishersOf.get(subject);
          if (!pubs) {
            facts.push(makeFact('commit_history', subject, agg.history, meta));
            continue;
          }
          const npm = npmContinuity(rec, pubs, ctx.now);
          // Tier 0: a git-side release observation whose release was published to npm through
          // trusted publishing (the project's CI, an OIDC identity) is not a person's release.
          const trusted = new Set(pubs.trustedVersions ?? []);
          const viaCi = (c: { kind: string; release?: string }) => (c.kind === 'release_by_new_person' || c.kind === 'release_takeover' || c.kind === 'release_handover') && c.release !== undefined && trusted.has(releaseVersion(c.release));
          const history = {
            ...agg.history,
            changes: [...agg.history.changes.filter((c) => !viaCi(c)), ...npm.changes].sort((a, b) => b.date.localeCompare(a.date) || a.kind.localeCompare(b.kind)),
            npmPublishers: { total: npm.accounts, matched: npm.matched },
          };
          facts.push(makeFact('commit_history', subject, history, meta));
        }
      });
      if (skippedOffline > 0) ctx.warn?.(`git history: ${skippedOffline} repositor${skippedOffline === 1 ? 'y' : 'ies'} skipped in offline mode`);
      if (mappingFailed > 0) ctx.warn?.(`git history: GitHub login mapping failed for ${mappingFailed} repositor${mappingFailed === 1 ? 'y' : 'ies'}; their contributors stay hashed`);
      if (budget.skipped > 0) ctx.warn?.(`git history: GraphQL budget of ${budget.limit} points reached; ${budget.skipped} request(s) not sent`);
      opts.onBudget?.(budget);
      selection.read.sort();
      selection.failed.sort();
      opts.onSelection?.(selection);
      return facts.sort((a, b) => a.subject.localeCompare(b.subject) || a.kind.localeCompare(b.kind));
    },
  };
}

/**
 * npm account → id in this history, through the registry e-mail address of each release's
 * publisher (`_npmUser.email`), hashed in memory with the history salt; only matches are kept and
 * the addresses are dropped at once. Empty on any failure (no observation without a match).
 */
async function publisherLinks(ctx: EnrichContext, subject: PurlString, rec: HistoryRecord, salt: () => Buffer | string): Promise<Record<string, string[]>> {
  const p = parsePurl(subject);
  if (p.type !== 'npm') return {};
  let packument;
  try {
    packument = await fetchPackument(ctx.http, npmNameFromPurl(p));
  } catch {
    return {};
  }
  if (!packument || !isObject(packument.versions)) return {};
  const ids = new Set<string>();
  for (const c of rec.commits) {
    ids.add(c.author);
    ids.add(c.committer);
  }
  for (const t of rec.tags) ids.add(t.by);
  // Every version's address, not only the first: an account whose address changed links both ids.
  const out: Record<string, string[]> = {};
  for (const m of Object.values(packument.versions)) {
    const u = isObject(m) && isObject(m._npmUser) ? m._npmUser : undefined;
    if (typeof u?.name !== 'string' || typeof u.email !== 'string') continue;
    const id = localIdentity(u.email, salt());
    if (!ids.has(id)) continue;
    const l = (out[u.name] ??= []);
    if (!l.includes(id)) l.push(id);
  }
  return out;
}
