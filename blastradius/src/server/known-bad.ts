/**
 * Known-bad versions for the web app (account pivot, package pages): hand-curated KB incidents
 * (kb/incidents, the same files the CLI scores with) and OSV malware advisories (MAL-*) the
 * account indexer stored per package (registry_advisory). Both are public records about package
 * versions, never judgements about people.
 */
import { fileURLToPath } from 'node:url';
import type { Incident } from '../core/types.js';
import type { HttpClient } from '../core/http.js';
import { loadIncidentsSync } from '../incidents/loader.js';
import type { MalwareAdvisory, StoredAdvisories } from './store/index.js';

/** Bundled KB (src/server → ../../kb/incidents; dist/server likewise). */
export const BUNDLED_KB_DIR = fileURLToPath(new URL('../../kb/incidents', import.meta.url));

let kbCache: { dir: string; incidents: Incident[] } | null = null;

/** KB incidents, loaded once per process. Bad files are skipped (the CLI's `kb validate` reports them). */
export function kbIncidents(dir: string = process.env.BLASTRADIUS_KB_DIR || BUNDLED_KB_DIR): Incident[] {
  if (kbCache?.dir !== dir) kbCache = { dir, incidents: loadIncidentsSync(dir).incidents };
  return kbCache.incidents;
}

export interface KnownBadEntry {
  /** "INC-2025-0002" (KB) or "MAL-2025-46971" (OSV). */
  id: string;
  source: 'kb' | 'osv';
  title: string;
  /** YYYY-MM-DD. */
  date: string | null;
  /** Exact bad versions of this package ("*" = every version). */
  versions: string[];
  /** Other ids for the same record (GHSA, CVE, the OSV id of a KB incident). */
  aliases: string[];
  evidence: string[];
}

const npmPurlOf = (name: string): string => `pkg:npm/${name.startsWith('@') ? `%40${name.slice(1)}` : name}`;

/**
 * Known-bad entries for one npm package: KB incidents listing it, then OSV malware advisories. An
 * OSV record that is an alias of nothing in the KB stays its own entry; one whose versions the KB
 * already lists is folded into the KB entry's aliases.
 */
export function knownBadFor(name: string, advisories: StoredAdvisories | undefined, incidents: readonly Incident[] = kbIncidents()): KnownBadEntry[] {
  const purl = npmPurlOf(name);
  const out: KnownBadEntry[] = [];
  for (const inc of incidents) {
    const a = inc.affected.find((x) => x.purl === purl);
    if (!a) continue;
    out.push({ id: inc.id, source: 'kb', title: inc.title, date: inc.date, versions: [...a.versions], aliases: [], evidence: [...inc.evidence] });
  }
  for (const m of advisories?.malware ?? []) {
    const kb = out.find((e) => e.source === 'kb' && m.versions.length > 0 && m.versions.every((v) => e.versions.includes(v)));
    if (kb) {
      for (const id of [m.id, ...m.aliases]) if (!kb.aliases.includes(id)) kb.aliases.push(id);
      if (!kb.evidence.includes(m.url)) kb.evidence.push(m.url);
      continue;
    }
    out.push({ id: m.id, source: 'osv', title: m.summary || `${name} listed in OSV advisory ${m.id}`, date: m.published?.slice(0, 10) ?? null, versions: m.versions.length ? [...m.versions] : ['*'], aliases: [...m.aliases], evidence: [m.url] });
  }
  return out;
}

/** The known-bad entries naming this exact version. */
export function badVersion(entries: readonly KnownBadEntry[], version: string): KnownBadEntry[] {
  return entries.filter((e) => e.versions.includes(version) || e.versions.includes('*'));
}

const MAL_ID = /^MAL-\d{4}-\d+$/;
const OSV_QUERY = 'https://api.osv.dev/v1/query';

interface OsvVuln {
  id?: unknown;
  aliases?: unknown;
  summary?: unknown;
  published?: unknown;
  affected?: { package?: { name?: unknown; ecosystem?: unknown }; versions?: unknown }[];
}

/** Parse an OSV /v1/query answer into the package's malware advisories (MAL-* ids, or records aliased to one). */
export function malwareFromOsv(name: string, body: { vulns?: OsvVuln[] } | null): MalwareAdvisory[] {
  const out = new Map<string, MalwareAdvisory>();
  for (const v of body?.vulns ?? []) {
    if (typeof v.id !== 'string') continue;
    const aliases = Array.isArray(v.aliases) ? v.aliases.filter((a): a is string => typeof a === 'string') : [];
    const malId = MAL_ID.test(v.id) ? v.id : aliases.find((a) => MAL_ID.test(a));
    if (!malId) continue;
    const versions = new Set<string>();
    for (const a of v.affected ?? []) {
      if (a.package?.name !== name || a.package?.ecosystem !== 'npm') continue;
      if (Array.isArray(a.versions)) for (const x of a.versions) if (typeof x === 'string') versions.add(x);
    }
    const prev = out.get(malId);
    if (prev) {
      for (const x of versions) if (!prev.versions.includes(x)) prev.versions.push(x);
      for (const x of [v.id, ...aliases]) if (x !== malId && !prev.aliases.includes(x)) prev.aliases.push(x);
      if (v.id === malId && typeof v.summary === 'string') prev.summary = v.summary.slice(0, 300);
      continue;
    }
    out.set(malId, {
      id: malId,
      aliases: [...new Set([v.id, ...aliases])].filter((x) => x !== malId).sort(),
      summary: typeof v.summary === 'string' ? v.summary.slice(0, 300) : '',
      versions: [...versions],
      published: typeof v.published === 'string' ? v.published : null,
      url: `https://osv.dev/vulnerability/${malId}`,
    });
  }
  return [...out.values()].map((m) => ({ ...m, versions: m.versions.sort() })).sort((a, b) => a.id.localeCompare(b.id));
}

/** OSV malware advisories of one npm package (every version). Throws on transport errors. */
export async function fetchMalwareAdvisories(http: HttpClient, name: string): Promise<MalwareAdvisory[]> {
  const body = await http.fetchJson<{ vulns?: OsvVuln[] }>(OSV_QUERY, { method: 'POST', body: { package: { name, ecosystem: 'npm' } } });
  return malwareFromOsv(name, body);
}
