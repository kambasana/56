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
import { cacheKey, CloneBudget, ensureClone, pruneCache, readHistory, runGit, type GitRun, type HistoryCacheOptions } from '../../history/git.js';
import { addMonths } from '../../history/aggregate.js';
import { GraphqlBudget, mapLogins, DEFAULT_BUDGET_POINTS } from '../../history/graphql.js';
import { isPrereleaseVersion, npmContinuity } from '../../history/continuity.js';
import { isHistoryRepoUrl } from '../../history/repo-url.js';
import { loadSalt, localIdentity } from '../../history/identity.js';
import { renameIds, type HistoryRecord } from '../../history/record.js';
import { mergeIdentities } from '../../history/merge.js';
import { isReleaseBot } from '../../history/bots.js';
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
  /**
   * Disk budget of the clone cache in MB (default 600; CLI --history-max-mb). Least recently used
   * clones are deleted to stay under it; one clone may take at most budget / (concurrency + 1) (and
   * 300 MB), and a larger repository is skipped.
   */
  maxMb?: number;
  /**
   * Shallow clones (git --shallow-since) covering this many months (default 60: the 24-month CAF,
   * the 12-month windows and a 24-month look-back for first-seen dates); 0 = whole history. A
   * repository whose last commit is older is deepened to its whole history (git.ts).
   */
  shallowMonths?: number;
  /** Receives which repositories were read, left out by the cap, or failed (coverage line). */
  onSelection?: (s: HistorySelection) => void;
  /** Parallel clones (default 2). */
  concurrency?: number;
  /** Recorded histories by repo URL (tests, offline replays). */
  recorded?: (repoUrl: string) => HistoryRecord | undefined;
  /** Injected git runner (tests). */
  git?: GitRun;
  /**
   * Tier 0.5 cross-registry sibling check: the earliest release an npm account published of another
   * package whose repository has the same owner (fastify/process-warning's 5.1.0 publisher already
   * published fastify). Default: the npm search API (`maintainer:<account>`) and those packuments;
   * tests inject recorded answers. Asked only for observations that would otherwise count.
   */
  siblingLookup?: (account: string, owner: string, exclude: string) => Promise<SiblingRelease | undefined>;
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
  /** Tier 0.5: stopped because the clone grew past the per-repository cap of the disk budget. */
  tooLarge?: string[];
  /** Disk budget (MB), per-clone cap (MB), the largest the cache got (MB), clones evicted, shallow window (months; 0 = full). */
  budget?: { maxMb: number; perCloneMb: number; peakMb: number; evicted: number; shallowMonths: number };
}

export const DEFAULT_HISTORY_MAX = 300;
/** Default disk budget of the history clone cache, MB (Tier 0.5). */
export const DEFAULT_HISTORY_MAX_MB = 600;
/** Default shallow window, months (Tier 0.5). */
export const DEFAULT_SHALLOW_MONTHS = 60;

/**
 * Ecosystems whose history results are never used (Tier 0.5): CI actions and container images get no
 * upkeep label, so their repositories are not cloned. npm and PyPI packages are labelled; other
 * package subjects (e.g. pkg:generic/xz-utils) keep their history report.
 */
export const HISTORY_SKIPPED_ECOSYSTEMS: ReadonlySet<string> = new Set(['githubactions', 'docker', 'oci']);

export interface SiblingRelease {
  /** The sibling package. */
  name: string;
  /** When the account first published it (ISO). */
  firstAt: string;
}

/** The version in a release tag name: "v19.0.1" → "19.0.1", "xz-5.2" → "5.2", "pkg@1.2.3" → "1.2.3". */
export function releaseVersion(tag: string): string {
  const m = /(\d+(?:\.\d+)+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag);
  return m ? m[1]! : tag;
}

/** npm name of an npm purl ("@scope/name"), else the purl. */
function subjectName(subject: PurlString): string {
  const p = parsePurl(subject);
  return p.type === 'npm' ? npmNameFromPurl(p) : subject;
}

/**
 * Whether a release tag belongs to a package (Tier 0): an unprefixed tag ("v1.2.3") belongs to every
 * package of the repository; a prefixed one ("projectify-v5.0.0", "@scope/name@1.2.3") only to the
 * package whose name, short name or monorepo directory it names. googleapis/google-cloud-node tags
 * every package's releases in one repository.
 */
export function tagBelongsTo(tag: string, name: string, directory?: string): boolean {
  const m = /^(.*?)[-@_/]?v?\d+(?:[._]\d+)+(?:[-+.][0-9A-Za-z.-]+)?$/.exec(tag);
  const prefix = (m?.[1] ?? '').replace(/[-@_/]+$/, '').toLowerCase();
  if (!prefix || /^(release|rel|version|ver|tag)$/.test(prefix)) return true;
  const short = name.replace(/^@[^/]+\//, '').toLowerCase();
  const dirBase = directory?.split('/').filter(Boolean).pop()?.toLowerCase();
  const variants = new Set([name.toLowerCase(), short, short.replace(/^node-|-nodejs$|^nodejs-/g, ''), ...(dirBase ? [dirBase] : [])]);
  return variants.has(prefix) || variants.has(prefix.replace(/^node-|-nodejs$|^nodejs-/g, ''));
}

/**
 * When each npm account first published a package of the same repository owner or npm scope as
 * `subject` (other than `subject` itself): "already a team member" for the S5a checks (Tier 0).
 */
function siblingPublishers(publishersOf: ReadonlyMap<PurlString, ReleasePublishersValue>, ownerOf: ReadonlyMap<PurlString, string>): (subject: PurlString, account: string, atMs: number) => boolean {
  const scopeOf = (s: PurlString) => /^pkg:npm\/(%40[^/]+)\//.exec(s)?.[1];
  const groups = new Map<string, Map<string, { first: number; subject: PurlString }[]>>();
  for (const [subject, pubs] of publishersOf) {
    const keys = [ownerOf.get(subject) ? `owner:${ownerOf.get(subject)}` : undefined, scopeOf(subject) ? `scope:${scopeOf(subject)}` : undefined].filter((k): k is string => !!k);
    for (const k of keys) {
      let g = groups.get(k);
      if (!g) groups.set(k, (g = new Map()));
      for (const a of pubs.accounts) {
        const t = Date.parse(a.firstAt);
        if (!Number.isFinite(t)) continue;
        const l = g.get(a.name) ?? [];
        l.push({ first: t, subject });
        g.set(a.name, l);
      }
    }
  }
  return (subject, account, atMs) => {
    const keys = [ownerOf.get(subject) ? `owner:${ownerOf.get(subject)}` : undefined, scopeOf(subject) ? `scope:${scopeOf(subject)}` : undefined].filter((k): k is string => !!k);
    return keys.some((k) => (groups.get(k)?.get(account) ?? []).some((e) => e.subject !== subject && e.first < atMs));
  };
}

/** Release-continuity (S5a) observation kinds. */
const S5A_KINDS: ReadonlySet<string> = new Set(['release_by_new_person', 'release_takeover', 'npm_release_by_new_account']);

/** Owner of a repository URL ("https://github.com/fastify/fastify" → "fastify"), lower case. */
function repoOwner(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const m = /^(?:git\+)?(?:https?|ssh|git):\/\/(?:[^@/]+@)?(?:www\.)?(github\.com|gitlab\.com|bitbucket\.org)[/:]([^/]+)\//i.exec(url) ?? /^(?:git@)?(github\.com|gitlab\.com|bitbucket\.org):([^/]+)\//i.exec(url);
  return m ? m[2]!.toLowerCase() : undefined;
}

/** How many same-owner packages of an account are checked (packument fetches) at most. */
const SIBLING_CANDIDATES = 5;

/**
 * Default cross-registry sibling lookup (Tier 0.5): the packages an npm account maintains (npm
 * search API, `maintainer:<account>`), those whose repository has `owner`, and the earliest release
 * the account published of any of them (packument `_npmUser`). Network; undefined on any failure.
 */
export async function npmSiblingRelease(ctx: Pick<EnrichContext, 'http'>, account: string, owner: string, exclude: string): Promise<SiblingRelease | undefined> {
  const res = await ctx.http.fetchJsonOrNull<{ objects?: { package?: { name?: unknown; links?: { repository?: unknown } } }[] }>(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(`maintainer:${account}`)}&size=250`);
  const names = (res?.objects ?? [])
    .map((o) => o.package)
    .filter((p): p is { name: string; links?: { repository?: unknown } } => typeof p?.name === 'string' && p.name !== exclude)
    .filter((p) => repoOwner(typeof p.links?.repository === 'string' ? p.links.repository : undefined) === owner.toLowerCase())
    .map((p) => p.name)
    .sort()
    .slice(0, SIBLING_CANDIDATES);
  let best: SiblingRelease | undefined;
  for (const name of names) {
    const pk = await fetchPackument(ctx.http, name).catch(() => null);
    if (!pk || !isObject(pk.versions) || !isObject(pk.time)) continue;
    for (const [v, m] of Object.entries(pk.versions)) {
      const by = isObject(m) && isObject(m._npmUser) ? m._npmUser.name : undefined;
      const t = (pk.time as Record<string, unknown>)[v];
      if (by !== account || typeof t !== 'string') continue;
      if (!best || t < best.firstAt) best = { name, firstAt: t };
    }
  }
  return best;
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
        // Tier 0.5: no clone whose result would be thrown away (CI actions, container images).
        if (HISTORY_SKIPPED_ECOSYSTEMS.has(parsePurl(f.subject).type)) continue;
        const latest = latestRepo.get(unversionedPurl(f.subject));
        let url = (latest && !sameRepo(latest, f.value.url) ? latest : f.value.url).replace(/\.git$/, '').replace(/\/+$/, '');
        // GitHub owner and repository names are case-insensitive: one clone per repository.
        if (url.startsWith('https://github.com/')) url = url.toLowerCase();
        // Never a funding or profile page (github.com/sponsors/encode was declared as a repository).
        if (!isHistoryRepoUrl(url)) continue;
        let s = byRepo.get(url);
        if (!s) byRepo.set(url, (s = new Set()));
        s.add(unversionedPurl(f.subject));
      }
      const publishersOf = new Map<PurlString, ReleasePublishersValue>();
      for (const f of opts.repoFacts()) if (f.kind === 'release_publishers') publishersOf.set(unversionedPurl(f.subject), f.value);
      // Tier 0: the repository owner, npm scope and monorepo directory of each package, for the
      // sibling-publisher check and to keep a monorepo's per-package release tags with their package.
      const ownerOf = new Map<PurlString, string>();
      const dirOf = new Map<PurlString, string>();
      for (const f of opts.repoFacts()) {
        if (f.kind !== 'repo') continue;
        const k = unversionedPurl(f.subject);
        const owner = /^https:\/\/[^/]+\/([^/]+)\//.exec((latestRepo.get(k) ?? f.value.url).toLowerCase())?.[1];
        if (owner && !ownerOf.has(k)) ownerOf.set(k, owner);
        if (f.value.directory && !dirOf.has(k)) dirOf.set(k, f.value.directory);
      }
      const established = siblingPublishers(publishersOf, ownerOf);
      // Versions in use per package (Tier 0.5: a pre-release says nothing about a stable line in use).
      const inUse = new Map<PurlString, string[]>();
      for (const c of inv.components) {
        const k = unversionedPurl(c.purl);
        const l = inUse.get(k) ?? [];
        l.push(c.version);
        inUse.set(k, l);
      }
      const lookupCache = new Map<string, Promise<SiblingRelease | undefined>>();
      const siblingLookup = opts.siblingLookup ?? ((account: string, owner: string, exclude: string) => (ctx.offline ? Promise.resolve(undefined) : npmSiblingRelease(ctx, account, owner, exclude)));
      const externalSibling = async (account: string, owner: string | undefined, exclude: string, atMs: number): Promise<boolean> => {
        if (!owner) return false;
        const key = `${account}\u0000${owner}\u0000${exclude}`;
        let p = lookupCache.get(key);
        if (!p) lookupCache.set(key, (p = siblingLookup(account, owner, exclude).catch(() => undefined)));
        const r = await p;
        return r !== undefined && Date.parse(r.firstAt) < atMs;
      };
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
      const concurrency = opts.concurrency ?? 2;
      const maxMb = opts.maxMb ?? DEFAULT_HISTORY_MAX_MB;
      const shallowMonths = opts.shallowMonths ?? DEFAULT_SHALLOW_MONTHS;
      // One clone may take a share of the budget that leaves room for the clones in flight and some
      // cache: with the default 600 MB and 2 clones at a time, 200 MB each (and at most 300 MB).
      const perCloneBytes = Math.min(opts.cache?.maxBytes ?? 300e6, Math.floor((maxMb * 1e6) / (concurrency + 1)));
      const disk = opts.recorded ? undefined : new CloneBudget(cacheDir, maxMb * 1e6, perCloneBytes);
      const shallowSince = shallowMonths > 0 ? addMonths(ctx.now, -shallowMonths) : undefined;
      const cache: HistoryCacheOptions = { ...(shallowSince ? { shallowSince } : {}), ...opts.cache, dir: cacheDir, ...(disk ? { budget: disk } : {}) };
      selection.tooLarge = [];
      // The salt is loaded only when a repository is actually read (recorded histories are already hashed).
      let salt = opts.salt;
      const getSalt = () => (salt ??= loadSalt(path.join(cacheDir, '..', 'history-salt')));
      const token = opts.token ?? process.env.GITHUB_TOKEN ?? '';
      const budget = new GraphqlBudget(opts.budgetPoints ?? DEFAULT_BUDGET_POINTS);
      const facts: Fact[] = [];
      let skippedOffline = 0;
      let mappingFailed = 0;
      if (!ctx.offline && !opts.recorded) await pruneCache(cache).catch(() => 0);

      await mapLimit(repos, concurrency, async (url) => {
        let rec: HistoryRecord | undefined = opts.recorded?.(url);
        if (!rec) {
          if (ctx.offline) {
            skippedOffline++;
            selection.failed.push(url);
            return;
          }
          const dest = path.join(cacheDir, `${cacheKey(url)}.git`);
          await disk?.acquire(dest);
          try {
            const dir = await ensureClone(url, cache, opts.git ?? runGit);
            rec = await readHistory(dir, { repo: url, salt: getSalt(), ...(cache.timeoutMs ? { timeoutMs: cache.timeoutMs } : {}) }, opts.git ?? runGit);
          } catch (err) {
            const msg = (err as Error).message;
            if (/larger than the cap/.test(msg)) selection.tooLarge!.push(url);
            else {
              ctx.warn?.(`git history: ${url}: ${msg}`);
              selection.failed.push(url);
            }
            return;
          } finally {
            await disk?.release(dest);
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
        const npmAccounts = [...new Set([...(byRepo.get(url) ?? [])].flatMap((s) => publishersOf.get(s)?.accounts.map((a) => a.name) ?? []))];
        const merged = mergeIdentities(rec, { npmAccounts });
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
          const versionsInUse = inUse.get(subject) ?? [];
          const stableOnly = versionsInUse.length > 0 && versionsInUse.every((v) => !isPrereleaseVersion(v));
          if (!pubs) {
            // No npm publisher record (PyPI, or no registry data): pre-release tags are still not
            // releases of a stable line in use.
            const pre = (c: { kind: string; release?: string }) => stableOnly && c.release !== undefined && S5A_KINDS.has(c.kind) && isPrereleaseVersion(releaseVersion(c.release));
            facts.push(makeFact('commit_history', subject, { ...agg.history, changes: agg.history.changes.filter((c) => !pre(c)) }, meta));
            continue;
          }
          const known = (account: string, atMs: number) => established(subject, account, atMs);
          // publisherByVersion covers the 36 months before the scan (src/stability/cadence.ts).
          const window36 = new Date(ctx.now.getTime() - 3 * 365 * 86_400_000).toISOString().slice(0, 10);
          const npm = npmContinuity(rec, pubs, ctx.now, { establishedElsewhere: known, stableOnly });
          // Tier 0: a git-side release observation is not a new person's release when the release
          // went to npm through trusted publishing (the project's CI) or a release bot, or was
          // published by an account that already published a sibling package (same owner or scope).
          const trusted = new Set(pubs.trustedVersions ?? []);
          const notNew = (c: { kind: string; release?: string; date: string }) => {
            if (!(c.kind === 'release_by_new_person' || c.kind === 'release_takeover' || c.kind === 'release_handover') || c.release === undefined) return false;
            const v = releaseVersion(c.release);
            if (trusted.has(v)) return true;
            // Tier 0.5: a pre-release (react-native-video 7.0.0-beta.9) while a stable line is in use (6.19.1).
            if (stableOnly && isPrereleaseVersion(v)) return true;
            const at = Date.parse(`${c.date}T00:00:00Z`);
            // A tag whose version this package never published on npm is not this package's release
            // (react's v19.0.1 tag is no scheduler release); only inside the window the map covers.
            // No version at all in the window (the map is empty): nothing this package published then.
            // The map holds every version of the window unless it hit its 500-version cap.
            const capped = Object.keys(pubs.publisherByVersion ?? {}).length >= 500;
            const since = capped && pubs.publisherSince ? pubs.publisherSince : window36;
            if (c.date > since && c.date > window36 && !Object.hasOwn(pubs.publisherByVersion ?? {}, v)) return true;
            const by = pubs.publisherByVersion?.[v];
            if (by === undefined) return false;
            // The npm publisher is the actor id: an account that had already published this package
            // (or a sibling of the same owner or scope), or an org release bot, is not a new person.
            const own = pubs.accounts.find((a) => a.name === by);
            return isReleaseBot(by) || (own !== undefined && Date.parse(own.firstAt) < at) || known(by, at);
          };
          const name = subjectName(subject);
          const ownTag = (c: { release?: string }) => c.release === undefined || tagBelongsTo(c.release, name, dirOf.get(subject));
          let changes = [...agg.history.changes.filter((c) => ownTag(c) && !notNew(c)), ...npm.changes];
          // Tier 0.5: the npm account that published the release already published a package of the
          // same repository owner that is not in this scan (fastify's climba03003 on process-warning).
          // Only for recent S5a observations (the labels' window), so the lookups stay few.
          const recentCut = new Date(ctx.now.getTime() - 400 * 86_400_000).toISOString().slice(0, 10);
          const publisherOf = (c: { kind: string; release?: string }): string | undefined => {
            if (c.release === undefined) return undefined;
            if (c.kind === 'npm_release_by_new_account') return pubs.accounts.find((a) => (stableOnly ? a.firstStableVersion : a.firstVersion) === c.release)?.name;
            return pubs.publisherByVersion?.[releaseVersion(c.release)];
          };
          const drop = new Set<(typeof changes)[number]>();
          for (const c of changes) {
            if (!S5A_KINDS.has(c.kind) || c.date < recentCut) continue;
            const by = publisherOf(c);
            if (!by || isReleaseBot(by)) continue;
            if (await externalSibling(by, ownerOf.get(subject), name, Date.parse(`${c.date}T00:00:00Z`))) drop.add(c);
          }
          if (drop.size) changes = changes.filter((c) => !drop.has(c));
          const history = {
            ...agg.history,
            changes: changes.sort((a, b) => b.date.localeCompare(a.date) || a.kind.localeCompare(b.kind)),
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
      selection.tooLarge!.sort();
      if (disk) selection.budget = { maxMb, perCloneMb: Math.round(perCloneBytes / 1e6), peakMb: Math.round(disk.peakBytes / 1e6), evicted: disk.evicted, shallowMonths };
      if (selection.tooLarge!.length) ctx.warn?.(`git history: ${selection.tooLarge!.length} repositor${selection.tooLarge!.length === 1 ? 'y' : 'ies'} larger than the per-repository cap of ${Math.round(perCloneBytes / 1e6)} MB (disk budget ${maxMb} MB, --history-max-mb) left to the Scorecard / registry fallback`);
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
