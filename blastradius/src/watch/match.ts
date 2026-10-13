/**
 * Org-wide incident mode (docs/NEXT-LEVEL.md): answer "is X anywhere?" and "which projects does
 * this new advisory hit?" from inventories already stored by earlier scans, without re-scanning.
 * Each hit carries reach in words (who brings it in, production or not).
 */
import { parsePurl, type AssetExposure, type Inventory } from '../core/types.js';
import { componentScopes, isProductionScope, type ComponentScope } from '../core/scope.js';
import { normalizePypiName } from '../ingest/python.js';
import { describeReach } from '../report/reach.js';
import { buildDependencyGraph, inboundExposure } from '../scoring/blast.js';
import { coversAllVersions, inRanges } from '../core/osv-range.js';
import { packMalware } from '../pack/load.js';
import type { KnowledgePack } from '../pack/types.js';
import type { RiskLevel } from '../core/types.js';

/** The OSV fields matching needs (OSV records and knowledge-pack entries both fit). */
export interface AdvisoryLike {
  id: string;
  published?: string;
  summary?: string;
  /** GHSA records carry their rating here ("CRITICAL", "HIGH", "MODERATE", "LOW"). */
  database_specific?: { severity?: string };
  affected?: { package?: { name?: string; ecosystem?: string }; versions?: string[]; ranges?: { events?: Record<string, string>[] }[] }[];
}

/** The advisory's own rating as a level, when it states one. */
export function advisoryLevel(adv: AdvisoryLike): RiskLevel | undefined {
  switch ((adv.database_specific?.severity ?? '').toUpperCase()) {
    case 'CRITICAL':
      return 'critical';
    case 'HIGH':
      return 'high';
    case 'MODERATE':
    case 'MEDIUM':
      return 'medium';
    case 'LOW':
      return 'low';
    default:
      return undefined;
  }
}

/** OSV ecosystem name per purl type (https://ossf.github.io/osv-schema/#affectedpackage-field). */
export const OSV_ECOSYSTEM: Readonly<Record<string, string>> = Object.freeze({ npm: 'npm', pypi: 'PyPI', githubactions: 'GitHub Actions' });

/** Name as an OSV record writes it, normalised for comparison per ecosystem. */
function osvKey(ecosystem: string, name: string): string {
  if (ecosystem === 'PyPI') return normalizePypiName(name);
  if (ecosystem === 'GitHub Actions') return name.toLowerCase();
  return name;
}

function sameOsvPackage(pkg: { name?: string; ecosystem?: string } | undefined, ecosystem: string, name: string): boolean {
  return !!pkg?.name && pkg.ecosystem === ecosystem && osvKey(ecosystem, pkg.name) === osvKey(ecosystem, name);
}

/** First "fixed" version the advisory names for this package, if any. */
export function advisoryFixedIn(adv: AdvisoryLike, name: string, ecosystem = 'npm'): string | undefined {
  for (const a of adv.affected ?? []) {
    if (!sameOsvPackage(a.package, ecosystem, name)) continue;
    for (const r of a.ranges ?? []) for (const e of r.events ?? []) if (e.fixed) return e.fixed;
  }
  return undefined;
}

export interface StoredInventory {
  projectId: string;
  projectName: string;
  scanId?: string;
  inventory: Inventory;
}

export interface ExposureHit {
  projectId: string;
  projectName: string;
  scanId?: string;
  purl: string;
  name: string;
  version: string;
  /** Present when the hit comes from an advisory. */
  advisoryId?: string;
  advisoryPublished?: string;
  /** The advisory's rating (known-bad pack entries are critical). */
  level?: RiskLevel;
  summary?: string;
  /** First fixed version the advisory names. */
  fixedIn?: string;
  assets: AssetExposure[];
  /** True only when the package's one scope in this project is runtime (src/core/scope.ts). */
  production: boolean;
  /** The package's one scope in this project (absent on hits built without an inventory). */
  scope?: ComponentScope;
  /** purl type: npm, pypi, githubactions, docker, ... */
  ecosystem?: string;
  reachText: string;
}

const allVersions = (a: NonNullable<AdvisoryLike['affected']>[number]): boolean => coversAllVersions(a.ranges ?? []);

/** True when the advisory names this package version (explicit version, or every version). */
export function advisoryAffects(adv: AdvisoryLike, name: string, version: string | undefined, ecosystem = 'npm'): boolean {
  return (adv.affected ?? []).some(
    (a) =>
      sameOsvPackage(a.package, ecosystem, name) &&
      (allVersions(a) || (version !== undefined && ((a.versions ?? []).includes(version) || ((a.versions ?? []).length === 0 && inRanges(version, a.ranges ?? []))))),
  );
}

/**
 * Display name, version and type of any purl in an inventory: npm "@scope/name", PyPI
 * "requests", GitHub Actions "owner/repo" (plus "/path" for a sub-path action), Docker
 * "library/node".
 */
export function purlIdentity(purl: string): { type: string; name: string; version: string; subpath?: string } | null {
  try {
    const p = parsePurl(purl);
    const name = p.namespace ? `${p.namespace}/${p.name}` : p.name;
    return { type: p.type, name, version: p.version ?? '', ...(p.subpath ? { subpath: p.subpath } : {}) };
  } catch {
    return null;
  }
}

/** Whether a component matches a search name, with each ecosystem's own name rules. */
export function nameMatches(id: { type: string; name: string; subpath?: string }, query: string): boolean {
  const q = query.trim();
  if (!q) return false;
  switch (id.type) {
    case 'npm':
      return id.name === q.toLowerCase();
    case 'pypi':
      return normalizePypiName(id.name) === normalizePypiName(q);
    case 'githubactions': {
      const lower = q.toLowerCase();
      return id.name.toLowerCase() === lower || (id.subpath !== undefined && `${id.name}/${id.subpath}`.toLowerCase() === lower);
    }
    case 'docker': {
      const lower = q.toLowerCase();
      return id.name.toLowerCase() === lower || (id.name.toLowerCase().startsWith('library/') && id.name.slice('library/'.length).toLowerCase() === lower);
    }
    default:
      return id.name === q || id.name.toLowerCase() === q.toLowerCase();
  }
}

function hitFor(s: StoredInventory, purl: string, nv: { name: string; version: string }, ecosystem: string, g = graphFor(s), scopes = scopesFor(s)): ExposureHit {
  const inbound = inboundExposure(g, purl);
  const assetOf = (id: string) => {
    const a = g.assets.get(id);
    return a ? { name: a.name, environment: a.environment } : undefined;
  };
  const scope = scopes.get(purl) ?? 'unreachable';
  return {
    projectId: s.projectId,
    projectName: s.projectName,
    ...(s.scanId ? { scanId: s.scanId } : {}),
    purl,
    ...nv,
    assets: inbound.assets,
    // One scope rule for every view: production = a production scope (runtime, peer, optional) from a production asset.
    production: isProductionScope(scope) && inbound.assets.some((a) => isProductionScope(a.scope) && g.assets.get(a.assetId)?.environment === 'prod'),
    scope,
    ecosystem,
    reachText: describeReach({ blastRadius: { assets: inbound.assets, score: 0 } }, assetOf),
  };
}

const graphs = new WeakMap<Inventory, ReturnType<typeof buildDependencyGraph>>();
const scopeMaps = new WeakMap<Inventory, Map<string, ComponentScope>>();
function graphFor(s: StoredInventory): ReturnType<typeof buildDependencyGraph> {
  let g = graphs.get(s.inventory);
  if (!g) graphs.set(s.inventory, (g = buildDependencyGraph(s.inventory)));
  return g;
}
function scopesFor(s: StoredInventory): Map<string, ComponentScope> {
  let m = scopeMaps.get(s.inventory);
  if (!m) scopeMaps.set(s.inventory, (m = componentScopes(s.inventory)));
  return m;
}

const byProjectThenPurl = (a: ExposureHit, b: ExposureHit) => a.projectName.localeCompare(b.projectName) || a.purl.localeCompare(b.purl) || (a.advisoryId ?? '').localeCompare(b.advisoryId ?? '');

/**
 * Projects whose stored inventory contains the package (optionally at `version`), for every purl
 * type in the inventory. `name` is a package name ("debug", "@babel/core", "requests",
 * "actions/checkout", "library/node") or a full purl ("pkg:pypi/paramiko@3.5.1").
 */
export function searchExposure(inventories: readonly StoredInventory[], query: { name: string; version?: string; type?: string }): ExposureHit[] {
  let q = query;
  if (query.name.startsWith('pkg:')) {
    const id = purlIdentity(query.name);
    if (!id) return [];
    q = { name: id.subpath ? `${id.name}/${id.subpath}` : id.name, type: id.type, ...(id.version ? { version: id.version } : query.version !== undefined ? { version: query.version } : {}) };
  }
  const hits: ExposureHit[] = [];
  for (const s of inventories) {
    for (const c of s.inventory.components) {
      const id = purlIdentity(c.purl);
      if (!id || (q.type !== undefined && id.type !== q.type) || !nameMatches(id, q.name)) continue;
      if (q.version !== undefined && id.version !== q.version) continue;
      hits.push(hitFor(s, c.purl, { name: id.name, version: id.version }, id.type));
    }
  }
  return hits.sort(byProjectThenPurl);
}

/** Every (project, component, advisory) the advisories hit, from stored inventories only. */
export function matchAdvisories(inventories: readonly StoredInventory[], advisories: readonly AdvisoryLike[]): ExposureHit[] {
  const byName = new Map<string, AdvisoryLike[]>();
  for (const a of advisories)
    for (const x of a.affected ?? []) {
      const eco = x.package?.ecosystem;
      if (!eco || !x.package?.name || !Object.values(OSV_ECOSYSTEM).includes(eco)) continue;
      const key = `${eco}\u0000${osvKey(eco, x.package.name)}`;
      const list = byName.get(key) ?? byName.set(key, []).get(key)!;
      if (!list.includes(a)) list.push(a);
    }
  const hits: ExposureHit[] = [];
  for (const s of inventories) {
    const seen = new Set<string>();
    for (const c of s.inventory.components) {
      const id = purlIdentity(c.purl);
      const eco = id ? OSV_ECOSYSTEM[id.type] : undefined;
      if (!id || !eco) continue;
      const nv = { name: id.name, version: id.version };
      for (const adv of byName.get(`${eco}\u0000${osvKey(eco, id.name)}`) ?? []) {
        const key = `${c.purl}\u0000${adv.id}`;
        if (seen.has(key) || !advisoryAffects(adv, nv.name, nv.version, eco)) continue;
        seen.add(key);
        const level = advisoryLevel(adv);
        const fixedIn = advisoryFixedIn(adv, nv.name, eco);
        hits.push({
          ...hitFor(s, c.purl, nv, id.type),
          advisoryId: adv.id,
          ...(adv.published ? { advisoryPublished: adv.published } : {}),
          ...(level ? { level } : {}),
          ...(adv.summary ? { summary: adv.summary } : {}),
          ...(fixedIn ? { fixedIn } : {}),
        });
      }
    }
  }
  return hits.sort(byProjectThenPurl);
}

/** Hits from the knowledge pack's known-bad list (whole-package malware and bad releases). */
export function matchPack(inventories: readonly StoredInventory[], pack: KnowledgePack): ExposureHit[] {
  const hits: ExposureHit[] = [];
  for (const s of inventories) {
    const seen = new Set<string>();
    for (const c of s.inventory.components) {
      const id = purlIdentity(c.purl);
      if (!id || id.type !== 'npm') continue; // the knowledge pack lists npm packages
      const nv = { name: id.name, version: id.version };
      for (const ref of packMalware(pack, nv.name, nv.version)) {
        const key = `${c.purl}\u0000${ref.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // Known-bad releases (malware) are critical by definition.
        hits.push({ ...hitFor(s, c.purl, nv, 'npm'), advisoryId: ref.id, level: 'critical', ...(ref.published ? { advisoryPublished: ref.published } : {}) });
      }
    }
  }
  return hits.sort(byProjectThenPurl);
}
