/**
 * Account index (docs/ACCOUNT-PROOF.md): who can publish the packages every project depends on,
 * "account X is compromised" (every exposed project, package and version, without a re-scan), and
 * which accounts can publish the largest share of production dependencies.
 *
 * - AccountIndexer fetches npm packuments for every package in the projects' latest inventories
 *   (after each scan and on a timer) and an account's own package listing on demand, through the
 *   shared HttpClient: its per-host rate limits, disk cache, retries and offline fixtures apply.
 *   Nothing is guessed: a package without registry data is counted as such.
 * - The queries read the store only. Registry data is public; what an org is exposed to is always
 *   computed against that org's own inventories and the caller's visible projects.
 *
 * No burst alert: the burst rule failed its noise gate (H2). Publish activity is context only.
 */
import { join } from 'node:path';
import { defaultCacheDir } from '../core/paths.js';
import { HttpClient, OfflineMissError } from '../core/http.js';
import { fetchPackument } from '../enrich/npm/registry.js';
import { indexFromPackument, isAccountName, npmProfileUrl, parseUserPackages, userPackagesUrl } from '../accounts/registry.js';
import { npmPackagePage } from '../enrich/npm/registry.js';
import { buildDependencyGraph, scopeExposure, type DependencyGraph } from '../scoring/blast.js';
import { AccountIndex, type PackageTimeline } from '../watch/account.js';
import type { ExposureHit, StoredInventory } from '../watch/match.js';
import type {
  AccountDetail,
  AccountExposureResponse,
  AccountExposureRow,
  AccountIncidentRef,
  AccountIndexState,
  AccountLinkSource,
  AccountPackage,
  AccountPublish,
  AccountRef,
  AccountRegistry,
  ConcentrationAccount,
  ConcentrationResponse,
  ConcentrationScope,
  LinkConfidence,
} from './api-types-accounts.js';
import type { IncidentContext } from './incidents.js';
import { npmNameVersion, pathsTo, viaOf } from './reach.js';
import {
  accountIncidentFor,
  accountListing,
  all,
  findingFor,
  get,
  incidentStates,
  latestInventories,
  linksOfAccount,
  listProjects,
  namesToRefresh,
  registryPackages,
  setAccountListing,
  upsertRegistryPackage,
  type StoredLink,
  type StoredPackage,
  type Store,
} from './store/index.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Below this a path only comes through dev or optional dependencies (as in reach.ts). */
const DEV_EXPOSURE = 0.5;

// ---------------------------------------------------------------------------
// Indexer
// ---------------------------------------------------------------------------

export interface AccountIndexerOptions {
  /** Shared client (tests inject an offline one). Default: one per mode, created on first use. */
  http?: HttpClient;
  /** Server-wide offline mode: only recorded fixtures, never the network. */
  offline?: boolean;
  fixturesDir?: string;
  /** Disk cache (default the per-user cache dir; false disables). */
  cacheDir?: string | false;
  /** Re-fetch a package's registry data after this long (default 24 h). */
  ttlMs?: number;
  /** Packuments fetched at once (default 4; the HttpClient still spaces requests per host). */
  concurrency?: number;
  /** Listed packages of one account indexed on demand (default 300). */
  listingCap?: number;
  log?: (m: string) => void;
}

export interface FetchMode {
  offline: boolean;
  fixturesDir?: string;
}

export class AccountIndexer {
  private readonly clients = new Map<string, HttpClient>();
  private running: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private readonly ttlMs: number;
  private readonly log: (m: string) => void;

  constructor(
    private readonly store: Store,
    private readonly opts: AccountIndexerOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? DAY;
    this.log = opts.log ?? (() => {});
  }

  /** The server-wide mode (offline with fixtures, or live). */
  get defaultMode(): FetchMode {
    return { offline: this.opts.offline === true, ...(this.opts.fixturesDir !== undefined ? { fixturesDir: this.opts.fixturesDir } : {}) };
  }

  private client(mode: FetchMode): HttpClient {
    if (this.opts.http) return this.opts.http;
    const offline = mode.offline || this.opts.offline === true;
    const fixturesDir = mode.fixturesDir ?? this.opts.fixturesDir;
    const key = `${offline}\u0000${fixturesDir ?? ''}`;
    let c = this.clients.get(key);
    if (!c) {
      c = new HttpClient({ offline, ...(fixturesDir !== undefined ? { fixturesDir } : {}), cacheDir: this.opts.cacheDir === undefined ? join(defaultCacheDir(), 'http') : this.opts.cacheDir });
      this.clients.set(key, c);
    }
    return c;
  }

  /** Fetch registry data for `names` that are missing or older than the TTL. */
  async refreshNames(names: Iterable<string>, mode: FetchMode = this.defaultMode, opts: { force?: boolean } = {}): Promise<{ fetched: number; failed: number }> {
    const olderThan = opts.force ? new Date(this.store.now().getTime() + 1).toISOString() : new Date(this.store.now().getTime() - this.ttlMs).toISOString();
    const todo = namesToRefresh(this.store, names, olderThan);
    const http = this.client(mode);
    let fetched = 0;
    let failed = 0;
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const name = todo[next++]!;
        try {
          const p = await fetchPackument(http, name);
          if (p) upsertRegistryPackage(this.store, indexFromPackument(p, name));
          else upsertRegistryPackage(this.store, { name, status: 'missing', detail: 'The registry has no such package (404)' });
          fetched++;
        } catch (e) {
          failed++;
          upsertRegistryPackage(this.store, { name, status: 'unavailable', detail: unavailableReason(e) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(8, this.opts.concurrency ?? 4)) }, worker));
    return { fetched, failed };
  }

  /** Every npm package in one project's latest inventory (after a scan). Never throws. */
  afterScan(projectId: string, mode: FetchMode = this.defaultMode): void {
    const orgId = get<{ org_id: string }>(this.store, 'SELECT org_id FROM project WHERE id = ?', projectId)?.org_id;
    if (!orgId) return;
    this.enqueue(async () => {
      const r = await this.refreshNames(npmNames(latestInventories(this.store, orgId, [projectId])), mode);
      if (r.fetched + r.failed > 0) this.log(`account index: ${r.fetched} packages indexed for project ${projectId}${r.failed ? `, ${r.failed} unavailable` : ''}`);
    });
  }

  /** Every org's latest inventories (the timer). */
  refreshAll(mode: FetchMode = this.defaultMode): Promise<number> {
    return this.enqueue(async () => {
      const names = new Set<string>();
      for (const { id } of all<{ id: string }>(this.store, 'SELECT id FROM org ORDER BY id')) for (const n of npmNames(latestInventories(this.store, id))) names.add(n);
      const r = await this.refreshNames(names, mode);
      if (r.fetched + r.failed > 0) this.log(`account index: ${r.fetched} packages refreshed${r.failed ? `, ${r.failed} unavailable` : ''}`);
      return r.fetched;
    });
  }

  /**
   * One account's own package listing (npm), then the registry data of the listed packages (up to
   * `listingCap`), so its sibling packages are known. Waits for the result.
   */
  refreshAccount(account: string, mode: FetchMode = this.defaultMode): Promise<void> {
    // Not queued behind a sweep (which can take minutes live): someone is waiting for this one. A
    // packument already being fetched by the sweep is shared (fetchPackument dedupes in-flight requests).
    return this.track(async () => {
      if (!isAccountName(account)) return;
      const prev = accountListing(this.store, account);
      const stale = !prev || Date.parse(prev.fetchedAt) < this.store.now().getTime() - this.ttlMs;
      if (stale) {
        try {
          const data = await this.client(mode).fetchJsonOrNull<unknown>(userPackagesUrl(account));
          setAccountListing(this.store, account, data === null ? { unavailable: 'The registry has no such account (404)' } : { packages: parseUserPackages(data) });
        } catch (e) {
          setAccountListing(this.store, account, { unavailable: unavailableReason(e) });
        }
      }
      const listed = accountListing(this.store, account);
      if (listed?.status === 'ok') await this.refreshNames(listed.packages.slice(0, this.opts.listingCap ?? 300), mode);
    });
  }

  start(intervalMinutes: number): void {
    if (intervalMinutes <= 0) return;
    const sweep = () => void this.refreshAll().catch((e) => this.log(`account index: refresh failed: ${(e as Error).message}`));
    sweep();
    this.timer = setInterval(sweep, intervalMinutes * 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Wait for queued and on-demand refreshes (tests, shutdown). */
  async idle(): Promise<void> {
    while (true) {
      const pending = [this.running, ...this.inflight];
      await Promise.all(pending.map((p) => p.catch(() => undefined)));
      if (pending.length === 1 + this.inflight.size && this.running === pending[0]) return;
    }
  }

  private readonly inflight = new Set<Promise<unknown>>();

  private track<T>(fn: () => Promise<T>): Promise<T> {
    const p = fn();
    this.inflight.add(p);
    const done = () => this.inflight.delete(p);
    p.then(done, done);
    return p;
  }

  /** Refreshes run one at a time, so two never fetch the same packument at once. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.running.then(fn);
    this.running = run.catch((e) => this.log(`account index: ${(e as Error).message}`));
    return run;
  }
}

function unavailableReason(e: unknown): string {
  if (e instanceof OfflineMissError) return 'Offline: not in the recorded registry data';
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/\s+/g, ' ').slice(0, 300);
}

function npmNames(invs: readonly StoredInventory[]): Set<string> {
  const out = new Set<string>();
  for (const s of invs) for (const c of s.inventory.components) if (c.ecosystem === 'npm') out.add(c.name);
  return out;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function accountRef(registry: AccountRegistry, name: string): AccountRef {
  return {
    registry,
    name,
    entityId: registry === 'npm' ? `account:npm/${name}` : `org:${registry}/${name}`,
    profileUrl: registry === 'npm' ? npmProfileUrl(name) : `https://${registry}.com/${encodeURIComponent(name)}`,
  };
}

/** Production npm components of one inventory: reached from a production asset through runtime-like edges only. */
export function productionPurls(g: DependencyGraph): Set<string> {
  const out = new Set<string>();
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const a of g.assets.values()) if (a.environment === 'prod') queue.push(a.id), seen.add(a.id);
  while (queue.length) {
    const n = queue.pop()!;
    for (const e of g.out.get(n) ?? []) {
      if (scopeExposure(e.scope) < DEV_EXPOSURE || seen.has(e.other)) continue;
      seen.add(e.other);
      out.add(e.other);
      queue.push(e.other);
    }
  }
  return out;
}

interface InvIndex {
  inv: StoredInventory;
  graph: DependencyGraph;
  prod: Set<string>;
}

function indexInventories(invs: readonly StoredInventory[]): InvIndex[] {
  return invs.map((inv) => {
    const graph = buildDependencyGraph(inv.inventory);
    return { inv, graph, prod: productionPurls(graph) };
  });
}

/**
 * Versions `account` published within [from, to], oldest first, in one pass per package. Same rule
 * as AccountIndex.publisherOf: `_npmUser`, or for a deleted version the sole maintainer of the
 * latest earlier version that lists maintainers.
 */
export function publishesBy(pkgs: Iterable<StoredPackage>, account: string, from: number, to: number): { name: string; version: string; at: number; attribution: 'npmUser' | 'sole-maintainer' }[] {
  const out: { name: string; version: string; at: number; attribution: 'npmUser' | 'sole-maintainer' }[] = [];
  for (const p of pkgs) {
    if (p.status !== 'ok') continue;
    let lastM: string[] | undefined;
    for (const e of p.versions) {
      const at = Date.parse(e.t);
      if (at >= from && at <= to) {
        if (e.u === account) out.push({ name: p.name, version: e.v, at, attribution: 'npmUser' });
        else if (!e.u && lastM?.length === 1 && lastM[0] === account) out.push({ name: p.name, version: e.v, at, attribution: 'sole-maintainer' });
      }
      if (e.m) lastM = e.m;
    }
  }
  return out.sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));
}

const CONF_RANK: Record<LinkConfidence, number> = { high: 3, medium: 2, low: 1 };
const best = (xs: readonly LinkConfidence[]): LinkConfidence => xs.reduce<LinkConfidence>((m, c) => (CONF_RANK[c] > CONF_RANK[m] ? c : m), 'low');

function linkSource(l: StoredLink): AccountLinkSource {
  return { relation: l.relation, source: l.source, confidence: l.confidence, evidence: l.evidence };
}

interface Universe {
  account: AccountRef;
  invs: InvIndex[];
  /** Registry data for inventory packages and the account's linked packages. */
  pkgs: Map<string, StoredPackage>;
  links: StoredLink[];
  index: AccountIndex;
  state: AccountIndexState;
  /** Inventory package name → projects / production. */
  usage: Map<string, { projects: Set<string>; production: boolean }>;
}

function universe(ctx: IncidentContext, registry: AccountRegistry, name: string): Universe {
  const invs = indexInventories(latestInventories(ctx.store, ctx.orgId, ctx.projectIds));
  const usage = new Map<string, { projects: Set<string>; production: boolean }>();
  for (const { inv, prod } of invs)
    for (const c of inv.inventory.components) {
      if (c.ecosystem !== 'npm') continue;
      const u = usage.get(c.name) ?? { projects: new Set<string>(), production: false };
      u.projects.add(inv.projectId);
      u.production ||= prod.has(c.purl);
      usage.set(c.name, u);
    }
  const links = linksOfAccount(ctx.store, registry, name);
  const pkgs = registryPackages(ctx.store, [...usage.keys(), ...links.map((l) => l.package)]);
  const timelines: PackageTimeline[] = [...pkgs.values()].filter((p) => p.status === 'ok').map((p) => ({ name: p.name, versions: p.versions }));
  const listing = registry === 'npm' ? accountListing(ctx.store, name) : null;
  const inUse = [...usage.keys()];
  const indexed = inUse.filter((n) => pkgs.get(n)?.status === 'ok').length;
  return {
    account: accountRef(registry, name),
    invs,
    pkgs,
    links,
    index: new AccountIndex(timelines),
    usage,
    state: {
      packagesIndexed: indexed,
      packagesWithoutData: inUse.length - indexed,
      listing: listing ? { status: listing.status, fetchedAt: listing.fetchedAt, count: listing.packages.length, detail: listing.detail } : null,
      unverified: listing ? listing.packages.filter((p) => pkgs.get(p)?.status !== 'ok').length : 0,
    },
  };
}

/** Packages the account can publish, with the links that say so. */
function canPublish(u: Universe, asOfMs: number | null): Map<string, AccountLinkSource[]> {
  const out = new Map<string, AccountLinkSource[]>();
  const add = (pkg: string, l: AccountLinkSource) => (out.get(pkg) ?? out.set(pkg, []).get(pkg)!).push(l);
  if (u.account.registry !== 'npm') {
    // A repository owner can change the code (and often the CI that publishes it); current only.
    for (const l of u.links) if (l.relation === 'repo_owner') add(l.package, linkSource(l));
    return out;
  }
  if (asOfMs === null) {
    for (const l of u.links) if (l.relation === 'maintainer' || l.relation === 'listed') add(l.package, linkSource(l));
    return out;
  }
  for (const pkg of u.index.packagesOf(u.account.name, asOfMs))
    add(pkg, { relation: 'version_maintainer', source: `npm version maintainers as of ${new Date(asOfMs).toISOString()}`, confidence: 'high', evidence: npmPackagePage(pkg) });
  return out;
}

function incidentRef(ctx: IncidentContext, registry: AccountRegistry, name: string): AccountIncidentRef | null {
  const row = accountIncidentFor(ctx.store, ctx.orgId, registry, name);
  if (!row) return null;
  const status = incidentStates(ctx.store, ctx.orgId, [row.incidentId]).get(row.incidentId)?.status ?? 'investigating';
  return { id: row.incidentId, status, since: row.since, markedAt: row.markedAt };
}

function packagesList(u: Universe, can: Map<string, AccountLinkSource[]>): AccountPackage[] {
  return [...can.entries()]
    .map(([name, links]) => {
      const use = u.usage.get(name);
      return { name, links, projects: use?.projects.size ?? 0, production: use?.production ?? false };
    })
    .sort((a, b) => b.projects - a.projects || Number(b.production) - Number(a.production) || a.name.localeCompare(b.name));
}

export interface ExposureQuery {
  since?: string;
  asOf?: string;
}

/** "Account X is compromised": every exposed project, package and version, from stored data only. */
export function accountExposure(ctx: IncidentContext, registry: AccountRegistry, name: string, q: ExposureQuery = {}): AccountExposureResponse {
  const u = universe(ctx, registry, name);
  const nowMs = ctx.store.now().getTime();
  const asOfMs = q.asOf ? Date.parse(q.asOf) : nowMs;
  const historical = q.asOf !== undefined && registry === 'npm';
  const sinceMs = q.since ? Date.parse(q.since) : null;
  const can = canPublish(u, historical ? asOfMs : null);

  // Versions the account published within [since, asOf].
  const published = new Map<string, AccountPublish>();
  if (sinceMs !== null && registry === 'npm') {
    for (const e of publishesBy(u.pkgs.values(), name, sinceMs, asOfMs)) {
      published.set(`${e.name}@${e.version}`, { name: e.name, version: e.version, at: new Date(e.at).toISOString(), attribution: e.attribution, projects: 0 });
    }
  }

  const owners = new Map(listProjects(ctx.store, ctx.orgId, ctx.projectIds).map((p) => [p.id, p.owner] as const));
  const exposures: AccountExposureRow[] = [];
  for (const { inv, graph, prod } of u.invs) {
    for (const c of inv.inventory.components) {
      if (c.ecosystem !== 'npm') continue;
      const nv = npmNameVersion(c.purl);
      if (!nv) continue;
      const links = can.get(nv.name);
      const pub = published.get(`${nv.name}@${nv.version}`);
      if (!links && !pub) continue;
      if (pub) pub.projects++;
      const by = registry === 'npm' ? u.index.publisherOf(nv.name, nv.version) : undefined;
      const at = by ? u.index.timeline(nv.name)?.versions.find((v) => v.v === nv.version)?.t : undefined;
      const rowLinks = [...(links ?? [])];
      if (pub)
        rowLinks.push({ relation: 'publisher', source: pub.attribution === 'npmUser' ? 'npm _npmUser of this version' : 'sole maintainer before this deleted version', confidence: pub.attribution === 'npmUser' ? 'high' : 'medium', evidence: npmPackagePage(nv.name, nv.version) });
      const paths = pathsTo(inv.inventory, c.purl, graph);
      exposures.push({
        projectId: inv.projectId,
        projectName: inv.projectName,
        owner: owners.get(inv.projectId) ?? null,
        purl: c.purl,
        name: nv.name,
        version: nv.version,
        production: prod.has(c.purl),
        direct: paths.some((p) => p.nodes.length === 2),
        broughtInBy: [...new Set(paths.filter((p) => p.nodes.length > 2).map(viaOf))].slice(0, 10),
        reasons: [...(links ? (['can_publish'] as const) : []), ...(pub ? (['published_since'] as const) : [])],
        publishedBy: by && at ? { account: by.account, attribution: by.attribution, at } : null,
        links: rowLinks,
        confidence: best(rowLinks.map((l) => l.confidence)),
        findingId: findingFor(ctx.store, inv.scanId, c.purl)?.id ?? null,
      });
    }
  }
  exposures.sort((a, b) => Number(b.production) - Number(a.production) || a.projectName.localeCompare(b.projectName) || a.purl.localeCompare(b.purl));
  const packages = packagesList(u, can);
  const publishedSince = [...published.values()].sort((a, b) => b.at.localeCompare(a.at) || a.name.localeCompare(b.name));
  return {
    account: u.account,
    since: q.since ?? null,
    asOf: new Date(asOfMs).toISOString(),
    historical,
    projectsSearched: u.invs.length,
    packages,
    publishedSince,
    exposures,
    counts: {
      exposures: exposures.length,
      projects: new Set(exposures.map((e) => e.projectId)).size,
      production: new Set(exposures.filter((e) => e.production).map((e) => e.projectId)).size,
      packages: packages.length,
      packagesInYourProjects: packages.filter((p) => p.projects > 0).length,
      versionsPublishedSince: publishedSince.length,
    },
    index: u.state,
    incident: incidentRef(ctx, registry, name),
  };
}

/** The Account page: what it can publish now, recent publish activity (context), its share of production dependencies. */
export function accountDetail(ctx: IncidentContext, registry: AccountRegistry, name: string): AccountDetail {
  const u = universe(ctx, registry, name);
  const can = canPublish(u, null);
  const nowMs = ctx.store.now().getTime();
  const locked = new Map<string, number>();
  for (const { inv } of u.invs) for (const c of inv.inventory.components) if (c.ecosystem === 'npm') locked.set(`${c.name}@${c.version}`, (locked.get(`${c.name}@${c.version}`) ?? 0) + 1);
  // Every attributable publish the index knows (any age); the counts are relative to now.
  const events = registry === 'npm' ? publishesBy(u.pkgs.values(), name, 0, nowMs) : [];
  const recentPublishes: AccountPublish[] = events
    .slice(-25)
    .reverse()
    .map((e) => ({ name: e.name, version: e.version, at: new Date(e.at).toISOString(), attribution: e.attribution, projects: locked.get(`${e.name}@${e.version}`) ?? 0 }));
  const distinct = (ms: number) => new Set(events.filter((e) => e.at >= nowMs - ms).map((e) => e.name)).size;
  const org = orgConcentration(u.invs, u.pkgs);
  const mine = registry === 'npm' ? (org.counts.get(name) ?? 0) : 0;
  return {
    account: u.account,
    known: can.size > 0 || u.links.length > 0,
    packages: packagesList(u, can),
    recentPublishes,
    activity: { last24h: distinct(DAY), last7d: distinct(7 * DAY), last30d: distinct(30 * DAY) },
    concentration: { packages: mine, of: org.withData, share: org.withData ? round3(mine / org.withData) : 0 },
    index: u.state,
    incident: incidentRef(ctx, registry, name),
  };
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** Who can publish each production package now: the packument's maintainers. */
function maintainersOf(pkgs: Map<string, StoredPackage>, name: string): string[] | null {
  const p = pkgs.get(name);
  if (!p || p.status !== 'ok') return null;
  if (p.maintainers.length) return p.maintainers;
  // No top-level list: fall back to the newest version's maintainers.
  for (let i = p.versions.length - 1; i >= 0; i--) if (p.versions[i]!.m?.length) return p.versions[i]!.m!;
  return [];
}

function scopeOf(prodKeys: Iterable<string>, pkgs: Map<string, StoredPackage>, limit: number): ConcentrationScope & { counts: Map<string, number> } {
  const counts = new Map<string, number>();
  let total = 0;
  let withData = 0;
  for (const key of prodKeys) {
    total++;
    const name = key.slice(0, key.lastIndexOf('@'));
    const m = maintainersOf(pkgs, name);
    if (m === null) continue;
    withData++;
    for (const a of new Set(m)) counts.set(a, (counts.get(a) ?? 0) + 1);
  }
  const accounts: ConcentrationAccount[] = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name, n]) => ({ registry: 'npm', name, packages: n, share: withData ? round3(n / withData) : 0 }));
  return { productionPackages: total, withData, accounts, counts };
}

function prodKeysOf(x: InvIndex): Set<string> {
  const keys = new Set<string>();
  for (const purl of x.prod) {
    const c = x.graph.components.get(purl);
    if (c?.ecosystem === 'npm') keys.add(`${c.name}@${c.version}`);
  }
  return keys;
}

function orgConcentration(invs: InvIndex[], pkgs: Map<string, StoredPackage>, limit = 0) {
  const keys = new Set<string>();
  for (const x of invs) for (const k of prodKeysOf(x)) keys.add(k);
  return scopeOf(keys, pkgs, limit);
}

/** H3: per project and org-wide, the accounts that can publish the largest share of production dependencies. */
export function concentration(ctx: IncidentContext, opts: { limit?: number } = {}): ConcentrationResponse {
  const limit = Math.max(0, Math.min(50, opts.limit ?? 10));
  const invs = indexInventories(latestInventories(ctx.store, ctx.orgId, ctx.projectIds));
  const names = new Set<string>();
  for (const x of invs) for (const k of prodKeysOf(x)) names.add(k.slice(0, k.lastIndexOf('@')));
  const pkgs = registryPackages(ctx.store, names);
  const org = orgConcentration(invs, pkgs, limit);
  const perProject = invs.map((x) => {
    const sc = scopeOf(prodKeysOf(x), pkgs, Math.min(limit, 5));
    return { projectId: x.inv.projectId, projectName: x.inv.projectName, productionPackages: sc.productionPackages, withData: sc.withData, accounts: sc.accounts, counts: sc.counts };
  });
  const projectsOf = (a: string) => perProject.filter((p) => (p.counts.get(a) ?? 0) > 0).length;
  return {
    org: { productionPackages: org.productionPackages, withData: org.withData, accounts: org.accounts.map((a) => ({ ...a, projects: projectsOf(a.name) })) },
    projects: perProject
      .map(({ counts: _c, ...p }) => p)
      .sort((a, b) => (b.accounts[0]?.share ?? 0) - (a.accounts[0]?.share ?? 0) || a.projectName.localeCompare(b.projectName)),
  };
}

// ---------------------------------------------------------------------------
// Mark as compromised
// ---------------------------------------------------------------------------

/** Exposure rows as incident alerts (one per project × package version). */
export function compromiseHits(ctx: IncidentContext, incidentId: string, exposure: AccountExposureResponse): ExposureHit[] {
  const scans = new Map(latestInventories(ctx.store, ctx.orgId, ctx.projectIds).map((i) => [i.projectId, i.scanId] as const));
  const what = `Account marked as compromised${exposure.since ? `; versions it published since ${exposure.since.slice(0, 16).replace('T', ' ')} UTC are critical` : ''}`;
  return exposure.exposures.map((e) => {
    const via = e.direct ? (e.broughtInBy.length ? `Direct dependency, also brought in by ${e.broughtInBy.slice(0, 2).join(', ')}` : 'Direct dependency') : `Brought in by ${e.broughtInBy.slice(0, 2).join(', ') || 'another package'}`;
    const scanId = scans.get(e.projectId);
    return {
      projectId: e.projectId,
      projectName: e.projectName,
      ...(scanId ? { scanId } : {}),
      purl: e.purl,
      name: e.name,
      version: e.version,
      advisoryId: incidentId,
      // A version the account published in the window is the likely bad release; anything else it
      // can publish is at risk of the next one.
      level: e.reasons.includes('published_since') ? 'critical' : 'high',
      summary: what,
      assets: [],
      production: e.production,
      reachText: `${via} · ${e.production ? 'production' : 'dev and test only'}`,
    };
  });
}
