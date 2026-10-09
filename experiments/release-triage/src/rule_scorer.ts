/**
 * Baseline 1: the product's current rule scorer on the same releases.
 *
 * For every fetched record it runs blastradius's own `packumentFacts` (npm enricher, pure helper) on the as-of
 * packument, fills `young` on dependency_added from the recorded first-publish times (markYoungDependencies), and
 * scores the release with `scoreIntrinsic` (noisy-OR, DEFAULT_WEIGHTS) at release time + 60 min. No vulnerability,
 * Scorecard or malware-feed facts are given: those are lookups of known-bad lists, not publish-time signals, and
 * would make the rule scorer an oracle. Top-level `maintainers` is set from the release's own version document
 * (as of the release), not today's list.
 *
 *   RT_CACHE=/home/user/rtwork/cache npx tsx src/rule_scorer.ts   ->  results/rule_scores.csv
 */
import { gunzipSync } from 'node:zlib';
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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
for (const f of readdirSync(dir).sort()) {
  if (!f.endsWith('.json.gz')) continue;
  const r = JSON.parse(gunzipSync(readFileSync(join(dir, f))).toString('utf8'));
  if (r.drop) continue;
  const doc = r.asof.versions[r.version];
  const p = { name: r.name, time: r.asof.time, versions: r.asof.versions, maintainers: doc.maintainers ?? [] };
  const now = new Date(Date.parse(r.published) + 60 * 60 * 1000);
  const facts = packumentFacts(p as never, r.name, r.version, { now });
  const fp: Record<string, string | null> = r.added_deps_first_published ?? {};
  markYoungDependencies(facts, (name) => (name in fp ? (fp[name] ? Date.parse(fp[name]!) : null) : undefined));
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
