/**
 * The agent's fixed tool set.
 *
 * Client tools (run by us, through the scan's HttpClient: cache, rate limits, offline fixtures):
 *   collected_facts        facts this scan already has for the subject (reuse before browsing)
 *   npm_package            npm registry packument, slimmed (our npm collector's fetch)
 *   pypi_package           PyPI JSON API, slimmed
 *   depsdev_project        deps.dev project (Scorecard, licence, description)
 *   osv_query              OSV advisories for a package
 *   opencollective_account Open Collective collective, host and organisational backers (our OC collector's query)
 *   registry_fetch         restricted GET on allow-listed registry/API hosts only
 *   submit_facts           the agent's answer (validated by us, then the gate)
 * Server tools (run by Anthropic): web_search, web_fetch, limited to the task's evidence domains.
 *
 * Every tool result is untrusted data: it is wrapped in <untrusted_data> with the closing tag
 * neutralised inside, so page text cannot pose as instructions from us.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { HttpClient } from '../core/http.js';
import type { Fact } from '../core/types.js';
import { DEPSDEV_API } from '../enrich/depsdev/index.js';
import { OPEN_COLLECTIVE_API, OC_SLUG_RE, openCollectiveRequestBody, parseOpenCollective } from '../enrich/github/opencollective.js';
import { isValidNpmName } from '../enrich/npm/registry.js';
import { githubUserApiUrls, type AgentToolName, type FactRequest, type TaskSpec } from './tasks.js';
import { allowedDomains } from './verify.js';

type ToolDef = Anthropic.Beta.Messages.BetaToolUnion;

/** Hosts registry_fetch may read. Not the open web: that goes through web_fetch with domain limits. */
export const REGISTRY_FETCH_HOSTS = [
  'registry.npmjs.org',
  'pypi.org',
  'api.deps.dev',
  'api.osv.dev',
  'api.securityscorecards.dev',
  'raw.githubusercontent.com',
] as const;

const MAX_TOOL_TEXT = 40_000;

/** Wrap tool output as untrusted data; nothing inside can close the wrapper. */
export function untrusted(source: string, body: string): string {
  const clipped = body.length > MAX_TOOL_TEXT ? `${body.slice(0, MAX_TOOL_TEXT)}\n[truncated at ${MAX_TOOL_TEXT} characters]` : body;
  const safe = clipped.replace(/<\/?\s*untrusted_data/gi, (m) => m.replace('<', '&lt;'));
  return `<untrusted_data source=${JSON.stringify(source)}>\n${safe}\n</untrusted_data>`;
}

const str = (description: string) => ({ type: 'string', description }) as const;

const CLIENT_TOOLS: Readonly<Record<Exclude<AgentToolName, 'web_search' | 'web_fetch'>, Anthropic.Beta.Messages.BetaTool>> = {
  collected_facts: {
    name: 'collected_facts',
    description: 'Facts the deterministic collectors (deps.dev, npm/PyPI registries, OSV, GitHub advisories, Scorecard, Open Collective, git history, licences) already found for the subject in this scan. Call this first; do not re-discover what is here.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  npm_package: {
    name: 'npm_package',
    description: 'npm registry metadata for a package: description, homepage, repository, funding field, latest version, deprecation notice, licence, maintainer count.',
    input_schema: { type: 'object', properties: { name: str('npm package name') }, required: ['name'], additionalProperties: false },
  },
  pypi_package: {
    name: 'pypi_package',
    description: 'PyPI metadata for a package: summary, home page, project URLs, licence, latest version.',
    input_schema: { type: 'object', properties: { name: str('PyPI project name') }, required: ['name'], additionalProperties: false },
  },
  depsdev_project: {
    name: 'depsdev_project',
    description: 'deps.dev project record for a source repository (e.g. "github.com/babel/babel"): OpenSSF Scorecard, licence, description, homepage.',
    input_schema: { type: 'object', properties: { project: str('repository id like github.com/owner/repo') }, required: ['project'], additionalProperties: false },
  },
  osv_query: {
    name: 'osv_query',
    description: 'OSV advisories (ids, summaries, published dates) for a package.',
    input_schema: { type: 'object', properties: { ecosystem: { type: 'string', enum: ['npm', 'PyPI'] }, name: str('package name') }, required: ['ecosystem', 'name'], additionalProperties: false },
  },
  opencollective_account: {
    name: 'opencollective_account',
    description: 'Open Collective collective by slug: fiscal host, backer count and the top organisational backers (individual backers are never returned).',
    input_schema: { type: 'object', properties: { slug: str('Open Collective slug, e.g. "babel"') }, required: ['slug'], additionalProperties: false },
  },
  github_user: {
    name: 'github_user',
    description: 'GitHub users API for one login: account creation date, public profile fields as published (name, company, blog, bio, location), public organisation memberships and public signing keys (GPG and SSH key ids). Uses the configured GitHub token when there is one.',
    input_schema: { type: 'object', properties: { login: str('GitHub login') }, required: ['login'], additionalProperties: false },
  },
  registry_fetch: {
    name: 'registry_fetch',
    description: `GET a URL on an allow-listed registry or API host (${REGISTRY_FETCH_HOSTS.join(', ')}). Use for funding.json, FUNDING.yml or registry JSON. Other hosts are refused; use web_fetch for web pages.`,
    input_schema: { type: 'object', properties: { url: str('https URL on an allow-listed host') }, required: ['url'], additionalProperties: false },
  },
  submit_facts: {
    name: 'submit_facts',
    description: 'Submit the facts you found (or none). Call exactly once, at the end.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
} as Readonly<Record<Exclude<AgentToolName, 'web_search' | 'web_fetch'>, Anthropic.Beta.Messages.BetaTool>>;

/** JSON Schema of submit_facts for a task (the value schema comes from the task spec). */
export function submitToolFor(spec: TaskSpec, valueJsonSchema: Record<string, unknown>): Anthropic.Beta.Messages.BetaTool {
  return {
    name: 'submit_facts',
    description: `Submit the ${spec.id} facts you found, or an empty list with none_found_reason. Call exactly once, at the end. Each fact needs the exact source URL you read and a quote copied character for character from it; the application re-fetches the URL and rejects any fact whose quote is not on the page or whose value is not supported by the quote.`,
    input_schema: {
      type: 'object',
      properties: {
        facts: {
          type: 'array',
          maxItems: spec.maxFacts,
          items: {
            type: 'object',
            properties: {
              value: valueJsonSchema,
              source_url: { type: 'string', description: 'https URL of the page the quote is from' },
              quote: { type: 'string', description: 'exact text from that page (one sentence or line)' },
              confidence_note: { type: 'string', description: 'one short sentence: how sure you are and why' },
            },
            required: ['value', 'source_url', 'quote', 'confidence_note'],
            additionalProperties: false,
          },
        },
        none_found_reason: { type: 'string' },
      },
      required: ['facts'],
      additionalProperties: false,
    },
  };
}

/** The tool definitions sent for one request: deterministic order (prompt-cache friendly). */
export function toolDefinitions(spec: TaskSpec, req: FactRequest, valueJsonSchema: Record<string, unknown>): ToolDef[] {
  const defs: ToolDef[] = [];
  const domains = allowedDomains(spec, req);
  for (const name of [...spec.tools].sort()) {
    if (name === 'web_search') defs.push({ type: 'web_search_20260209', name: 'web_search', max_uses: 5, allowed_domains: domains });
    else if (name === 'web_fetch') defs.push({ type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 8, allowed_domains: domains, max_content_tokens: 20_000 });
    else defs.push(CLIENT_TOOLS[name]);
  }
  defs.push(submitToolFor(spec, valueJsonSchema));
  return defs;
}

export interface ToolContext {
  http: HttpClient;
  request: FactRequest;
  spec: TaskSpec;
  /** Facts collected by the deterministic enrichers in this scan. */
  facts: () => readonly Fact[];
}

export interface ToolOutcome {
  content: string;
  isError?: boolean;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function needString(input: unknown, key: string, max = 300): string | null {
  if (!isObj(input)) return null;
  const v = input[key];
  return typeof v === 'string' && v.length > 0 && v.length <= max ? v : null;
}

/** Facts about the subject, as compact JSON lines (emails and person ids are not included). */
export function collectedFactLines(facts: readonly Fact[], subject: string): string[] {
  const base = subject.replace(/@[^@/]+$/, '');
  const lines: string[] = [];
  for (const f of facts) {
    const s = f.subject.replace(/@[^@/]+$/, '');
    if (s !== base) continue;
    let value: unknown = f.value;
    // Keep person-level detail out of the agent's context: counts only.
    if (f.kind === 'maintainers' && isObj(f.value)) value = { count: Array.isArray((f.value as { maintainers?: unknown[] }).maintainers) ? (f.value as { maintainers: unknown[] }).maintainers.length : undefined };
    if (f.kind === 'contributors' || f.kind === 'commit_history') continue;
    if (f.kind === 'publisher' || f.kind === 'publisher_change' || f.kind === 'maintainer_change') continue;
    lines.push(JSON.stringify({ kind: f.kind, source: f.source, value, evidence: f.evidence }).slice(0, 2000));
    if (lines.length >= 60) break;
  }
  return lines;
}

/** Run one client tool. Tools not allowed for the task, and malformed inputs, are errors. */
export async function runClientTool(name: string, input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  if (name === 'submit_facts') return { content: 'submit_facts is handled by the pipeline', isError: true };
  if (!(ctx.spec.tools as readonly string[]).includes(name)) return { content: `tool ${name} is not available for task ${ctx.spec.id}`, isError: true };
  try {
    switch (name) {
      case 'collected_facts': {
        const lines = collectedFactLines(ctx.facts(), ctx.request.subject);
        return { content: untrusted('blastradius collectors', lines.length ? lines.join('\n') : 'no facts collected for this subject') };
      }
      case 'npm_package': {
        const pkg = needString(input, 'name', 214);
        if (!pkg || !isValidNpmName(pkg)) return { content: 'invalid npm package name', isError: true };
        // The registry's "latest" version document (our packument fetch keeps only the fields the npm collector reads).
        const url = `https://registry.npmjs.org/${pkg.startsWith('@') ? `@${encodeURIComponent(pkg.slice(1))}` : encodeURIComponent(pkg)}/latest`;
        const v = await ctx.http.fetchJsonOrNull<Record<string, unknown>>(url);
        if (!v) return { content: untrusted(url, 'package not found') };
        const slim = {
          name: pkg,
          latest: v.version,
          description: v.description,
          homepage: v.homepage,
          repository: v.repository,
          funding: v.funding,
          license: v.license,
          deprecated: v.deprecated,
          maintainers: Array.isArray(v.maintainers) ? v.maintainers.length : undefined,
        };
        return { content: untrusted(url, JSON.stringify(slim)) };
      }
      case 'pypi_package': {
        const pkg = needString(input, 'name', 200);
        if (!pkg || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(pkg)) return { content: 'invalid PyPI project name', isError: true };
        const url = `https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`;
        const data = await ctx.http.fetchJsonOrNull<{ info?: Record<string, unknown> }>(url);
        if (!data?.info) return { content: untrusted(url, 'project not found') };
        const i = data.info;
        return { content: untrusted(url, JSON.stringify({ name: i.name, summary: i.summary, home_page: i.home_page, project_urls: i.project_urls, license: i.license, version: i.version })) };
      }
      case 'depsdev_project': {
        const project = needString(input, 'project', 200);
        if (!project || !/^(github\.com|gitlab\.com|bitbucket\.org)\/[\w.-]+\/[\w.-]+$/.test(project)) return { content: 'project must look like github.com/owner/repo', isError: true };
        const url = `${DEPSDEV_API}/v3/projects/${encodeURIComponent(project)}`;
        const data = await ctx.http.fetchJsonOrNull<Record<string, unknown>>(url);
        if (!data) return { content: untrusted(url, 'project not found') };
        const sc = isObj(data.scorecard) ? { overallScore: data.scorecard.overallScore, date: data.scorecard.date } : undefined;
        return { content: untrusted(url, JSON.stringify({ license: data.license, description: data.description, homepage: data.homepage, scorecard: sc, openIssuesCount: data.openIssuesCount, starsCount: data.starsCount })) };
      }
      case 'osv_query': {
        const eco = needString(input, 'ecosystem', 10);
        const pkg = needString(input, 'name', 214);
        if (!pkg || (eco !== 'npm' && eco !== 'PyPI')) return { content: 'ecosystem must be npm or PyPI and name is required', isError: true };
        const url = 'https://api.osv.dev/v1/query';
        const data = await ctx.http.fetchJson<{ vulns?: { id: string; summary?: string; published?: string; aliases?: string[] }[] }>(url, { method: 'POST', body: { package: { name: pkg, ecosystem: eco } } });
        const vulns = (data.vulns ?? []).slice(0, 25).map((v) => ({ id: v.id, aliases: v.aliases, summary: v.summary, published: v.published, url: `https://osv.dev/vulnerability/${v.id}` }));
        return { content: untrusted(url, JSON.stringify({ count: data.vulns?.length ?? 0, vulns })) };
      }
      case 'opencollective_account': {
        const slug = needString(input, 'slug', 100);
        if (!slug || !OC_SLUG_RE.test(slug)) return { content: 'invalid Open Collective slug', isError: true };
        const res = await ctx.http.fetchJson<Parameters<typeof parseOpenCollective>[0]>(OPEN_COLLECTIVE_API, { method: 'POST', body: openCollectiveRequestBody(slug) });
        const parsed = parseOpenCollective(res, slug);
        return { content: untrusted(`https://opencollective.com/${slug}`, parsed ? JSON.stringify(parsed) : 'collective not found') };
      }
      case 'github_user': {
        const login = needString(input, 'login', 39);
        if (!login || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) return { content: 'invalid GitHub login', isError: true };
        // Only the subject's own account: the tool cannot be pointed at other people.
        const subjectLogin = ctx.request.subject.replace(/^person:github\//, '').toLowerCase();
        if (login.toLowerCase() !== subjectLogin) return { content: `github_user only reads the subject's own account (${subjectLogin})`, isError: true };
        const token = process.env.GITHUB_TOKEN?.trim();
        const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(token ? { authorization: `Bearer ${token}` } : {}) };
        const [userUrl, gpgUrl, sshUrl, orgsUrl] = githubUserApiUrls(login) as [string, string, string, string];
        const parts: string[] = [];
        for (const url of [userUrl, gpgUrl, sshUrl, orgsUrl]) {
          const res = await ctx.http.request(url, { headers });
          parts.push(res.status >= 200 && res.status < 300 ? untrusted(url, res.body) : `HTTP ${res.status} from ${url}`);
        }
        return { content: parts.join('\n') };
      }
      case 'registry_fetch': {
        const raw = needString(input, 'url', 500);
        let url: URL;
        try {
          url = new URL(raw ?? '');
        } catch {
          return { content: 'url is not a URL', isError: true };
        }
        if (url.protocol !== 'https:' || url.username || url.password || !(REGISTRY_FETCH_HOSTS as readonly string[]).includes(url.hostname)) {
          return { content: `registry_fetch only reads https URLs on ${REGISTRY_FETCH_HOSTS.join(', ')}; ${url.hostname} is refused`, isError: true };
        }
        const res = await ctx.http.request(url.href, { headers: { accept: 'application/json, text/plain;q=0.9, */*;q=0.5' } });
        if (res.status === 404) return { content: untrusted(url.href, 'HTTP 404 not found') };
        if (res.status < 200 || res.status >= 300) return { content: `HTTP ${res.status} from ${url.hostname}`, isError: true };
        return { content: untrusted(url.href, res.body) };
      }
      default:
        return { content: `unknown tool ${name}`, isError: true };
    }
  } catch (e) {
    return { content: `${name} failed: ${(e as Error).message.slice(0, 200)}`, isError: true };
  }
}
