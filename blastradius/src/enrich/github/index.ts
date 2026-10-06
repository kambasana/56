/**
 * GitHub enricher: repo_owner, repo_transfer, archived and funding facts.
 *
 * 1. Resolve which GitHub repo each component declares:
 *    - npm: package.json `repository` of the scanned version (packument fetched
 *      through the shared, memoised npm helper), or `repo` facts passed in via
 *      `repoFacts`;
 *    - GitHub Actions: the action's owner/repo.
 * 2. GET https://api.github.com/repos/{owner}/{repo} (GITHUB_TOKEN if set).
 *    GitHub answers renamed/transferred repos with a redirect to the new
 *    location, so a canonical owner different from the declared owner is
 *    reported as `repo_transfer`.
 * 3. FUNDING.yml from raw.githubusercontent.com (repo `.github/`, then the
 *    owner's `.github` repository), and Open Collective backers for declared
 *    collectives.
 *
 * Wording is factual; facts describe accounts and repos, never intent.
 */
import { HttpError, OfflineMissError } from '../../core/http.js';
import type { EnrichContext, Enricher } from '../../core/plugin.js';
import { makeFact, parsePurl, unversionedPurl } from '../../core/types.js';
import type { ArchivedValue, Fact, FundingValue, Inventory, PurlString, RepoOwnerValue, RepoTransferValue } from '../../core/types.js';
import { fetchPackument, isObject } from '../npm/registry.js';
import { fundingFromManifestField, repoFromManifestField } from '../npm/repo.js';
import { errorMessage, mapLimit } from '../npm/util.js';
import { parseFundingYml } from './funding-yml.js';
import { OC_SLUG_RE, OPEN_COLLECTIVE_API, openCollectiveRequestBody, parseOpenCollective } from './opencollective.js';
import type { GithubRepoResponse, GithubRepoTarget, OpenCollectiveResponse } from './types.js';

export { parseFundingYml, MAX_FUNDING_YML_BYTES } from './funding-yml.js';
export { OPEN_COLLECTIVE_API, OPEN_COLLECTIVE_QUERY, openCollectiveRequestBody, parseOpenCollective } from './opencollective.js';
export type { BackerFilter } from './opencollective.js';
export type * from './types.js';

export const GITHUB_API = 'https://api.github.com';
export const GITHUB_RAW = 'https://raw.githubusercontent.com';

/** Paths tried for FUNDING.yml: in the repo, then in the owner's `.github` repository. */
export const FUNDING_PATHS = {
  repo: ['.github/FUNDING.yml', '.github/funding.yml'],
  ownerDefault: ['FUNDING.yml', '.github/FUNDING.yml'],
} as const;

const SEGMENT_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export interface GithubEnricherOptions {
  /** API token; defaults to process.env.GITHUB_TOKEN only when apiBase is the default GitHub API. Sent only to apiBase. */
  token?: string;
  apiBase?: string;
  rawBase?: string;
  openCollectiveUrl?: string;
  /**
   * Supplier of facts produced earlier in the scan (e.g. the npm/depsdev `repo`
   * and `funding` facts). When given, npm repos are taken from these instead of
   * re-reading packuments.
   */
  repoFacts?: () => readonly Fact[];
  /** Custom resolver (overrides both of the above). */
  resolveTargets?: (inv: Inventory, ctx: EnrichContext) => Promise<GithubRepoTarget[]>;
  /** Fetch FUNDING.yml (default true). */
  fundingYml?: boolean;
  /** Query Open Collective for declared collectives (default true). */
  openCollective?: boolean;
  /** Include individual (person) backers from Open Collective (default false). */
  includeIndividualBackers?: boolean;
  /** Max backers per collective (default 20). */
  maxBackers?: number;
  /** Max distinct repos looked up per scan (default 300; unauthenticated API allows 60/hour). */
  maxRepos?: number;
  /** Parallel repo lookups (default 4). */
  concurrency?: number;
}

const SOURCE = 'github';

export function createGithubEnricher(opts: GithubEnricherOptions = {}): Enricher {
  const apiBase = (opts.apiBase ?? GITHUB_API).replace(/\/+$/, '');
  const rawBase = (opts.rawBase ?? GITHUB_RAW).replace(/\/+$/, '');
  const ocUrl = opts.openCollectiveUrl ?? OPEN_COLLECTIVE_API;

  return {
    name: SOURCE,
    async enrich(inv: Inventory, ctx: EnrichContext): Promise<Fact[]> {
      // GITHUB_TOKEN from the environment is only ever sent to the real GitHub API; a custom
      // apiBase needs an explicit opts.token.
      const token = opts.token ?? (apiBase === GITHUB_API ? process.env.GITHUB_TOKEN : undefined);
      const targets = opts.resolveTargets
        ? await opts.resolveTargets(inv, ctx)
        : await resolveRepoTargets(inv, ctx, opts.repoFacts?.());

      // Group subjects by repo (case-insensitive); a monorepo serves many packages.
      const byRepo = new Map<string, GithubRepoTarget[]>();
      for (const t of targets) {
        if (!SEGMENT_RE.test(t.owner) || !SEGMENT_RE.test(t.repo)) continue;
        const key = `${t.owner}/${t.repo}`.toLowerCase();
        byRepo.set(key, [...(byRepo.get(key) ?? []), t]);
      }
      let repoKeys = [...byRepo.keys()].sort();
      const maxRepos = opts.maxRepos ?? 300;
      if (repoKeys.length > maxRepos) {
        ctx.warn?.(`github: ${repoKeys.length} repos declared; only the first ${maxRepos} were looked up`);
        repoKeys = repoKeys.slice(0, maxRepos);
      }

      const facts: Fact[] = [];
      const state = { apiBlocked: false, offlineMisses: 0 };
      const meta = (evidence: string[]) => ({ source: SOURCE, fetchedAt: ctx.now, evidence: [...new Set(evidence)] });

      await mapLimit(repoKeys, Math.max(1, opts.concurrency ?? 4), async (key) => {
        const group = byRepo.get(key)!;
        const { owner, repo } = group[0]!;
        const info = await fetchRepo(owner, repo);
        const subjects = [...new Set(group.map((t) => t.subject))];
        const declared = [...new Set(group.map((t) => t.declaredUrl))];
        let canonicalOwner = owner;
        let canonicalRepo = repo;

        if (info) {
          canonicalOwner = info.owner;
          canonicalRepo = info.name;
          const ownerValue: RepoOwnerValue = { repo: `github.com/${info.owner}/${info.name}`, owner: info.owner, ownerType: info.ownerType, url: info.htmlUrl };
          const archivedValue: ArchivedValue = { archived: info.archived };
          if (info.pushedAt) archivedValue.lastPushAt = info.pushedAt;
          for (const s of subjects) {
            facts.push(makeFact('repo_owner', s, ownerValue, meta([info.htmlUrl])));
            facts.push(makeFact('archived', s, archivedValue, meta([info.htmlUrl])));
          }
          // Today's redirect says nothing about when the move happened; in a replay it may not have happened yet.
          if (info.owner.toLowerCase() !== owner.toLowerCase() && !ctx.historical) {
            const transfer: RepoTransferValue = {
              repo: `github.com/${info.owner}/${info.name}`,
              fromOwner: owner,
              toOwner: info.owner,
              detectedAt: ctx.now.toISOString(),
            };
            for (const s of subjects) facts.push(makeFact('repo_transfer', s, transfer, meta([...declared, info.htmlUrl])));
          }
        }

        let funding: { value: FundingValue; url: string } | undefined;
        if (opts.fundingYml !== false) {
          funding = await fetchFundingYml(canonicalOwner, canonicalRepo);
          if (funding) for (const s of subjects) facts.push(makeFact('funding', s, funding.value, meta([funding.url])));
        }

        if (opts.openCollective !== false) {
          const slugs = new Set<string>();
          for (const t of group) for (const sl of t.openCollectiveSlugs ?? []) slugs.add(sl.toLowerCase());
          // Only this repo's FUNDING.yml (not the facts array shared with concurrent repo lookups).
          for (const src of funding?.value.sources ?? []) if (src.platform === 'open_collective' && src.handle) slugs.add(src.handle.toLowerCase());
          for (const slug of [...slugs].sort().slice(0, 5)) {
            const value = await fetchOpenCollective(slug);
            if (value) for (const s of subjects) facts.push(makeFact('funding', s, value, meta([`https://opencollective.com/${value.collective}`])));
          }
        }
      });

      if (state.offlineMisses > 0) ctx.warn?.(`github: ${state.offlineMisses} request(s) missing from fixtures/cache in offline mode`);
      return facts;

      async function fetchRepo(owner: string, repo: string) {
        if (state.apiBlocked) return undefined;
        const url = `${apiBase}/repos/${owner}/${repo}`;
        const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
        if (token) headers.authorization = `Bearer ${token}`;
        let res: { status: number; body: string };
        try {
          res = await ctx.http.request(url, { headers });
        } catch (err) {
          // Offline misses are rolled up into one summary warning at the end.
          if (err instanceof OfflineMissError) state.offlineMisses++;
          else ctx.warn?.(`github: could not fetch ${owner}/${repo}: ${errorMessage(err)}`);
          return undefined;
        }
        if (res.status === 404) {
          ctx.warn?.(`github: repository ${owner}/${repo} not found (deleted, private or renamed without redirect)`);
          return undefined;
        }
        if (res.status === 403 || res.status === 429) {
          state.apiBlocked = true;
          ctx.warn?.(`github: API returned ${res.status} (rate limit or access denied); skipping further repo lookups${token ? '' : ' — set GITHUB_TOKEN'}`);
          return undefined;
        }
        if (res.status < 200 || res.status >= 300) {
          ctx.warn?.(`github: HTTP ${res.status} for ${owner}/${repo}`);
          return undefined;
        }
        let data: GithubRepoResponse;
        try {
          data = JSON.parse(res.body) as GithubRepoResponse;
        } catch {
          ctx.warn?.(`github: invalid JSON for ${owner}/${repo}`);
          return undefined;
        }
        const parsed = parseRepoResponse(data);
        if (!parsed) ctx.warn?.(`github: unexpected response shape for ${owner}/${repo}`);
        return parsed;
      }

      async function fetchFundingYml(owner: string, repo: string): Promise<{ value: FundingValue; url: string } | undefined> {
        const candidates = [
          ...FUNDING_PATHS.repo.map((p) => ({ owner, repo, path: p })),
          ...FUNDING_PATHS.ownerDefault.map((p) => ({ owner, repo: '.github', path: p })),
        ];
        for (const c of candidates) {
          const url = `${rawBase}/${c.owner}/${c.repo}/HEAD/${c.path}`;
          let res: { status: number; body: string };
          try {
            res = await ctx.http.request(url, { headers: { accept: 'text/plain' } });
          } catch (err) {
            if (err instanceof OfflineMissError) state.offlineMisses++;
            else ctx.warn?.(`github: could not fetch FUNDING.yml for ${owner}/${repo}: ${errorMessage(err)}`);
            return undefined;
          }
          if (res.status === 404) continue;
          if (res.status < 200 || res.status >= 300) return undefined;
          const sources = parseFundingYml(res.body);
          if (sources.length === 0) return undefined;
          return { value: { sources, via: 'FUNDING.yml' }, url: `https://github.com/${c.owner}/${c.repo}/blob/HEAD/${c.path}` };
        }
        return undefined;
      }

      async function fetchOpenCollective(slug: string) {
        if (!OC_SLUG_RE.test(slug)) return undefined;
        try {
          const res = await ctx.http.fetchJsonOrNull<OpenCollectiveResponse>(ocUrl, { method: 'POST', body: openCollectiveRequestBody(slug) });
          if (!res) return undefined;
          return parseOpenCollective(res, slug, { includeIndividuals: opts.includeIndividualBackers, maxBackers: opts.maxBackers });
        } catch (err) {
          if (err instanceof OfflineMissError) state.offlineMisses++;
          else ctx.warn?.(`github: Open Collective lookup failed for ${slug}: ${errorMessage(err)}`);
          return undefined;
        }
      }
    },
  };
}

interface ParsedRepo {
  owner: string;
  ownerType: 'User' | 'Organization';
  name: string;
  htmlUrl: string;
  archived: boolean;
  pushedAt?: string;
}

/** Validate the fields we use from GET /repos/{owner}/{repo}. */
export function parseRepoResponse(data: GithubRepoResponse): ParsedRepo | undefined {
  if (!isObject(data) || !isObject(data.owner)) return undefined;
  const login = data.owner.login;
  const type = data.owner.type;
  const name = data.name;
  const html = data.html_url;
  if (typeof login !== 'string' || !LOGIN_RE.test(login)) return undefined;
  if (typeof name !== 'string' || !SEGMENT_RE.test(name)) return undefined;
  if (type !== 'User' && type !== 'Organization') return undefined;
  const htmlUrl = typeof html === 'string' && html.startsWith('https://github.com/') && html.length < 300 ? html : `https://github.com/${login}/${name}`;
  const out: ParsedRepo = { owner: login, ownerType: type, name, htmlUrl, archived: data.archived === true };
  if (typeof data.pushed_at === 'string' && Number.isFinite(Date.parse(data.pushed_at))) out.pushedAt = new Date(data.pushed_at).toISOString();
  return out;
}

/**
 * Default target resolution. npm: from `repo`/`funding` facts when supplied,
 * otherwise from the packument (memoised per HttpClient, so normally already
 * fetched by the npm enricher). GitHub Actions: owner/repo of the action.
 */
export async function resolveRepoTargets(inv: Inventory, ctx: EnrichContext, repoFacts?: readonly Fact[]): Promise<GithubRepoTarget[]> {
  const targets: GithubRepoTarget[] = [];
  const npmByName = new Map<string, string>(); // name → a version
  for (const c of inv.components) {
    if (c.ecosystem === 'githubactions') {
      try {
        const p = parsePurl(c.purl);
        if (p.namespace && !p.namespace.includes('/')) {
          targets.push({ subject: unversionedPurl(c.purl), owner: p.namespace, repo: p.name, declaredUrl: `https://github.com/${p.namespace}/${p.name}` });
        }
      } catch {
        ctx.warn?.(`github: skipping action with unparsable purl ${c.purl.slice(0, 100)}`);
      }
    } else if (c.ecosystem === 'npm' && !npmByName.has(c.name)) {
      npmByName.set(c.name, c.version);
    }
  }

  if (repoFacts) {
    const wanted = new Set(inv.components.filter((c) => c.ecosystem === 'npm').map((c) => safeUnversioned(c.purl)));
    const oc = new Map<PurlString, string[]>();
    for (const f of repoFacts) {
      if (f.kind === 'funding' && wanted.has(f.subject)) oc.set(f.subject, [...(oc.get(f.subject) ?? []), ...ocSlugs(f.value.sources)]);
    }
    for (const f of repoFacts) {
      if (f.kind !== 'repo' || f.value.host !== 'github' || !wanted.has(f.subject) || !f.value.owner || !f.value.name) continue;
      if (targets.some((t) => t.subject === f.subject)) continue;
      targets.push({ subject: f.subject, owner: f.value.owner, repo: f.value.name, declaredUrl: f.value.url, openCollectiveSlugs: oc.get(f.subject) ?? [] });
    }
    return targets;
  }

  await mapLimit([...npmByName.keys()].sort(), 6, async (name) => {
    let p;
    try {
      p = await fetchPackument(ctx.http, name);
    } catch (err) {
      if (!(err instanceof OfflineMissError || err instanceof HttpError)) ctx.warn?.(`github: could not resolve repo for ${name}: ${errorMessage(err)}`);
      return; // the npm enricher already reports fetch failures
    }
    if (!p) return;
    const version = npmByName.get(name)!;
    const m = isObject(p.versions) && Object.hasOwn(p.versions, version) ? p.versions[version] : undefined;
    const repo = repoFromManifestField(m?.repository) ?? repoFromManifestField(p.repository);
    if (!repo || repo.host !== 'github' || !repo.owner || !repo.name) return;
    const subject = safeUnversioned(inv.components.find((c) => c.ecosystem === 'npm' && c.name === name)!.purl);
    targets.push({ subject, owner: repo.owner, repo: repo.name, declaredUrl: repo.url, openCollectiveSlugs: ocSlugs(fundingFromManifestField(m?.funding)) });
  });
  return targets.sort((a, b) => (a.subject < b.subject ? -1 : 1));
}

function ocSlugs(sources: readonly { platform: string; handle?: string }[]): string[] {
  return sources.filter((s) => s.platform === 'open_collective' && s.handle && OC_SLUG_RE.test(s.handle)).map((s) => s.handle!.toLowerCase());
}

function safeUnversioned(purl: string): string {
  try {
    return unversionedPurl(purl);
  } catch {
    return purl;
  }
}
