/**
 * Build a knowledge pack from already-downloaded sources (no network here, so it is testable):
 * - OSV npm export records (MAL-*), read from a directory of OSV JSON files;
 * - tstromberg/supplychain-attack-data meta.yaml files (Apache-2.0).
 * Only permissive data is kept, and only what scanning needs (names, versions, ids, dates).
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { coversAllVersions, type OsvRange } from '../core/osv-range.js';
import { PACK_SCHEMA, type KnowledgePack, type PackIncident, type PackMalwareRef, type PackSource } from './types.js';

export interface OsvRecord {
  id?: unknown;
  published?: unknown;
  aliases?: unknown;
  withdrawn?: unknown;
  database_specific?: { cwe_ids?: unknown };
  affected?: { package?: { name?: unknown; ecosystem?: unknown }; versions?: unknown; ranges?: { events?: Record<string, unknown>[] }[] }[];
}

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length < 300;

/**
 * OSV MAL-* records, plus GitHub advisories tagged CWE-506 (embedded malicious code). The classic
 * compromises of legitimate packages (event-stream, ua-parser-js, colors, node-ipc) exist only as
 * the latter, not as MAL-* records.
 */
export function isMalwareAdvisory(rec: OsvRecord): boolean {
  if (!str(rec.id)) return false;
  if (rec.id.startsWith('MAL-')) return true;
  const cwes = rec.database_specific?.cwe_ids;
  return rec.id.startsWith('GHSA-') && Array.isArray(cwes) && cwes.includes('CWE-506');
}

function addRef(list: PackMalwareRef[], ref: PackMalwareRef): void {
  if (!list.some((r) => r.id === ref.id)) list.push(ref);
}

export function addOsvRecord(pack: KnowledgePack['malware'], rec: OsvRecord, ecosystem = 'npm'): boolean {
  if (!str(rec.id) || rec.withdrawn || !isMalwareAdvisory(rec)) return false;
  const ref: PackMalwareRef = { id: rec.id };
  const aliases = Array.isArray(rec.aliases) ? rec.aliases.filter(str) : [];
  if (aliases.length) ref.aliases = aliases;
  if (str(rec.published) && !Number.isNaN(Date.parse(rec.published))) ref.published = new Date(rec.published).toISOString();
  let used = false;
  for (const a of rec.affected ?? []) {
    const name = a.package?.name;
    if (!str(name) || a.package?.ecosystem !== ecosystem) continue;
    const versions = Array.isArray(a.versions) ? a.versions.filter(str) : [];
    const ranges = Array.isArray(a.ranges) ? a.ranges : [];
    if (coversAllVersions(ranges as OsvRange[]) || (versions.length === 0 && ranges.length === 0)) {
      addRef((pack.packages[name] ??= []), ref);
    } else if (versions.length === 0) {
      // Range only (e.g. fsevents >=1.0.0 <1.2.11): keep the range, never "every version".
      const list = (pack.ranges[name] ??= []);
      if (!list.some((x) => x.ref.id === ref.id)) list.push({ ref, ranges: ranges.map((r) => ({ events: (r.events ?? []).map((e) => Object.fromEntries(Object.entries(e).filter(([, v]) => typeof v === 'string'))) as Record<string, string>[] })) });
    } else {
      const byVersion = (pack.versions[name] ??= {});
      for (const v of versions) addRef((byVersion[v] ??= []), ref);
    }
    used = true;
  }
  return used;
}

export async function readOsvDir(dir: string, malware: KnowledgePack['malware']): Promise<number> {
  let n = 0;
  for (const f of (await readdir(dir)).sort()) {
    if (!(f.startsWith('MAL-') || f.startsWith('GHSA-')) || !f.endsWith('.json')) continue;
    try {
      if (addOsvRecord(malware, JSON.parse(await readFile(join(dir, f), 'utf8')) as OsvRecord)) n++;
    } catch {
      // A broken record is skipped, never fatal: the export has 200k+ files.
    }
  }
  return n;
}

const date = (v: unknown): string | null => (v instanceof Date ? v.toISOString().slice(0, 10) : str(v) ? v.slice(0, 10) : null);

/** Parse one supplychain-attack-data meta.yaml into npm incidents (other ecosystems are skipped). */
export function parseAttackMeta(text: string, repoUrl: string, dirName: string): PackIncident[] {
  const doc = parseYaml(text) as unknown;
  const entries = Array.isArray(doc) ? doc : [doc];
  const out: PackIncident[] = [];
  for (const e of entries as Record<string, any>[]) {
    if (!e || !str(e.id)) continue;
    const packages = new Map<string, Set<string>>();
    for (const a of Array.isArray(e.artifacts) ? e.artifacts : []) {
      if (a?.ecosystem !== 'npm') continue;
      const name = str(a.package) ? a.package : str(a.name) ? a.name : null;
      if (!name) continue;
      const set = packages.get(name) ?? new Set<string>();
      for (const v of Array.isArray(a.versions) ? a.versions : []) if (str(v) || typeof v === 'number') set.add(String(v));
      packages.set(name, set);
    }
    if (packages.size === 0) continue;
    const target = e.target && str(e.target.name) ? { name: e.target.name, kind: str(e.target.kind) ? e.target.kind : 'unknown' } : null;
    out.push({
      id: e.id,
      title: str(e.title) ? e.title : e.id,
      cause: str(e.method?.cause) ? e.method.cause : null,
      startDate: date(e.start_date),
      endDate: date(e.end_date),
      target,
      packages: [...packages].map(([name, vs]) => ({ name, versions: [...vs].sort() })).sort((x, y) => x.name.localeCompare(y.name)),
      source: `${repoUrl}/tree/main/oss/attacks/${encodeURIComponent(dirName)}`,
      status: 'alleged',
    });
  }
  return out;
}

export async function readAttackData(root: string, repoUrl: string): Promise<PackIncident[]> {
  const base = join(root, 'oss', 'attacks');
  const out: PackIncident[] = [];
  for (const d of (await readdir(base)).sort()) {
    try {
      out.push(...parseAttackMeta(await readFile(join(base, d, 'meta.yaml'), 'utf8'), repoUrl, d));
    } catch {
      // missing or malformed meta.yaml: skip this attack
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function emptyPack(builtAt: string): KnowledgePack {
  return {
    schema: PACK_SCHEMA,
    builtAt,
    sources: [],
    malware: { packages: {}, versions: {}, ranges: {} },
    incidents: [],
    counts: { malwarePackages: 0, compromisedPackages: 0, compromisedVersions: 0, rangeAdvisories: 0, incidents: 0 },
  };
}

export function finishPack(pack: KnowledgePack, sources: PackSource[]): KnowledgePack {
  // Stable output: sorted keys, so the same inputs give the same bytes (and SHA-256).
  const sortObj = <T>(o: Record<string, T>): Record<string, T> => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]!]));
  pack.malware.packages = sortObj(pack.malware.packages);
  pack.malware.versions = sortObj(Object.fromEntries(Object.entries(pack.malware.versions).map(([k, v]) => [k, sortObj(v)])));
  pack.malware.ranges = sortObj(pack.malware.ranges);
  pack.sources = sources;
  pack.counts = {
    malwarePackages: Object.keys(pack.malware.packages).length,
    compromisedPackages: Object.keys(pack.malware.versions).length,
    compromisedVersions: Object.values(pack.malware.versions).reduce((n, v) => n + Object.keys(v).length, 0),
    rangeAdvisories: Object.values(pack.malware.ranges).reduce((n, v) => n + v.length, 0),
    incidents: pack.incidents.length,
  };
  return pack;
}
