/**
 * Backtest gate (docs/DATA-ML.md §2.7): the trained model against today's hand-weighted noisy-OR.
 *
 *   npm run model:gate -- --bundle out/model/model.json --cache pack/model/.cache/packuments [--out pack/model/out/gate]
 *
 * Recall: share of the recorded compromised releases (test/replay incidents) flagged before
 *   disclosure, scored as of release + 1 hour (as the proof run does). Reported for the held-out
 *   incidents (released on/after the model's cutoff) and, for information, the training ones.
 * Noise: findings per Acme org repo (test/replay/data/org) on releases no incident names, with
 *   incident packages left out. Two viewpoints: each pinned release scored right after it came
 *   out, and every repo scanned on a fixed day (SCAN_DAY), as a user would see it.
 * Baseline: scoreIntrinsic on the npm facts the scan derives from the same packuments (no OSV, so
 *   only pre-disclosure signals); a release is flagged when it would become a finding under the
 *   noise rule. "medium+" counts only findings scoring medium or above.
 * Gate: the model ships only if, on held-out incidents and on both noise viewpoints, it beats the
 *   baseline on recall AND on noise (strictly better on both, as DATA-ML says). Pareto dominance
 *   (no worse on either, better on one) is reported too, but is not the gate.
 * Everything is read from disk; nothing touches the network.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { levelForScore, npmPurl, type Component } from '../../src/core/types.js';
import { firstPublishedMs, markYoungDependencies, packumentFacts } from '../../src/enrich/npm/packument.js';
import { featuresAsOf } from '../../src/features/asof.js';
import { openStore, type PackumentStore } from '../../src/features/store.js';
import { LikelyCompromiseModel } from '../../src/model/bundle.js';
import { isPostureReason } from '../../src/scoring/index.js';
import { scoreIntrinsic } from '../../src/scoring/intrinsic.js';
import { INCIDENTS, orgInventories } from '../replay/org.js';
import { DATA_DIR } from '../replay/server.js';

const H = 3_600_000;
export const SCAN_DAY = new Date('2026-10-07T00:00:00Z');

export interface Verdict {
  flagged: boolean;
  mediumPlus: boolean;
  detail: string;
}

export function baseline(store: PackumentStore, name: string, version: string, asOf: Date): Verdict | undefined {
  const p = store.get(name);
  if (!p?.versions || !Object.hasOwn(p.versions, version)) return undefined;
  const facts = packumentFacts(p, name, version, { now: asOf });
  markYoungDependencies(facts, (n) => {
    const q = store.get(n);
    return q ? (firstPublishedMs(q, asOf) ?? null) : undefined;
  });
  const c: Component = { purl: npmPurl(name, version), ecosystem: 'npm', name, version };
  const r = scoreIntrinsic(c, facts, { now: asOf });
  const signals = r.reasons.filter((x) => x.value > 0 && !isPostureReason(x));
  const score = Math.round(r.intrinsic * 1000) / 10;
  return { flagged: signals.length > 0, mediumPlus: signals.length > 0 && levelForScore(score) !== 'low', detail: signals.map((s) => s.factor).join(', ') };
}

export function modelVerdict(model: LikelyCompromiseModel, store: PackumentStore, name: string, version: string, asOf: Date): (Verdict & { calibrated: number }) | undefined {
  const p = store.get(name);
  if (!p) return undefined;
  const f = featuresAsOf(p, name, version, asOf, { firstPublished: (d) => store.firstPublished(d, asOf.getTime()) });
  if (!f) return undefined;
  const s = model.score(f);
  return { flagged: s.flagged, mediumPlus: s.flagged, calibrated: s.calibrated, detail: `p=${s.calibrated.toFixed(4)}` };
}

interface RecallRow {
  incident: string;
  release: string;
  heldOut: boolean;
  baseline: Verdict;
  model: Verdict & { calibrated: number };
}

interface RepoNoise {
  repo: string;
  components: number;
  baselineAtRelease: number;
  baselineMediumAtRelease: number;
  modelAtRelease: number;
  baselineScanDay: number;
  baselineMediumScanDay: number;
  modelScanDay: number;
  examples: { baseline: string[]; model: string[] };
}

interface Side {
  recall: number;
  noiseAtRelease: number;
  noiseOnScanDay: number;
}

export function gateVerdict(model: Side, base: Side): { strict: boolean; pareto: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const cmp = (label: string, m: number, b: number, higherIsBetter: boolean) => {
    const better = higherIsBetter ? m > b : m < b;
    const worse = higherIsBetter ? m < b : m > b;
    reasons.push(`${label}: model ${m.toFixed(3)} vs baseline ${b.toFixed(3)} → ${better ? 'better' : worse ? 'worse' : 'tie'}`);
    return { better, worse };
  };
  const r = [cmp('recall (held-out)', model.recall, base.recall, true), cmp('noise per repo, at release', model.noiseAtRelease, base.noiseAtRelease, false), cmp('noise per repo, scan day', model.noiseOnScanDay, base.noiseOnScanDay, false)];
  return { strict: r.every((x) => x.better), pareto: r.every((x) => !x.worse) && r.some((x) => x.better), reasons };
}

export async function runGate(opts: { bundle: string; cache: string; overlay?: string }) {
  const model = LikelyCompromiseModel.load(opts.bundle);
  const cutoff = String((model.bundle.meta as { cutoff?: string } | undefined)?.cutoff ?? '');
  const store = openStore({ cacheDir: opts.cache, overlayDir: opts.overlay ?? join(DATA_DIR, 'registry') });

  // --- Recall on recorded compromises ---------------------------------------------------
  const recallRows: RecallRow[] = [];
  const dropped: string[] = [];
  for (const inc of INCIDENTS) {
    for (const b of inc.bad) {
      const p = store.get(b.name);
      const t = typeof p?.time?.[b.version] === 'string' ? Date.parse(p.time[b.version] as string) : NaN;
      if (!Number.isFinite(t)) {
        dropped.push(`${b.name}@${b.version}: no release time`);
        continue;
      }
      const asOf = new Date(t + H);
      const base = baseline(store, b.name, b.version, asOf);
      const mod = modelVerdict(model, store, b.name, b.version, asOf);
      if (!base || !mod) {
        dropped.push(`${b.name}@${b.version}: no manifest`);
        continue;
      }
      recallRows.push({ incident: inc.id, release: `${b.name}@${b.version}`, heldOut: cutoff !== '' && new Date(t).toISOString() >= cutoff, baseline: base, model: mod });
    }
  }
  const recall = (rows: typeof recallRows, who: 'baseline' | 'model', key: 'flagged' | 'mediumPlus' = 'flagged') => (rows.length ? rows.filter((r) => r[who][key]).length / rows.length : NaN);
  const heldOut = recallRows.filter((r) => r.heldOut);
  const inSample = recallRows.filter((r) => !r.heldOut);

  // --- Noise on the Acme org ---------------------------------------------------------------
  const incidentPkgs = new Set(INCIDENTS.flatMap((i) => [...i.packages, ...i.bad.map((b) => b.name)]));
  const repos: RepoNoise[] = [];
  let missing = 0;
  for (const inv of await orgInventories()) {
    const comps = new Map<string, Component>();
    for (const c of inv.inventory.components) if (c.ecosystem === 'npm' && !incidentPkgs.has(c.name)) comps.set(`${c.name}@${c.version}`, c);
    const counts = { components: 0, baselineAtRelease: 0, baselineMediumAtRelease: 0, modelAtRelease: 0, baselineScanDay: 0, baselineMediumScanDay: 0, modelScanDay: 0 };
    const examples: { baseline: string[]; model: string[] } = { baseline: [], model: [] };
    for (const c of [...comps.values()].sort((a, b) => a.purl.localeCompare(b.purl))) {
      const p = store.get(c.name);
      const t = typeof p?.time?.[c.version] === 'string' ? Date.parse(p.time[c.version] as string) : NaN;
      if (!Number.isFinite(t) || t + H > SCAN_DAY.getTime()) {
        missing++;
        continue;
      }
      const atRel = new Date(t + H);
      const b1 = baseline(store, c.name, c.version, atRel);
      const b2 = baseline(store, c.name, c.version, SCAN_DAY);
      const m1 = modelVerdict(model, store, c.name, c.version, atRel);
      const m2 = modelVerdict(model, store, c.name, c.version, SCAN_DAY);
      if (!b1 || !b2 || !m1 || !m2) {
        missing++;
        continue;
      }
      counts.components++;
      counts.baselineAtRelease += +b1.flagged;
      counts.baselineMediumAtRelease += +b1.mediumPlus;
      counts.modelAtRelease += +m1.flagged;
      counts.baselineScanDay += +b2.flagged;
      counts.baselineMediumScanDay += +b2.mediumPlus;
      counts.modelScanDay += +m2.flagged;
      if (b2.flagged && examples.baseline.length < 5) examples.baseline.push(`${c.name}@${c.version} (${b2.detail})`);
      if (m2.flagged && examples.model.length < 5) examples.model.push(`${c.name}@${c.version} (${m2.detail})`);
    }
    repos.push({ repo: inv.projectName, ...counts, examples });
  }
  const mean = (k: Exclude<keyof RepoNoise, 'repo' | 'examples'>) => repos.reduce((n, r) => n + r[k], 0) / Math.max(1, repos.length);
  const modelSide = { recall: recall(heldOut, 'model'), noiseAtRelease: mean('modelAtRelease'), noiseOnScanDay: mean('modelScanDay') };
  const baseSide = { recall: recall(heldOut, 'baseline'), noiseAtRelease: mean('baselineAtRelease'), noiseOnScanDay: mean('baselineScanDay') };
  const verdict = gateVerdict(modelSide, baseSide);
  return {
    generatedAt: new Date().toISOString(),
    cutoff,
    threshold: model.threshold,
    recall: {
      heldOut: { releases: heldOut.length, model: modelSide.recall, baseline: baseSide.recall, baselineMediumPlus: recall(heldOut, 'baseline', 'mediumPlus') },
      inSample: { releases: inSample.length, model: recall(inSample, 'model'), baseline: recall(inSample, 'baseline'), baselineMediumPlus: recall(inSample, 'baseline', 'mediumPlus') },
      rows: recallRows,
    },
    noise: {
      repos,
      meanPerRepo: { modelAtRelease: modelSide.noiseAtRelease, baselineAtRelease: baseSide.noiseAtRelease, baselineMediumAtRelease: mean('baselineMediumAtRelease'), modelScanDay: modelSide.noiseOnScanDay, baselineScanDay: baseSide.noiseOnScanDay, baselineMediumScanDay: mean('baselineMediumScanDay') },
      componentsWithoutData: missing,
    },
    dropped,
    gate: { pass: verdict.strict, paretoBetter: verdict.pareto, reasons: verdict.reasons },
  };
}

export function gateMarkdown(r: Awaited<ReturnType<typeof runGate>>): string {
  const pct = (x: number) => (Number.isFinite(x) ? `${Math.round(x * 1000) / 10}%` : 'n/a');
  const n = (x: number) => (Math.round(x * 100) / 100).toString();
  const L = [
    '# Model backtest gate',
    '',
    `Gate: **${r.gate.pass ? 'PASS' : 'FAIL'}** (model must beat the noisy-OR on held-out recall and on noise in both viewpoints). Pareto-better: ${r.gate.paretoBetter ? 'yes' : 'no'}.`,
    '',
    ...r.gate.reasons.map((x) => `- ${x}`),
    '',
    `Cutoff ${r.cutoff}; calibrated threshold ${r.threshold}.`,
    '',
    '## Recall before disclosure (release + 1 h)',
    '',
    `| Set | Releases | Model | Noisy-OR (any finding) | Noisy-OR (medium+) |`,
    '|---|---|---|---|---|',
    `| Held-out incidents | ${r.recall.heldOut.releases} | ${pct(r.recall.heldOut.model)} | ${pct(r.recall.heldOut.baseline)} | ${pct(r.recall.heldOut.baselineMediumPlus)} |`,
    `| Training incidents (in-sample) | ${r.recall.inSample.releases} | ${pct(r.recall.inSample.model)} | ${pct(r.recall.inSample.baseline)} | ${pct(r.recall.inSample.baselineMediumPlus)} |`,
    '',
    '| Release | Held out | Model | Noisy-OR |',
    '|---|---|---|---|',
    ...r.recall.rows.map((x) => `| ${x.release} | ${x.heldOut ? 'yes' : 'no'} | ${x.model.flagged ? 'flagged' : 'no'} (${x.model.detail}) | ${x.baseline.flagged ? `flagged: ${x.baseline.detail}` : 'no'} |`),
    '',
    '## Noise: findings per Acme org repo (incident packages excluded)',
    '',
    '| Repo | Releases scored | Model at release | Noisy-OR at release | Model on scan day | Noisy-OR on scan day (medium+) |',
    '|---|---|---|---|---|---|',
    ...r.noise.repos.map((x) => `| ${x.repo} | ${x.components} | ${x.modelAtRelease} | ${x.baselineAtRelease} | ${x.modelScanDay} | ${x.baselineScanDay} (${x.baselineMediumScanDay}) |`),
    `| **Mean per repo** | | ${n(r.noise.meanPerRepo.modelAtRelease)} | ${n(r.noise.meanPerRepo.baselineAtRelease)} | ${n(r.noise.meanPerRepo.modelScanDay)} | ${n(r.noise.meanPerRepo.baselineScanDay)} (${n(r.noise.meanPerRepo.baselineMediumScanDay)}) |`,
    '',
    `Components without packument data (skipped): ${r.noise.componentsWithoutData}. Dropped incident releases: ${r.dropped.length ? r.dropped.join('; ') : 'none'}.`,
    `Scan day: ${SCAN_DAY.toISOString().slice(0, 10)}.`,
  ];
  return `${L.join('\n')}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const get = (f: string) => {
    const i = args.indexOf(f);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const bundle = get('--bundle');
  const cache = get('--cache');
  if (!bundle || !cache) {
    process.stderr.write('usage: gate.ts --bundle model.json --cache DIR [--overlay DIR] [--out DIR]\n');
    process.exit(2);
  }
  const r = await runGate({ bundle, cache, ...(get('--overlay') ? { overlay: get('--overlay')! } : {}) });
  const out = get('--out') ?? join(fileURLToPath(new URL('.', import.meta.url)), 'out');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'gate.json'), `${JSON.stringify(r, null, 1)}\n`);
  writeFileSync(join(out, 'gate.md'), gateMarkdown(r));
  process.stdout.write(gateMarkdown(r));
  process.exitCode = r.gate.pass ? 0 : 3;
}
