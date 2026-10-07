/**
 * Org-wide incident mode (docs/NEXT-LEVEL.md): answer "is X anywhere?" and "which projects does
 * this new advisory hit?" from inventories already stored by earlier scans, without re-scanning.
 * Each hit carries reach in words (who brings it in, production or not).
 */
import { parsePurl, type AssetExposure, type Inventory } from '../core/types.js';
import { describeReach } from '../report/reach.js';
import { buildDependencyGraph, inboundExposure } from '../scoring/blast.js';
import { coversAllVersions, inRanges } from '../core/osv-range.js';
import { packMalware } from '../pack/load.js';
import type { KnowledgePack } from '../pack/types.js';

/** The OSV fields matching needs (OSV records and knowledge-pack entries both fit). */
export interface AdvisoryLike {
  id: string;
  published?: string;
  summary?: string;
  affected?: { package?: { name?: string; ecosystem?: string }; versions?: string[]; ranges?: { events?: Record<string, string>[] }[] }[];
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
  assets: AssetExposure[];
  production: boolean;
  reachText: string;
}

const allVersions = (a: NonNullable<AdvisoryLike['affected']>[number]): boolean => coversAllVersions(a.ranges ?? []);

/** True when the advisory names this npm package version (explicit version, or every version). */
export function advisoryAffects(adv: AdvisoryLike, name: string, version: string | undefined): boolean {
  return (adv.affected ?? []).some(
    (a) =>
      a.package?.ecosystem === 'npm' &&
      a.package.name === name &&
      (allVersions(a) || (version !== undefined && ((a.versions ?? []).includes(version) || ((a.versions ?? []).length === 0 && inRanges(version, a.ranges ?? []))))),
  );
}

function npmName(purl: string): { name: string; version: string } | null {
  try {
    const p = parsePurl(purl);
    if (p.type !== 'npm') return null;
    return { name: p.namespace ? `${p.namespace}/${p.name}` : p.name, version: p.version ?? '' };
  } catch {
    return null;
  }
}

function hitFor(s: StoredInventory, purl: string, nv: { name: string; version: string }): ExposureHit {
  const g = buildDependencyGraph(s.inventory);
  const inbound = inboundExposure(g, purl);
  const assetOf = (id: string) => {
    const a = g.assets.get(id);
    return a ? { name: a.name, environment: a.environment } : undefined;
  };
  return {
    projectId: s.projectId,
    projectName: s.projectName,
    ...(s.scanId ? { scanId: s.scanId } : {}),
    purl,
    ...nv,
    assets: inbound.assets,
    // Production: a production asset reaches it through a non-dev path (dev/optional paths score < 0.5).
    production: inbound.assets.some((a) => g.assets.get(a.assetId)?.environment === 'prod' && a.exposure >= 0.5),
    reachText: describeReach({ blastRadius: { assets: inbound.assets, score: 0 } }, assetOf),
  };
}

const byProjectThenPurl = (a: ExposureHit, b: ExposureHit) => a.projectName.localeCompare(b.projectName) || a.purl.localeCompare(b.purl) || (a.advisoryId ?? '').localeCompare(b.advisoryId ?? '');

/** Projects whose stored inventory contains `name` (optionally at `version`). */
export function searchExposure(inventories: readonly StoredInventory[], query: { name: string; version?: string }): ExposureHit[] {
  const hits: ExposureHit[] = [];
  for (const s of inventories) {
    for (const c of s.inventory.components) {
      const nv = npmName(c.purl);
      if (!nv || nv.name !== query.name || (query.version !== undefined && nv.version !== query.version)) continue;
      hits.push(hitFor(s, c.purl, nv));
    }
  }
  return hits.sort(byProjectThenPurl);
}

/** Every (project, component, advisory) the advisories hit, from stored inventories only. */
export function matchAdvisories(inventories: readonly StoredInventory[], advisories: readonly AdvisoryLike[]): ExposureHit[] {
  const byName = new Map<string, AdvisoryLike[]>();
  for (const a of advisories) for (const x of a.affected ?? []) if (x.package?.ecosystem === 'npm' && x.package.name) (byName.get(x.package.name) ?? byName.set(x.package.name, []).get(x.package.name)!).push(a);
  const hits: ExposureHit[] = [];
  for (const s of inventories) {
    const seen = new Set<string>();
    for (const c of s.inventory.components) {
      const nv = npmName(c.purl);
      if (!nv) continue;
      for (const adv of byName.get(nv.name) ?? []) {
        const key = `${c.purl}\u0000${adv.id}`;
        if (seen.has(key) || !advisoryAffects(adv, nv.name, nv.version)) continue;
        seen.add(key);
        hits.push({ ...hitFor(s, c.purl, nv), advisoryId: adv.id, ...(adv.published ? { advisoryPublished: adv.published } : {}) });
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
      const nv = npmName(c.purl);
      if (!nv) continue;
      for (const ref of packMalware(pack, nv.name, nv.version)) {
        const key = `${c.purl}\u0000${ref.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push({ ...hitFor(s, c.purl, nv), advisoryId: ref.id, ...(ref.published ? { advisoryPublished: ref.published } : {}) });
      }
    }
  }
  return hits.sort(byProjectThenPurl);
}
