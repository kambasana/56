/**
 * Account index from registry data (docs/ACCOUNT-PROOF.md, H1/H3). Pure: no I/O.
 *
 * - indexFromPackument(): one npm packument → who can publish the package (current maintainers),
 *   who published each version (_npmUser) with that version's maintainers, and the repository
 *   owner. Deleted versions keep their publish time (`time`) but lose their manifest; they are
 *   kept as `gone` so "can publish at T" and the sole-maintainer attribution match the proof.
 * - encodeVersions()/decodeVersions(): the compact stored form (each maintainer list once).
 * - parseUserPackages(): npm's /-/user/<name>/package listing (package → "write" | "read").
 *
 * Everything read here is untrusted registry data: bounded, type-checked, never evaluated.
 */
import type { Packument } from '../enrich/npm/types.js';
import { isObject, isValidNpmName, NPM_REGISTRY } from '../enrich/npm/registry.js';
import { parseMaintainers } from '../enrich/npm/packument.js';
import { repoFromManifestField } from '../enrich/npm/repo.js';
import type { PackageTimeline, VersionEntry } from '../watch/account.js';

const MAX_VERSIONS = 20_000;
const HANDLE_MAX = 214;

/** npm account names: lower-case URL-safe, but publishers like "GitHub Actions" carry spaces. */
export function isAccountName(name: string): boolean {
  return name.length > 0 && name.length <= HANDLE_MAX && !/[\u0000-\u001f/\\?#%]/.test(name) && name.trim() === name;
}

export interface RepoOwner {
  host: 'github' | 'gitlab';
  owner: string;
  url: string;
}

export interface IndexedPackage {
  name: string;
  /** Packument top-level `maintainers` (who can publish now). */
  maintainers: string[];
  repo: RepoOwner | null;
  /** Oldest first. */
  versions: VersionEntry[];
}

const str = (v: unknown, max = HANDLE_MAX): string | undefined => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined);

/** Packument → index entry. `name` is the requested name (the packument's own is not trusted). */
export function indexFromPackument(p: Packument, name: string): IndexedPackage {
  const versions = isObject(p.versions) ? p.versions : {};
  const time = isObject(p.time) ? p.time : {};
  const out: VersionEntry[] = [];
  for (const [v, t] of Object.entries(time).slice(0, MAX_VERSIONS + 3)) {
    if (v === 'created' || v === 'modified' || v === 'unpublished' || v.length > 100) continue;
    const ts = str(t, 40);
    if (!ts || !Number.isFinite(Date.parse(ts))) continue;
    const m = Object.hasOwn(versions, v) ? versions[v] : undefined;
    if (!isObject(m)) {
      out.push({ v, t: ts, gone: true });
      continue;
    }
    const e: VersionEntry = { v, t: ts };
    const u = isObject(m._npmUser) ? str(m._npmUser.name) : undefined;
    if (u) e.u = u;
    const maint = parseMaintainers(m.maintainers)?.map((x) => x.name);
    if (maint && maint.length > 0) e.m = maint;
    out.push(e);
  }
  out.sort((a, b) => Date.parse(a.t) - Date.parse(b.t) || (a.v < b.v ? -1 : a.v > b.v ? 1 : 0));
  const latest = isObject(p['dist-tags']) ? str(p['dist-tags'].latest, 100) : undefined;
  const latestManifest = latest && Object.hasOwn(versions, latest) ? versions[latest] : undefined;
  const repoField = p.repository ?? (isObject(latestManifest) ? latestManifest.repository : undefined);
  const parsed = repoFromManifestField(repoField);
  const repo: RepoOwner | null =
    parsed && (parsed.host === 'github' || parsed.host === 'gitlab') && parsed.owner ? { host: parsed.host, owner: parsed.owner, url: `https://${parsed.host}.com/${parsed.owner}` } : null;
  return { name, maintainers: (parseMaintainers(p.maintainers) ?? []).map((m) => m.name), repo, versions: out };
}

export interface EncodedVersions {
  sets: string[][];
  /** [version, time, publisher ('' = unknown), maintainer set index (-1 = none), gone (0|1)] */
  v: [string, string, string, number, 0 | 1][];
}

export function encodeVersions(vs: readonly VersionEntry[]): EncodedVersions {
  const sets: string[][] = [];
  const index = new Map<string, number>();
  const ref = (m: string[] | undefined) => {
    if (!m) return -1;
    const k = JSON.stringify(m);
    let i = index.get(k);
    if (i === undefined) {
      i = sets.length;
      sets.push(m);
      index.set(k, i);
    }
    return i;
  };
  return { sets, v: vs.map((e) => [e.v, e.t, e.u ?? '', ref(e.m), e.gone ? 1 : 0]) };
}

export function decodeVersions(enc: EncodedVersions): VersionEntry[] {
  return enc.v.map(([v, t, u, mi, gone]) => ({ v, t, ...(u ? { u } : {}), ...(mi >= 0 && enc.sets[mi] ? { m: enc.sets[mi] } : {}), ...(gone ? { gone: true as const } : {}) }));
}

export function toTimeline(p: Pick<IndexedPackage, 'name' | 'versions'>): PackageTimeline {
  return { name: p.name, versions: p.versions };
}

/** https://registry.npmjs.org/-/user/<name>/package */
export function userPackagesUrl(account: string, registry: string = NPM_REGISTRY): string {
  if (!isAccountName(account)) throw new Error('Invalid account name');
  return `${registry.replace(/\/+$/, '')}/-/user/${encodeURIComponent(account)}/package`;
}

/** Package names the account can write to, from the listing (sorted, valid names only). */
export function parseUserPackages(data: unknown, max = 10_000): string[] {
  if (!isObject(data)) return [];
  return Object.entries(data)
    .filter(([n, access]) => access === 'write' && isValidNpmName(n))
    .map(([n]) => n)
    .slice(0, max)
    .sort();
}

export function npmProfileUrl(account: string): string {
  return `https://www.npmjs.com/~${encodeURIComponent(account)}`;
}
