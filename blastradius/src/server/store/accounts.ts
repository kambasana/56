/**
 * Account index in the store (migration 9). Registry data is public and shared by every org:
 * registry_package (one fetched packument, compacted), registry_account (an account's own package
 * listing) and account_link (who can publish what, with source and confidence). What an org is
 * exposed to is always computed against that org's own stored inventories (../accounts.ts).
 *
 * account_incident maps an org's "account X is compromised" incident id to the account.
 */
import { decodeVersions, encodeVersions, npmProfileUrl, type EncodedVersions, type IndexedPackage, type RepoOwner } from '../../accounts/registry.js';
import { npmPackagePage } from '../../enrich/npm/registry.js';
import { writeAudit } from './audit.js';
import { plural } from './findings.js';
import { all, get, nowIso, parseJson, placeholders, run, tx, type Store } from './db.js';

export type AccountRegistry = 'npm' | 'github' | 'gitlab';
export type LinkRelation = 'maintainer' | 'repo_owner' | 'listed';
export type LinkConfidence = 'high' | 'medium' | 'low';
export type IndexStatus = 'ok' | 'missing' | 'unavailable';

export interface StoredPackage extends IndexedPackage {
  status: IndexStatus;
  detail: string | null;
  fetchedAt: string;
}

export interface StoredLink {
  registry: AccountRegistry;
  account: string;
  package: string;
  relation: LinkRelation;
  source: string;
  confidence: LinkConfidence;
  evidence: string;
  updatedAt: string;
}

interface PackageRow {
  name: string;
  status: IndexStatus;
  detail: string | null;
  fetched_at: string;
  maintainers_json: string;
  repo_host: string | null;
  repo_owner: string | null;
  repo_url: string | null;
  versions_json: string;
}

const EMPTY: EncodedVersions = { sets: [], v: [] };

function toPackage(r: PackageRow): StoredPackage {
  const repo: RepoOwner | null = (r.repo_host === 'github' || r.repo_host === 'gitlab') && r.repo_owner && r.repo_url ? { host: r.repo_host, owner: r.repo_owner, url: r.repo_url } : null;
  return {
    name: r.name,
    status: r.status,
    detail: r.detail,
    fetchedAt: r.fetched_at,
    maintainers: parseJson<string[]>(r.maintainers_json, []),
    repo,
    versions: decodeVersions(parseJson<EncodedVersions>(r.versions_json, EMPTY)),
  };
}

/** Store one fetched package (or why it could not be fetched) and rebuild its package-level links. */
export function upsertRegistryPackage(s: Store, pkg: IndexedPackage | { name: string; status: Exclude<IndexStatus, 'ok'>; detail: string }): void {
  const at = nowIso(s);
  tx(s, () => {
    if ('status' in pkg) {
      // Keep the last good copy when a refresh fails: mark nothing, only record the failure if we
      // never had data.
      const prev = get<{ status: string }>(s, "SELECT status FROM registry_package WHERE registry = 'npm' AND name = ?", pkg.name);
      if (prev?.status === 'ok' && pkg.status === 'unavailable') {
        run(s, "UPDATE registry_package SET detail = ? WHERE registry = 'npm' AND name = ?", `Last refresh failed: ${pkg.detail}`.slice(0, 500), pkg.name);
        return;
      }
      run(
        s,
        `INSERT INTO registry_package (registry, name, status, detail, fetched_at) VALUES ('npm', ?, ?, ?, ?)
         ON CONFLICT (registry, name) DO UPDATE SET status = excluded.status, detail = excluded.detail, fetched_at = excluded.fetched_at,
           maintainers_json = '[]', repo_host = NULL, repo_owner = NULL, repo_url = NULL, versions_json = '{"sets":[],"v":[]}'`,
        pkg.name,
        pkg.status,
        pkg.detail.slice(0, 500),
        at,
      );
      run(s, "DELETE FROM account_link WHERE package = ? AND relation IN ('maintainer', 'repo_owner')", pkg.name);
      return;
    }
    run(
      s,
      `INSERT INTO registry_package (registry, name, status, detail, fetched_at, maintainers_json, repo_host, repo_owner, repo_url, versions_json)
       VALUES ('npm', ?, 'ok', NULL, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (registry, name) DO UPDATE SET status = 'ok', detail = NULL, fetched_at = excluded.fetched_at, maintainers_json = excluded.maintainers_json,
         repo_host = excluded.repo_host, repo_owner = excluded.repo_owner, repo_url = excluded.repo_url, versions_json = excluded.versions_json`,
      pkg.name,
      at,
      JSON.stringify(pkg.maintainers),
      pkg.repo?.host ?? null,
      pkg.repo?.owner ?? null,
      pkg.repo?.url ?? null,
      JSON.stringify(encodeVersions(pkg.versions)),
    );
    run(s, "DELETE FROM account_link WHERE package = ? AND relation IN ('maintainer', 'repo_owner')", pkg.name);
    for (const m of new Set(pkg.maintainers)) {
      run(
        s,
        `INSERT INTO account_link (account_registry, account, package, relation, source, confidence, evidence, updated_at) VALUES ('npm', ?, ?, 'maintainer', 'npm packument maintainers', 'high', ?, ?)`,
        m,
        pkg.name,
        npmPackagePage(pkg.name),
        at,
      );
    }
    if (pkg.repo) {
      run(
        s,
        `INSERT INTO account_link (account_registry, account, package, relation, source, confidence, evidence, updated_at) VALUES (?, ?, ?, 'repo_owner', 'repository field of the packument', 'medium', ?, ?)`,
        pkg.repo.host,
        pkg.repo.owner,
        pkg.name,
        pkg.repo.url,
        at,
      );
    }
  });
}

/** Stored packages by name (only names that have a row). */
export function registryPackages(s: Store, names: Iterable<string>): Map<string, StoredPackage> {
  const list = [...new Set(names)];
  const out = new Map<string, StoredPackage>();
  for (let i = 0; i < list.length; i += 500) {
    const chunk = list.slice(i, i + 500);
    for (const r of all<PackageRow>(s, `SELECT name, status, detail, fetched_at, maintainers_json, repo_host, repo_owner, repo_url, versions_json FROM registry_package WHERE registry = 'npm' AND name IN (${placeholders(chunk.length)})`, ...chunk))
      out.set(r.name, toPackage(r));
  }
  return out;
}

/** Of `names`, those never fetched or fetched before `olderThan` (ISO). */
export function namesToRefresh(s: Store, names: Iterable<string>, olderThan: string): string[] {
  const list = [...new Set(names)].sort();
  const fresh = new Set<string>();
  for (let i = 0; i < list.length; i += 500) {
    const chunk = list.slice(i, i + 500);
    for (const r of all<{ name: string }>(s, `SELECT name FROM registry_package WHERE registry = 'npm' AND fetched_at >= ? AND name IN (${placeholders(chunk.length)})`, olderThan, ...chunk)) fresh.add(r.name);
  }
  return list.filter((n) => !fresh.has(n));
}

export interface AccountListing {
  status: 'ok' | 'unavailable';
  detail: string | null;
  fetchedAt: string;
  packages: string[];
}

export function accountListing(s: Store, account: string): AccountListing | null {
  const r = get<{ status: 'ok' | 'unavailable'; detail: string | null; fetched_at: string; packages_json: string }>(s, "SELECT status, detail, fetched_at, packages_json FROM registry_account WHERE registry = 'npm' AND name = ?", account);
  return r ? { status: r.status, detail: r.detail, fetchedAt: r.fetched_at, packages: parseJson<string[]>(r.packages_json, []) } : null;
}

/** Store an account's own listing; 'listed' links follow it. A failed refresh keeps the last good list. */
export function setAccountListing(s: Store, account: string, listing: { packages: string[] } | { unavailable: string }): void {
  const at = nowIso(s);
  tx(s, () => {
    if ('unavailable' in listing) {
      const prev = accountListing(s, account);
      if (prev?.status === 'ok') {
        run(s, "UPDATE registry_account SET detail = ? WHERE registry = 'npm' AND name = ?", `Last refresh failed: ${listing.unavailable}`.slice(0, 500), account);
        return;
      }
      run(
        s,
        `INSERT INTO registry_account (registry, name, status, detail, fetched_at) VALUES ('npm', ?, 'unavailable', ?, ?)
         ON CONFLICT (registry, name) DO UPDATE SET status = 'unavailable', detail = excluded.detail, fetched_at = excluded.fetched_at`,
        account,
        listing.unavailable.slice(0, 500),
        at,
      );
      return;
    }
    run(
      s,
      `INSERT INTO registry_account (registry, name, status, detail, fetched_at, packages_json) VALUES ('npm', ?, 'ok', NULL, ?, ?)
       ON CONFLICT (registry, name) DO UPDATE SET status = 'ok', detail = NULL, fetched_at = excluded.fetched_at, packages_json = excluded.packages_json`,
      account,
      at,
      JSON.stringify(listing.packages),
    );
    run(s, "DELETE FROM account_link WHERE account_registry = 'npm' AND account = ? AND relation = 'listed'", account);
    for (const p of new Set(listing.packages)) {
      run(
        s,
        `INSERT INTO account_link (account_registry, account, package, relation, source, confidence, evidence, updated_at) VALUES ('npm', ?, ?, 'listed', 'npm account package listing', 'high', ?, ?)`,
        account,
        p,
        npmProfileUrl(account),
        at,
      );
    }
  });
}

interface LinkRow {
  account_registry: AccountRegistry;
  account: string;
  package: string;
  relation: LinkRelation;
  source: string;
  confidence: LinkConfidence;
  evidence: string;
  updated_at: string;
}

const toLink = (r: LinkRow): StoredLink => ({
  registry: r.account_registry,
  account: r.account,
  package: r.package,
  relation: r.relation,
  source: r.source,
  confidence: r.confidence,
  evidence: r.evidence,
  updatedAt: r.updated_at,
});

/** Every link of one account (all packages it can publish that the index knows). */
export function linksOfAccount(s: Store, registry: AccountRegistry, account: string): StoredLink[] {
  return all<LinkRow>(s, 'SELECT * FROM account_link WHERE account_registry = ? AND account = ? ORDER BY package, relation', registry, account).map(toLink);
}

/** Every link to any of `packages`. */
export function linksOfPackages(s: Store, packages: Iterable<string>): StoredLink[] {
  const list = [...new Set(packages)];
  const out: StoredLink[] = [];
  for (let i = 0; i < list.length; i += 500) {
    const chunk = list.slice(i, i + 500);
    out.push(...all<LinkRow>(s, `SELECT * FROM account_link WHERE package IN (${placeholders(chunk.length)}) ORDER BY package, account_registry, account, relation`, ...chunk).map(toLink));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Compromised accounts (per org)
// ---------------------------------------------------------------------------

export interface AccountIncidentRow {
  incidentId: string;
  registry: AccountRegistry;
  account: string;
  since: string | null;
  markedAt: string;
  markedBy: string;
}

/** Incident id for "account X is compromised" (fits the incident route's id rule). */
export function accountIncidentId(registry: AccountRegistry, account: string): string {
  return `ACCOUNT-${registry}-${account.replace(/[^A-Za-z0-9_-]/g, '_')}`.slice(0, 100);
}

const incidentCols = 'incident_id AS incidentId, account_registry AS registry, account, since, marked_at AS markedAt, marked_by AS markedBy';

export function accountIncidents(s: Store, orgId: string, incidentIds?: readonly string[]): AccountIncidentRow[] {
  if (incidentIds && incidentIds.length === 0) return [];
  const filter = incidentIds ? ` AND incident_id IN (${placeholders(incidentIds.length)})` : '';
  return all<AccountIncidentRow>(s, `SELECT ${incidentCols} FROM account_incident WHERE org_id = ?${filter} ORDER BY marked_at`, orgId, ...(incidentIds ?? []));
}

export function accountIncidentFor(s: Store, orgId: string, registry: AccountRegistry, account: string): AccountIncidentRow | null {
  return get<AccountIncidentRow>(s, `SELECT ${incidentCols} FROM account_incident WHERE org_id = ? AND account_registry = ? AND account = ?`, orgId, registry, account) ?? null;
}

/** Open or update the org's incident for a compromised account; writes a timeline event and an audit entry. */
export function markAccountCompromised(
  s: Store,
  orgId: string,
  input: { registry: AccountRegistry; account: string; since: string | null; exposures: number; projects: number; production: number; packages: number },
  actor: { id: string; name: string },
): { incidentId: string; created: boolean } {
  const incidentId = accountIncidentId(input.registry, input.account);
  return tx(s, () => {
    const at = nowIso(s);
    const prev = get<{ since: string | null }>(s, 'SELECT since FROM account_incident WHERE org_id = ? AND incident_id = ?', orgId, incidentId);
    run(
      s,
      `INSERT INTO account_incident (org_id, incident_id, account_registry, account, since, marked_at, marked_by) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (org_id, incident_id) DO UPDATE SET since = excluded.since, marked_at = excluded.marked_at, marked_by = excluded.marked_by`,
      orgId,
      incidentId,
      input.registry,
      input.account,
      input.since,
      at,
      actor.id,
    );
    const window = input.since ? ` since ${input.since.slice(0, 16).replace('T', ' ')} UTC` : '';
    run(
      s,
      `INSERT INTO incident_event (org_id, advisory_id, at, actor, kind, title, detail) VALUES (?, ?, ?, ?, 'account', ?, ?)`,
      orgId,
      incidentId,
      at,
      actor.id,
      prev ? `${actor.name} updated the exposure of ${input.account}` : `${actor.name} marked ${input.account} as compromised`,
      `${input.registry} account ${input.account}${window}: ${plural(input.exposures, 'exposure')} in ${plural(input.projects, 'project')} (${input.production} in production), ${plural(input.packages, 'package')} it can publish`,
    );
    writeAudit(s, { orgId, actor: actor.id, action: 'account.compromised', target: `${input.registry}:${input.account}`, detail: { incidentId, since: input.since, exposures: input.exposures } });
    return { incidentId, created: !prev };
  });
}
