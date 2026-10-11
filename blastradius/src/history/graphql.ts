/**
 * GitHub login mapping and signature verification through the GraphQL API, within a point budget
 * (docs/WHO-BEHIND-PLAN.md S2, C2; gate: ≤ 2,000 points per 300-repo scan).
 *
 * One request per repository, more only when it has over MAX_ALIASES unmapped people:
 *   query {
 *     rateLimit { cost remaining }
 *     repository(owner, name) {
 *       defaultBranchRef { target { ... on Commit {
 *         history(first: 100) { nodes { oid author { user { login } } signature { isValid state } } }
 *       } } }
 *       c0: object(oid: "<latest commit of an unmapped person>") { ... on Commit { author { user { login } } } }
 *       …
 *     }
 *   }
 * Fields are from GitHub's published schema (Commit.history, Commit.author: GitActor with
 * `user`, Commit.signature: GitSignature with `isValid`/`state`, Repository.object(oid:)):
 * https://docs.github.com/public/fpt/schema.docs.graphql.
 *
 * Cost, as GitHub documents it (https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api,
 * "Predicting the point value of a query"): add up the requests needed to fulfil each connection
 * (each assumed to reach its `first`), divide by 100, round to the nearest whole number; the
 * minimum is 1. `history(first: 100)` under one repository is 1 request, `object(oid:)` is not a
 * connection, so every request here is predicted at 1 point. The budget charges the predicted
 * cost before sending and the `rateLimit.cost` GitHub returns afterwards when it is larger.
 *
 * GitHub's author mapping is "the commit email belongs to this account", so it is reported as
 * medium confidence, like CAF itself (plan §2.4).
 */
import type { HttpClient } from '../core/http.js';

export const GITHUB_GRAPHQL = 'https://api.github.com/graphql';
export const DEFAULT_BUDGET_POINTS = 2000;
/** Aliased commit lookups per request. */
export const MAX_ALIASES = 100;
export const VERIFY_COMMITS = 100;

const OID_RE = /^[0-9a-f]{40}$/;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;

export interface MappingQuery {
  query: string;
  variables: { owner: string; name: string };
  /** id of each alias, in order (c0, c1, …). */
  aliases: string[];
  /** Connections in the query and their `first`, for the cost prediction. */
  connections: { path: string; first: number; parents: number }[];
}

/** GitHub's documented prediction: Σ requests per connection / 100, rounded, minimum 1. */
export function predictCost(connections: MappingQuery['connections']): number {
  const requests = connections.reduce((n, c) => n + c.parents, 0);
  return Math.max(1, Math.round(requests / 100));
}

/** Build the request(s) for one repository: the first verifies, every one maps up to MAX_ALIASES people. */
export function buildMappingQueries(owner: string, name: string, lookups: readonly { id: string; oid: string }[], opts: { verify?: boolean } = {}): MappingQuery[] {
  if (!NAME_RE.test(owner) || !NAME_RE.test(name)) throw new Error('invalid repository name');
  const valid = lookups.filter((l) => OID_RE.test(l.oid));
  const chunks: { id: string; oid: string }[][] = [];
  for (let i = 0; i < valid.length; i += MAX_ALIASES) chunks.push(valid.slice(i, i + MAX_ALIASES));
  if (chunks.length === 0 && opts.verify !== false) chunks.push([]);
  return chunks.map((chunk, i) => {
    const verify = i === 0 && opts.verify !== false;
    const parts = [
      verify
        ? `defaultBranchRef { target { ... on Commit { history(first: ${VERIFY_COMMITS}) { nodes { oid author { user { login } } signature { isValid state } } } } } }`
        : '',
      ...chunk.map((l, j) => `c${j}: object(oid: "${l.oid}") { ... on Commit { author { user { login } } } }`),
    ].filter(Boolean);
    return {
      query: `query($owner: String!, $name: String!) { rateLimit { cost remaining } repository(owner: $owner, name: $name) { ${parts.join(' ')} } }`,
      variables: { owner, name },
      aliases: chunk.map((l) => l.id),
      connections: verify ? [{ path: 'repository.defaultBranchRef.target.history', first: VERIFY_COMMITS, parents: 1 }] : [],
    };
  });
}

export interface MappingResult {
  /** hashed id → login */
  logins: Map<string, string>;
  /** oid → login, for the verified commits */
  commitLogins: Map<string, string>;
  verified?: { checked: number; verified: number };
}

/** Read one response. Unknown shapes give an empty result, never a throw. */
export function parseMappingResponse(q: MappingQuery, body: unknown, into: MappingResult = { logins: new Map(), commitLogins: new Map() }): MappingResult {
  const repo = (body as { data?: { repository?: Record<string, unknown> } } | null)?.data?.repository;
  if (!repo || typeof repo !== 'object') return into;
  q.aliases.forEach((id, j) => {
    const login = (repo[`c${j}`] as { author?: { user?: { login?: unknown } | null } } | null)?.author?.user?.login;
    if (typeof login === 'string' && LOGIN_RE.test(login)) into.logins.set(id, login.toLowerCase());
  });
  const nodes = (repo.defaultBranchRef as { target?: { history?: { nodes?: unknown[] } } } | null)?.target?.history?.nodes;
  if (Array.isArray(nodes)) {
    let verified = 0;
    for (const n of nodes as { oid?: unknown; author?: { user?: { login?: unknown } | null }; signature?: { isValid?: unknown } | null }[]) {
      if (n?.signature?.isValid === true) verified++;
      const login = n?.author?.user?.login;
      if (typeof n?.oid === 'string' && typeof login === 'string' && LOGIN_RE.test(login)) into.commitLogins.set(n.oid, login.toLowerCase());
    }
    into.verified = { checked: nodes.length, verified };
  }
  return into;
}

/** Points spent in one scan. */
export class GraphqlBudget {
  used = 0;
  requests = 0;
  skipped = 0;
  constructor(readonly limit: number = DEFAULT_BUDGET_POINTS) {}
  /** Reserve the predicted cost; false when it would pass the limit. */
  reserve(predicted: number): boolean {
    if (this.used + predicted > this.limit) {
      this.skipped++;
      return false;
    }
    this.used += predicted;
    this.requests++;
    return true;
  }
  /** Settle against GitHub's reported cost. */
  settle(predicted: number, reported: unknown): void {
    if (typeof reported === 'number' && reported > predicted) this.used += reported - predicted;
  }
}

/** Map a repository's hashed ids to logins and read verification, within the budget. */
export async function mapLogins(
  http: HttpClient,
  repo: { owner: string; name: string },
  lookups: readonly { id: string; oid: string }[],
  opts: { token: string; budget: GraphqlBudget; url?: string },
): Promise<MappingResult> {
  const result: MappingResult = { logins: new Map(), commitLogins: new Map() };
  for (const q of buildMappingQueries(repo.owner, repo.name, lookups)) {
    const predicted = predictCost(q.connections);
    if (!opts.budget.reserve(predicted)) break;
    const res = await http.request(opts.url ?? GITHUB_GRAPHQL, {
      method: 'POST',
      headers: { authorization: `Bearer ${opts.token}`, accept: 'application/json' },
      body: { query: q.query, variables: q.variables },
    });
    if (res.status !== 200) throw new Error(`GitHub GraphQL answered ${res.status}`);
    let body: unknown;
    try {
      body = JSON.parse(res.body);
    } catch {
      throw new Error('GitHub GraphQL answered with non-JSON');
    }
    opts.budget.settle(predicted, (body as { data?: { rateLimit?: { cost?: unknown } } })?.data?.rateLimit?.cost);
    parseMappingResponse(q, body, result);
  }
  return result;
}
