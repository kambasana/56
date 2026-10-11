/**
 * Agentic gap-filler enricher (docs/WHO-BEHIND-PLAN.md §10 "Agentic gap-filler"). Runs after every
 * deterministic collector and asks only for facts that are still missing:
 *
 *   funding            a direct dependency with no `funding` or `funding_detail` fact
 *   governance         a direct dependency with no `repo_owner` fact (owner unknown)
 *   lifecycle_events   a dependency the collectors flag (npm deprecated, repo archived, licence
 *                      change) without an announcement: the agent looks for the project's own words
 *   incident_writeups  a dependency with a `malware` fact (OSV MAL-*, incident KB) and no write-up
 *   org_jurisdiction   an organisation that owns a direct dependency's repository (GitHub org) with
 *                      no `org_profile`; the value is pending until a human confirms it
 * Person-level requests are never planned here (the self-declared location task is requested
 * explicitly, with the person's profile URL, and only when person tasks are on).
 *
 * Off by default: needs `--agentic` (ScanOptions.agentic) and ANTHROPIC_API_KEY in the environment.
 * Offline scans replay a recorded model (tests) or skip with one warning.
 */
import { join } from 'node:path';
import { defaultCacheDir } from '../../core/paths.js';
import type { EnrichContext, Enricher } from '../../core/plugin.js';
import { unversionedPurl, type Fact, type Inventory, type PurlString } from '../../core/types.js';
import type { AgenticReport } from '../../core/agentic-types.js';
import { AgenticPipeline, type AgenticBudgetOptions } from '../../agentic/pipeline.js';
import { agentEffortFromEnv, createAnthropicModel, hasApiKey, type ModelClient } from '../../agentic/model.js';
import type { FactRequest } from '../../agentic/tasks.js';

export interface AgenticEnricherOptions {
  /** Facts from the enrichers that ran before. */
  facts: () => readonly Fact[];
  /** Receives the run report (ScanResult.agentic). */
  onReport?: (r: AgenticReport) => void;
  /** Model (tests: ReplayModel). Default: the Anthropic SDK with ANTHROPIC_API_KEY. */
  model?: ModelClient;
  budget?: AgenticBudgetOptions;
  /** Result cache dir; default <cache>/agentic. false disables it. */
  cacheDir?: string | false;
  /** Subjects considered per scan (direct dependencies first; default 25). */
  maxSubjects?: number;
  /** Which tasks the enricher may plan (default: all five non-person tasks). */
  tasks?: readonly string[];
  /**
   * Person-level tasks (contributor_identity from git history). Off by default; when on, results
   * are person-level data with a removal path, visible only to manage_projects.
   */
  personTasks?: boolean;
}

const DEFAULT_TASKS = ['funding', 'governance', 'lifecycle_events', 'incident_writeups', 'org_jurisdiction'] as const;

function hostOf(u: string | undefined): string | undefined {
  if (!u) return undefined;
  try {
    const h = new URL(u).hostname.toLowerCase().replace(/^www\./, '');
    return /^(github\.com|gitlab\.com|bitbucket\.org|npmjs\.com|www\.npmjs\.com|registry\.npmjs\.org)$/.test(h) ? undefined : h;
  } catch {
    return undefined;
  }
}

function nameOfPurl(purl: string): { ecosystem: string; name: string } | undefined {
  const m = /^pkg:([a-z]+)\/(.+?)(@[^@/]+)?$/.exec(purl);
  if (!m) return undefined;
  return { ecosystem: m[1]!, name: decodeURIComponent(m[2]!) };
}

/**
 * Plan fact requests for what the deterministic collectors left missing. Pure: same inventory and
 * facts → same requests, in a stable order (direct dependencies, then by purl).
 */
export function planAgenticRequests(inv: Inventory, facts: readonly Fact[], opts: { maxSubjects?: number; tasks?: readonly string[] } = {}): FactRequest[] {
  const tasks = new Set(opts.tasks ?? DEFAULT_TASKS);
  const direct = new Set(inv.edges.filter((e) => e.direct).map((e) => e.to));
  const subjects = new Map<PurlString, boolean>();
  for (const c of inv.components) {
    if (c.ecosystem !== 'npm') continue; // the inventory's package ecosystem (others come in only through Syft)
    let base: PurlString;
    try {
      base = unversionedPurl(c.purl);
    } catch {
      continue;
    }
    subjects.set(base, (subjects.get(base) ?? false) || direct.has(c.purl));
  }
  const ordered = [...subjects].sort((a, b) => (a[1] === b[1] ? (a[0] < b[0] ? -1 : 1) : a[1] ? -1 : 1)).slice(0, opts.maxSubjects ?? 25);

  const byBase = new Map<string, Fact[]>();
  for (const f of facts) {
    let base: string;
    try {
      base = unversionedPurl(f.subject);
    } catch {
      base = f.subject;
    }
    const l = byBase.get(base) ?? [];
    l.push(f);
    byBase.set(base, l);
  }
  const has = (base: string, kind: Fact['kind'], pred: (f: Fact) => boolean = () => true) => (byBase.get(base) ?? []).some((f) => f.kind === kind && pred(f));
  const hasAgent = (base: string, task: string) => has(base, 'agent_fact', (f) => f.kind === 'agent_fact' && f.value.task === task);

  const out: FactRequest[] = [];
  const orgs = new Map<string, { owner: string; domains: Set<string>; url: string }>();
  for (const [base, isDirect] of ordered) {
    const id = nameOfPurl(base);
    if (!id) continue;
    const mine = byBase.get(base) ?? [];
    const repo = mine.find((f): f is Extract<Fact, { kind: 'repo' }> => f.kind === 'repo');
    const age = mine.find((f): f is Extract<Fact, { kind: 'release_age' }> => f.kind === 'release_age');
    const domains: string[] = [];
    const context = {
      name: id.name,
      ecosystem: id.ecosystem,
      packageName: id.name,
      ...(repo ? { repoUrl: repo.value.url } : {}),
      ...(domains.length ? { domains } : {}),
      known: mine
        .filter((f) => f.kind === 'funding' || f.kind === 'repo_owner' || f.kind === 'archived' || f.kind === 'license_change' || f.kind === 'release_age' || f.kind === 'malware')
        .slice(0, 10)
        .map((f) => `${f.kind} (${f.source}): ${JSON.stringify(f.value).slice(0, 200)}`),
    };
    const req = (task: string, question: string): FactRequest => ({ task, subject: base, subjectKind: 'package', question, context });

    if (isDirect && tasks.has('funding') && !has(base, 'funding') && !has(base, 'funding_detail') && !hasAgent(base, 'funding')) {
      out.push(req('funding', 'Which funding channels does this project declare, and which organisations back it?'));
    }
    if (isDirect && tasks.has('governance') && !has(base, 'repo_owner') && !hasAgent(base, 'governance')) {
      out.push(req('governance', 'Which organisation or foundation owns or governs this project?'));
    }
    const deprecated = age?.value.deprecated;
    const archived = has(base, 'archived', (f) => f.kind === 'archived' && f.value.archived);
    const relicensed = has(base, 'license_change');
    if (tasks.has('lifecycle_events') && (deprecated || archived || relicensed) && !hasAgent(base, 'lifecycle_events')) {
      const why = [deprecated ? `npm marks the latest version deprecated ("${deprecated.slice(0, 120)}")` : '', archived ? 'the repository is archived' : '', relicensed ? 'the declared licence changed between releases' : ''].filter(Boolean).join('; ');
      out.push(req('lifecycle_events', `Our collectors report that ${why}. Find the project's own announcement and its date.`));
    }
    if (tasks.has('incident_writeups') && has(base, 'malware') && !hasAgent(base, 'incident_writeups')) {
      out.push(req('incident_writeups', 'Advisories list this package as compromised or malicious. Find the public write-up or post-mortem.'));
    }
    const owner = mine.find((f): f is Extract<Fact, { kind: 'repo_owner' }> => f.kind === 'repo_owner' && f.value.ownerType === 'Organization');
    if (isDirect && owner) {
      const key = owner.value.owner.toLowerCase();
      const o = orgs.get(key) ?? { owner: owner.value.owner, domains: new Set<string>(), url: owner.value.url };
      for (const d of domains) o.domains.add(d);
      orgs.set(key, o);
    }
  }
  if (tasks.has('org_jurisdiction')) {
    for (const [key, o] of [...orgs].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const subject = `org:github/${key}`;
      if (has(subject, 'org_profile') || hasAgent(subject, 'org_jurisdiction')) continue;
      out.push({
        task: 'org_jurisdiction',
        subject,
        subjectKind: 'org',
        question: 'In which country is this organisation registered or incorporated, according to a public registry or its own legal page?',
        context: { name: o.owner, ...(o.domains.size ? { domains: [...o.domains].sort() } : {}), known: [`GitHub organisation: ${o.url}`] },
      });
    }
  }
  return out;
}

/**
 * Add the package homepage the registry declares (npm "latest" document, through the scan's
 * HttpClient) to each package request: it is the project's own site, so its domain counts as
 * evidence for lifecycle and governance announcements. Organisation requests get the homepages of
 * the packages they own. Deterministic: the agent never chooses its own evidence domains.
 */
export async function addHomepages(requests: FactRequest[], http: EnrichContext['http'], ownerOf: (purl: string) => string | undefined): Promise<void> {
  const homes = new Map<string, string>();
  for (const r of requests) {
    if (r.subjectKind !== 'package' || r.context?.ecosystem !== 'npm' || !r.context.packageName || homes.has(r.subject)) continue;
    const name = r.context.packageName;
    const url = `https://registry.npmjs.org/${name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name)}/latest`;
    try {
      const doc = await http.fetchJsonOrNull<{ homepage?: unknown }>(url);
      if (typeof doc?.homepage === 'string') homes.set(r.subject, doc.homepage);
    } catch {
      // No homepage: the task's own evidence domains still apply.
    }
  }
  const orgDomains = new Map<string, Set<string>>();
  for (const [subject, home] of homes) {
    const host = hostOf(home);
    const owner = ownerOf(subject);
    if (host && owner) orgDomains.set(owner, (orgDomains.get(owner) ?? new Set()).add(host));
  }
  for (const r of requests) {
    const home = homes.get(r.subject);
    const host = hostOf(home);
    if (r.subjectKind === 'package' && home && r.context) {
      r.context.homepage = home;
      if (host) r.context.domains = [...new Set([...(r.context.domains ?? []), host])].sort();
    }
    if (r.subjectKind === 'org' && r.context) {
      const extra = orgDomains.get(r.subject.replace(/^org:github\//, ''));
      if (extra) r.context.domains = [...new Set([...(r.context.domains ?? []), ...extra])].sort();
    }
  }
}

/**
 * contributor_identity requests (person tasks only): the people git history already maps to a
 * public account. P2's identity step turns GitHub no-reply addresses and .mailmap entries into
 * logins, and the GraphQL commit → login mapping does the rest when a token is configured;
 * salted-hash ids (`hash:…`) are never sent anywhere, so they are skipped here. Most active people
 * first (24-month commits), at most `perRepo` per repository.
 */
export function planContributorRequests(facts: readonly Fact[], opts: { perRepo?: number; max?: number } = {}): FactRequest[] {
  const out = new Map<string, FactRequest>();
  for (const f of facts) {
    if (f.kind !== 'commit_history' || !f.value.repo.startsWith('https://github.com/')) continue;
    const people = [...f.value.people].filter((p) => !p.id.startsWith('hash:') && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(p.id)).sort((a, b) => b.commits24m - a.commits24m || (a.id < b.id ? -1 : 1));
    for (const p of people.slice(0, opts.perRepo ?? 5)) {
      const login = p.id.toLowerCase();
      const subject = `person:github/${login}`;
      if (out.has(subject)) continue;
      out.set(subject, {
        task: 'contributor_identity',
        subject,
        subjectKind: 'person',
        question: `Who is the public account behind ${login}, a contributor to ${f.value.repo}? Collect what the person published on their own profile and the public roles that name the account.`,
        context: { profileUrl: `https://github.com/${login}`, repoUrl: f.value.repo },
      });
    }
  }
  return [...out.values()].sort((a, b) => (a.subject < b.subject ? -1 : 1)).slice(0, opts.max ?? 20);
}

export function createAgenticEnricher(opts: AgenticEnricherOptions): Enricher {
  return {
    name: 'agentic',
    usesEarlierFacts: true,
    async enrich(inv: Inventory, ctx: EnrichContext): Promise<Fact[]> {
      let model = opts.model;
      if (!model) {
        if (ctx.offline) {
          ctx.warn?.('agentic: offline scan without a recorded model; skipped');
          return [];
        }
        if (!hasApiKey()) {
          ctx.warn?.('agentic: --agentic needs ANTHROPIC_API_KEY in the environment; skipped');
          return [];
        }
        model = createAnthropicModel();
      }
      const facts = opts.facts();
      const requests = planAgenticRequests(inv, facts, { ...(opts.maxSubjects !== undefined ? { maxSubjects: opts.maxSubjects } : {}), ...(opts.tasks ? { tasks: opts.tasks } : {}) });
      const owners = new Map<string, string>();
      for (const f of facts) if (f.kind === 'repo_owner' && f.value.ownerType === 'Organization') owners.set(unversionedPurl(f.subject), f.value.owner.toLowerCase());
      await addHomepages(requests, ctx.http, (p) => owners.get(p));
      if (opts.personTasks) requests.push(...planContributorRequests(facts));
      const pipeline = new AgenticPipeline({
        model,
        http: ctx.http,
        now: ctx.now,
        facts: opts.facts,
        cacheDir: opts.cacheDir === undefined ? join(defaultCacheDir(), 'agentic') : opts.cacheDir,
        effort: agentEffortFromEnv(),
        personTasks: opts.personTasks === true,
        ...(opts.budget ? { budget: opts.budget } : {}),
      });
      for (const r of await pipeline.requestAll(requests)) {
        if (r.run?.stop === 'error') ctx.warn?.(`agentic: ${r.request.task} for ${r.request.subject}: ${r.run.error ?? 'error'}`);
      }
      const report = pipeline.report();
      if (report.budgetExhausted) ctx.warn?.('agentic: per-scan budget reached; some missing facts were not requested');
      opts.onReport?.(report);
      return pipeline.facts();
    },
  };
}
