/**
 * Compile the match index (pack v2 shape) from the raw store (docs/FEEDS-AND-DETECTORS.md §2.2).
 *
 * Precedence: KB curated (0) > GitHub reviewed (1) > OSV MAL-* and unreviewed GHSA (2) > dataset
 * manifests (3). Range-only advisories stay ranges (pack builders are reused for OSV records).
 * Contradictions: an "every version" claim is kept out of the index and flagged when a
 * higher-precedence source names only specific versions or ranges for that package (and no
 * higher source also says "every version"). Dataset entries are added only where nothing ranked
 * above them already covers the package or version (otherwise counted as corroborating), so they
 * fill gaps without doubling alerts. BKC names become labels and never match.
 *
 * The result depends only on the store contents, the KB and the ecosystem: the same inputs give
 * the same bytes. builtAt is the newest source timestamp, not the wall clock.
 */
import { createHash } from 'node:crypto';
import { inRanges } from '../core/osv-range.js';
import { parsePurl, type Incident } from '../core/types.js';
import { addOsvRecord, emptyPack, finishPack, type OsvRecord } from '../pack/build.js';
import type { KnowledgePack, PackConflict, PackMalwareRef, PackSource } from '../pack/types.js';
import { bkcSource, datadogSource } from './datasets.js';
import { osvSource } from './osv.js';
import type { FeedStore } from './store.js';

type RangeList = KnowledgePack['malware']['ranges'][string][number]['ranges'];

interface Claim {
  name: string;
  rank: number;
  ref: PackMalwareRef;
  kind: 'all' | 'versions' | 'ranges';
  versions?: string[];
  ranges?: RangeList;
}

export const RANK = { kb: 0, githubReviewed: 1, osv: 2, dataset: 3 } as const;

export interface CompileStats {
  records: { osv: number; kb: number; datadog: number; bkc: number };
  conflicts: number;
  /** Dataset entries already covered by a higher-precedence source. */
  corroborated: number;
  /** Dataset entries that added coverage nothing else had. */
  datasetOnly: number;
  labels: number;
}

export interface CompileResult {
  pack: KnowledgePack;
  stats: CompileStats;
  /** Newest `modified` of an OSV record in the index (freshness). */
  newestModified: string | null;
}

/** "pkg:npm/%40scope/name" → "@scope/name" for the given purl type; null otherwise. */
function purlName(purl: string, type: string): string | null {
  try {
    const p = parsePurl(purl);
    if (p.type !== type) return null;
    return p.namespace ? `${p.namespace}/${p.name}` : p.name;
  } catch {
    return null;
  }
}

/** Short content hash of the KB (its snapshot id in NOTICE). */
export function kbSnapshot(incidents: readonly Incident[]): string {
  return createHash('sha256').update(JSON.stringify(incidents)).digest('hex').slice(0, 12);
}

function kbClaims(incidents: readonly Incident[], eco: string): Claim[] {
  const out: Claim[] = [];
  for (const inc of incidents) {
    if (inc.status !== 'confirmed' && inc.status !== 'alleged') continue;
    const ref: PackMalwareRef = { id: inc.id, published: `${inc.date}T00:00:00.000Z`, source: 'kb' };
    if (inc.evidence[0]) ref.url = inc.evidence[0];
    for (const a of inc.affected) {
      const name = purlName(a.purl, eco.toLowerCase());
      if (!name) continue;
      if (a.versions.includes('*')) out.push({ name, rank: RANK.kb, ref, kind: 'all' });
      else out.push({ name, rank: RANK.kb, ref, kind: 'versions', versions: [...a.versions] });
    }
  }
  return out;
}

/** ">= 0.0.0" and never closed (GHSA writes "every version" this way): the same as introduced "0". */
function openFromZero(ranges: RangeList): boolean {
  return ranges.length > 0 && ranges.every((r) => (r.events ?? []).length === 1 && r.events![0]!.introduced === '0.0.0');
}

function osvClaims(store: FeedStore, eco: string): { claims: Claim[]; records: number; newest: string | null } {
  const claims: Claim[] = [];
  let records = 0;
  let newest: string | null = null;
  for (const row of store.relevant(osvSource(eco))) {
    const rec = JSON.parse(row.json) as OsvRecord & { database_specific?: { github_reviewed?: unknown } };
    const scratch: KnowledgePack['malware'] = { packages: {}, versions: {}, ranges: {} };
    if (!addOsvRecord(scratch, rec, eco)) continue;
    records++;
    if (!newest || row.modified > newest) newest = row.modified;
    const rank = row.id.startsWith('GHSA-') && rec.database_specific?.github_reviewed === true ? RANK.githubReviewed : RANK.osv;
    for (const [name, refs] of Object.entries(scratch.packages)) claims.push({ name, rank, ref: refs[0]!, kind: 'all' });
    for (const [name, byV] of Object.entries(scratch.versions)) {
      const vs = Object.keys(byV);
      claims.push({ name, rank, ref: byV[vs[0]!]![0]!, kind: 'versions', versions: vs });
    }
    for (const [name, list] of Object.entries(scratch.ranges))
      for (const x of list) claims.push(openFromZero(x.ranges) ? { name, rank, ref: x.ref, kind: 'all' } : { name, rank, ref: x.ref, kind: 'ranges', ranges: x.ranges });
  }
  return { claims, records, newest };
}

function datadogClaims(store: FeedStore, eco: string): Claim[] {
  const out: Claim[] = [];
  for (const row of store.relevant(datadogSource(eco))) {
    const { name, versions } = JSON.parse(row.json) as { name: string; versions: string[] | null };
    const ref: PackMalwareRef = { id: `datadog:${eco.toLowerCase()}/${name}`, source: 'datadog', url: `https://github.com/DataDog/malicious-software-packages-dataset/tree/main/samples/${eco.toLowerCase()}` };
    out.push(versions === null ? { name, rank: RANK.dataset, ref, kind: 'all' } : { name, rank: RANK.dataset, ref, kind: 'versions', versions });
  }
  return out;
}

const byRankThenId = (a: { rank: number; ref: PackMalwareRef }, b: { rank: number; ref: PackMalwareRef }) => a.rank - b.rank || (a.ref.id < b.ref.id ? -1 : a.ref.id > b.ref.id ? 1 : 0);

export interface CompileOptions {
  eco: string;
  kbIncidents: readonly Incident[];
  /** Include the dataset sources that were synced (default: whatever the store holds). */
}

export function compileIndex(store: FeedStore, opts: CompileOptions): CompileResult {
  const { eco } = opts;
  const osv = osvClaims(store, eco);
  const kb = kbClaims(opts.kbIncidents, eco);
  const dd = datadogClaims(store, eco);
  const byName = new Map<string, Claim[]>();
  for (const c of [...kb, ...osv.claims, ...dd]) (byName.get(c.name) ?? byName.set(c.name, []).get(c.name)!).push(c);

  const marks = store.marks();
  const pack = emptyPack('');
  const m = pack.malware;
  const conflicts: PackConflict[] = [];
  let corroborated = 0;
  let datasetOnly = 0;

  for (const name of [...byName.keys()].sort()) {
    const claims = byName.get(name)!.sort(byRankThenId);
    const contradicted = (c: Claim): string[] | null => {
      if (c.kind !== 'all' || claims.some((x) => x.kind === 'all' && x.rank < c.rank)) return null;
      const higher = claims.filter((x) => x.kind !== 'all' && x.rank < c.rank).map((x) => x.ref.id);
      return higher.length ? [...new Set(higher)].sort() : null;
    };
    const accepted: Claim[] = [];
    for (const c of claims) {
      const against = contradicted(c);
      if (against) {
        conflicts.push({ name, ref: c.ref, claim: 'every-version', contradictedBy: against });
        continue;
      }
      if (c.rank === RANK.dataset) {
        // Fill gaps only: skip what a higher source already covers.
        const covers = (v: string | null) =>
          accepted.some((a) => a.rank < RANK.dataset && (a.kind === 'all' || (v !== null && (a.kind === 'versions' ? a.versions!.includes(v) : inRanges(v, a.ranges!)))));
        if (c.kind === 'all') {
          if (covers(null)) {
            corroborated++;
            continue;
          }
        } else {
          const left = c.versions!.filter((v) => !covers(v));
          corroborated += c.versions!.length - left.length;
          if (!left.length) continue;
          c.versions = left;
        }
        datasetOnly++;
      }
      accepted.push(c);
    }
    for (const c of accepted) {
      if (c.kind === 'all') {
        const list = (m.packages[name] ??= []);
        if (!list.some((r) => r.id === c.ref.id)) list.push(c.ref);
      } else if (c.kind === 'versions') {
        const byV = (m.versions[name] ??= {});
        for (const v of c.versions!) {
          const list = (byV[v] ??= []);
          if (!list.some((r) => r.id === c.ref.id)) list.push(c.ref);
        }
      } else {
        const list = (m.ranges[name] ??= []);
        if (!list.some((x) => x.ref.id === c.ref.id)) list.push({ ref: c.ref, ranges: c.ranges! });
      }
    }
  }

  const labels: Record<string, string[]> = {};
  let bkc = 0;
  for (const row of store.relevant(bkcSource(eco))) {
    labels[(JSON.parse(row.json) as { name: string }).name] = ['bkc'];
    bkc++;
  }

  const ddMark = marks[datadogSource(eco)]?.split(' ');
  const bkcMark = marks[bkcSource(eco)]?.split(' ');
  const osvMark = marks[osvSource(eco)] ?? null;
  const sources: PackSource[] = [];
  if (osvMark)
    sources.push({
      name: `OSV ${eco} (OpenSSF malicious-packages MAL-*, GitHub advisories tagged CWE-506)`,
      url: `https://osv-vulnerabilities.storage.googleapis.com/${eco}/`,
      licence: 'CC-BY-4.0 (OSV); per record: Apache-2.0 (OpenSSF malicious-packages), CC-BY-4.0 (GitHub Advisory Database)',
      snapshot: osvMark,
      records: osv.records,
    });
  if (kb.length || opts.kbIncidents.length)
    sources.push({ name: 'Blastradius incident KB (curated)', url: 'https://github.com/kambasana/56/tree/main/blastradius/kb/incidents', licence: 'Blastradius repository licence', snapshot: kbSnapshot(opts.kbIncidents), records: opts.kbIncidents.length });
  if (ddMark)
    sources.push({ name: `Datadog malicious-software-packages-dataset (samples/${eco.toLowerCase()}/manifest.json)`, url: 'https://github.com/DataDog/malicious-software-packages-dataset', licence: 'Apache-2.0', snapshot: `${ddMark[0]} (${ddMark[1]})`, records: dd.length });
  if (bkcMark)
    sources.push({
      name: "Backstabber's Knife Collection package names (labels only; cite Ohm et al., DIMVA 2020)",
      url: 'https://github.com/dasfreak/Backstabbers-Knife-Collection',
      licence: 'no licence stated; names used as evidence labels only, with citation',
      snapshot: `${bkcMark[0]} (${bkcMark[1]})`,
      records: bkc,
    });

  // Stable ordering inside every list, then the shared finisher (sorted keys, counts).
  for (const list of Object.values(m.packages)) list.sort((a, b) => rankOf(a) - rankOf(b) || cmp(a.id, b.id));
  for (const byV of Object.values(m.versions)) for (const list of Object.values(byV)) list.sort((a, b) => rankOf(a) - rankOf(b) || cmp(a.id, b.id));
  for (const list of Object.values(m.ranges)) list.sort((a, b) => rankOf(a.ref) - rankOf(b.ref) || cmp(a.ref.id, b.ref.id));
  conflicts.sort((a, b) => cmp(a.name, b.name) || cmp(a.ref.id, b.ref.id));
  finishPack(pack, sources);
  pack.conflicts = conflicts;
  pack.labels = Object.fromEntries(Object.keys(labels).sort().map((k) => [k, labels[k]!]));
  const times = [osvMark, ddMark?.[1], bkcMark?.[1]].filter((x): x is string => !!x).sort();
  pack.builtAt = isoOf(times.pop() ?? '1970-01-01T00:00:00.000000000Z');
  return {
    pack,
    stats: { records: { osv: osv.records, kb: opts.kbIncidents.length, datadog: dd.length, bkc }, conflicts: conflicts.length, corroborated, datasetOnly, labels: bkc },
    newestModified: osv.newest,
  };
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const rankOf = (r: PackMalwareRef) => (r.source === 'kb' ? 0 : r.source === 'datadog' ? 3 : 1);
/** Normalised (9-digit) timestamp → ISO with milliseconds. */
const isoOf = (ts: string) => new Date(ts.slice(0, 23) + 'Z').toISOString();
