/**
 * Baseline 1: the product's current rule scorer on the same releases.
 *
 * For every fetched record it runs blastradius's own `packumentFacts` (npm enricher, pure helper) on the as-of
 * packument, fills `young` on dependency_added from the recorded first-publish times (markYoungDependencies; a
 * dependency whose first-publish date is unknown today, or later than the scoring time, is skipped, not young), and
 * scores the release with `scoreIntrinsic` (noisy-OR, DEFAULT_WEIGHTS) at release time + 60 min. No vulnerability,
 * Scorecard or malware-feed facts are given: those are lookups of known-bad lists, not publish-time signals, and
 * would make the rule scorer an oracle. Top-level `maintainers` is set from the release's own version document
 * (as of the release), not today's list.
 *
 *   RT_CACHE=/home/user/rtwork/cache npx tsx src/rule_scorer.ts   ->  results/rule_scores.csv
 */
import { gunzipSync } from 'node:zlib';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packumentFacts, markYoungDependencies } from '../../../blastradius/src/enrich/npm/packument.js';
import { scoreIntrinsic } from '../../../blastradius/src/scoring/intrinsic.js';
import { npmPurl } from '../../../blastradius/src/core/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = process.env.RT_CACHE ?? '/home/user/rtwork/cache';
const dir = join(CACHE, 'records');
const out: string[] = ['key,intrinsic,factors,install_flags'];
let n = 0;
const t0 = Date.now();
// Only the releases listed in the candidate files, read through the same cache-path rule as common.py cache_path.
const cachePath = (key: string): string => {
  let safe = key.replace(/[^A-Za-z0-9._@-]/g, '_');
  if (safe.length > 180) safe = `${safe.slice(0, 150)}_${createHash('sha1').update(key).digest('hex').slice(0, 16)}`;
  return join(dir, `${safe}.json.gz`);
};
const keys = new Set<string>();
for (const f of ['positive_candidates.jsonl', 'negative_candidates.jsonl']) {
  for (const line of readFileSync(join(HERE, '..', 'data', f), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const c = JSON.parse(line);
    keys.add(`${c.label}:${c.name}@${c.version}`);
  }
}
for (const key of [...keys].sort()) {
  const path = cachePath(key);
  if (!existsSync(path)) continue;
  const r = JSON.parse(gunzipSync(readFileSync(path)).toString('utf8'));
  if (r.drop) continue;
  const doc = r.asof.versions[r.version];
  const p = { name: r.name, time: r.asof.time, versions: r.asof.versions, maintainers: doc.maintainers ?? [] };
  const now = new Date(Date.parse(r.published) + 60 * 60 * 1000);
  const facts = packumentFacts(p as never, r.name, r.version, { now });
  const fp: Record<string, string | null> = r.added_deps_first_published ?? {};
  // Same rule as build.py young_dependencies: a dependency that today's registry cannot resolve, or whose earliest
  // surviving version is later than the scoring time (npm's security placeholder, a re-registered name), has an UNKNOWN
  // first-publish date. `undefined` tells markYoungDependencies "unknown" (skip); `null` would mean "young", which
  // replays hindsight: malicious dependencies are the ones npm removes later.
  markYoungDependencies(facts, (name) => {
    const t = fp[name] ? Date.parse(fp[name]!) : NaN;
    return Number.isFinite(t) && t <= now.getTime() ? t : undefined;
  });
  const purl = npmPurl(r.name, r.version);
  const res = scoreIntrinsic({ purl, ecosystem: 'npm', name: r.name, version: r.version } as never, facts, { now });
  const flags = (facts.find((x) => x.kind === 'install_script')?.value as { flags?: string[] } | undefined)?.flags ?? [];
  const factors = res.reasons.filter((x) => x.contribution > 0).map((x) => x.factor);
  out.push([JSON.stringify(r.key), res.intrinsic.toFixed(6), factors.join(';'), flags.join(';')].join(','));
  n++;
}
mkdirSync(join(HERE, '..', 'results'), { recursive: true });
writeFileSync(join(HERE, '..', 'results', 'rule_scores.csv'), `${out.join('\n')}\n`);
console.log(`scored ${n} releases in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
