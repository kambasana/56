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
import { makeFact, unversionedPurl } from '../../core/types.js';
import type { Fact, Inventory, PurlString } from '../../core/types.js';
import { aggregateHistory, mappingLookups } from '../../history/aggregate.js';
import { ensureClone, pruneCache, readHistory, runGit, type GitRun, type HistoryCacheOptions } from '../../history/git.js';
import { GraphqlBudget, mapLogins, DEFAULT_BUDGET_POINTS } from '../../history/graphql.js';
import { loadSalt } from '../../history/identity.js';
import { renameIds, type HistoryRecord } from '../../history/record.js';
import { mapLimit } from '../depsdev/util.js';

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
  /** Repositories per scan (default 300). */
  maxRepos?: number;
  /** Parallel clones (default 2). */
  concurrency?: number;
  /** Recorded histories by repo URL (tests, offline replays). */
  recorded?: (repoUrl: string) => HistoryRecord | undefined;
  /** Injected git runner (tests). */
  git?: GitRun;
  /** Receives the GraphQL budget after the run (tests, logs). */
  onBudget?: (b: GraphqlBudget) => void;
}

const GITHUB_REPO_RE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;

export function createHistoryEnricher(opts: HistoryEnricherOptions): Enricher {
  return {
    name: 'git',
    usesEarlierFacts: true,
    async enrich(_inv: Inventory, ctx: EnrichContext): Promise<Fact[]> {
      const byRepo = new Map<string, Set<PurlString>>();
      for (const f of opts.repoFacts()) {
        if (f.kind !== 'repo' || f.value.directory) continue;
        let url = f.value.url.replace(/\.git$/, '').replace(/\/+$/, '');
        // GitHub owner and repository names are case-insensitive: one clone per repository.
        if (url.startsWith('https://github.com/')) url = url.toLowerCase();
        if (!/^https:\/\/(github\.com|gitlab\.com|bitbucket\.org)\/[^/]+\/[^/]+$/.test(url)) continue;
        let s = byRepo.get(url);
        if (!s) byRepo.set(url, (s = new Set()));
        s.add(unversionedPurl(f.subject));
      }
      const repos = [...byRepo.keys()].sort().slice(0, opts.maxRepos ?? 300);
      if (repos.length === 0) return [];
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
            return;
          }
          try {
            const dir = await ensureClone(url, cache, opts.git ?? runGit);
            rec = await readHistory(dir, { repo: url, salt: getSalt(), ...(cache.timeoutMs ? { timeoutMs: cache.timeoutMs } : {}) }, opts.git ?? runGit);
          } catch (err) {
            ctx.warn?.(`git history: ${url}: ${(err as Error).message}`);
            return;
          }
        }
        let verified: { checked: number; verified: number } | undefined;
        const via = ['mailmap', 'github-noreply', 'salted-hash'];
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
        const agg = aggregateHistory(rec, ctx.now, { ...(verified ? { verified } : {}), identityVia: via });
        if (!agg) return;
        const meta = { source: 'git', fetchedAt: ctx.now, evidence: [url] };
        for (const subject of byRepo.get(url) ?? []) {
          facts.push(makeFact('contributors', subject, agg.contributors, meta));
          facts.push(makeFact('commit_history', subject, agg.history, meta));
        }
      });
      if (skippedOffline > 0) ctx.warn?.(`git history: ${skippedOffline} repositor${skippedOffline === 1 ? 'y' : 'ies'} skipped in offline mode`);
      if (mappingFailed > 0) ctx.warn?.(`git history: GitHub login mapping failed for ${mappingFailed} repositor${mappingFailed === 1 ? 'y' : 'ies'}; their contributors stay hashed`);
      if (budget.skipped > 0) ctx.warn?.(`git history: GraphQL budget of ${budget.limit} points reached; ${budget.skipped} request(s) not sent`);
      opts.onBudget?.(budget);
      return facts.sort((a, b) => a.subject.localeCompare(b.subject) || a.kind.localeCompare(b.kind));
    },
  };
}
