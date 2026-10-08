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
 *
 * Extensions (2026-10-08):
 *   --dataset DIR    held-out compromises from the training dataset (split "test", label 1) join
 *                    the recall set. The noisy-OR needs the release's manifest, which npm removed
 *                    for most of them; recall for the gate is measured on the releases both sides
 *                    can score (manifest served by npm), and the model's recall on all held-out
 *                    positives is reported separately. Test negatives give both confusion matrices.
 *   --downloads DIR  daily download series (pack/model/fetch_downloads.py): the model's download
 *                    features (as at release, as in training) and the noisy-OR's
 *                    established-dependency gate (downloads in the week before the scoring time).
 *   --control ID=DIR extra healthy repos scanned from their lockfiles (the hammer controls at their
 *                    pinned commits); when given, the model must also beat the baseline on them.
 *   --write-requests FILE  write the {name, releasedAt} download windows the run needs and stop.
 *   --no-reconstructed     ignore manifests the replay overlay rebuilt from advisories.
 * Everything is read from disk; nothing touches the network.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { levelForScore, npmPurl, type Component } from '../../src/core/types.js';
import { firstPublishedMs, markYoungDependencies, packumentFacts } from '../../src/enrich/npm/packument.js';
import { featuresAsOf } from '../../src/features/asof.js';
import { downloadsAsOf, readDownloadSeries } from '../../src/features/downloads.js';
import { scan } from '../../src/pipeline.js';
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

export interface ScoreOptions {
  /** Daily download series directory; enables download features and the established-dependency gate. */
  downloadsDir?: string;
  /** Score releases whose manifest npm no longer serves (model only; history features). */
  allowMissingManifest?: boolean;
  /** Called with each young added dependency (for --write-requests). */
  onYoung?: (name: string, asOf: Date) => void;
}

export function baseline(store: PackumentStore, name: string, version: string, asOf: Date, opts: ScoreOptions = {}): Verdict | undefined {
  const p = store.get(name);
  if (!p?.versions || !Object.hasOwn(p.versions, version)) return undefined;
  const facts = packumentFacts(p, name, version, { now: asOf });
  markYoungDependencies(facts, (n) => {
    const q = store.get(n);
    return q ? (firstPublishedMs(q, asOf) ?? null) : undefined;
  });
  // The scan fills weeklyDownloads from npm's last-week count; here it is the week before asOf.
  for (const f of facts) {
    if (f.kind !== 'dependency_added') continue;
    for (const y of f.value.young ?? []) {
      opts.onYoung?.(y.name, asOf);
      if (!opts.downloadsDir) continue;
      const w = downloadsAsOf(readDownloadSeries(opts.downloadsDir, y.name), asOf.getTime()).weekly;
      if (w !== undefined) y.weeklyDownloads = w;
    }
  }
  const c: Component = { purl: npmPurl(name, version), ecosystem: 'npm', name, version };
  const r = scoreIntrinsic(c, facts, { now: asOf });
  const signals = r.reasons.filter((x) => x.value > 0 && !isPostureReason(x));
  const score = Math.round(r.intrinsic * 1000) / 10;
  return { flagged: signals.length > 0, mediumPlus: signals.length > 0 && levelForScore(score) !== 'low', detail: signals.map((s) => s.factor).join(', ') };
}

export function modelVerdict(model: LikelyCompromiseModel, store: PackumentStore, name: string, version: string, asOf: Date, opts: ScoreOptions = {}): (Verdict & { calibrated: number }) | undefined {
  const p = store.get(name);
  if (!p) return undefined;
  // Same inputs as the dataset rows (src/features/cli.ts): downloads as at the release.
  const t = typeof p.time?.[version] === 'string' ? Date.parse(p.time[version] as string) : NaN;
  const dl = opts.downloadsDir && Number.isFinite(t) && t <= asOf.getTime() ? downloadsAsOf(readDownloadSeries(opts.downloadsDir, name), t) : {};
  const f = featuresAsOf(p, name, version, asOf, {
    firstPublished: (d) => store.firstPublished(d, asOf.getTime()),
    ...(dl.weekly !== undefined ? { downloadsWeekly: dl.weekly } : {}),
    ...(dl.trend !== undefined ? { downloadsTrend: dl.trend } : {}),
    ...(opts.allowMissingManifest ? { allowMissingManifest: true } : {}),
  });
  if (!f) return undefined;
  const s = model.score(f);
  return { flagged: s.flagged, mediumPlus: s.flagged, calibrated: s.calibrated, detail: `p=${s.calibrated.toFixed(4)}` };
}

interface RecallRow {
  incident: string;
  release: string;
  heldOut: boolean;
  source: 'replay' | 'dataset';
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
  /** Mean findings per hammer control repo (when controls are given). */
  controlsAtRelease?: number;
  controlsOnScanDay?: number;
}

export function gateVerdict(model: Side, base: Side): { strict: boolean; pareto: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const cmp = (label: string, m: number, b: number, higherIsBetter: boolean) => {
    const better = higherIsBetter ? m > b : m < b;
    const worse = higherIsBetter ? m < b : m > b;
    reasons.push(`${label}: model ${m.toFixed(3)} vs baseline ${b.toFixed(3)} → ${better ? 'better' : worse ? 'worse' : 'tie'}`);
    return { better, worse };
  };
  const r = [cmp('recall (held-out)', model.recall, base.recall, true), cmp('noise per Acme repo, at release', model.noiseAtRelease, base.noiseAtRelease, false), cmp('noise per Acme repo, scan day', model.noiseOnScanDay, base.noiseOnScanDay, false)];
  if (model.controlsAtRelease !== undefined && base.controlsAtRelease !== undefined) r.push(cmp('noise per hammer control repo, at release', model.controlsAtRelease, base.controlsAtRelease, false));
  if (model.controlsOnScanDay !== undefined && base.controlsOnScanDay !== undefined) r.push(cmp('noise per hammer control repo, scan day', model.controlsOnScanDay, base.controlsOnScanDay, false));
  return { strict: r.every((x) => x.better), pareto: r.every((x) => !x.worse) && r.some((x) => x.better), reasons };
}

interface DatasetRow {
  name: string;
  version: string;
  label: number;
  campaign: string | null;
  split: string;
  releasedAt: string;
}

function readDataset(dir: string): DatasetRow[] {
  const buf = readFileSync(join(dir, 'dataset.jsonl.gz'));
  const out: DatasetRow[] = [];
  for (const line of gunzipSync(buf).toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as DatasetRow;
    out.push({ name: r.name, version: r.version, label: r.label, campaign: r.campaign, split: r.split, releasedAt: r.releasedAt });
  }
  return out;
}

interface Confusion {
  tp: number;
  fn: number;
  fp: number;
  tn: number;
}

const confusion = (): Confusion => ({ tp: 0, fn: 0, fp: 0, tn: 0 });
function tally(c: Confusion, label: number, flagged: boolean) {
  if (label === 1) flagged ? c.tp++ : c.fn++;
  else flagged ? c.fp++ : c.tn++;
}

export interface GateOptions {
  bundle: string;
  cache: string;
  overlay?: string;
  downloads?: string;
  dataset?: string;
  controls?: { id: string; dir: string }[];
  dropReconstructed?: boolean;
  /** Collect the download windows the run needs instead of judging (see --write-requests). */
  requests?: { name: string; releasedAt: string }[];
}

async function inventories(targets: { id: string; dir: string }[]) {
  const out: { projectName: string; components: Component[] }[] = [];
  for (const t of targets) {
    const res = await scan({ target: t.dir, formats: [], offline: true, cacheDir: false, enrichers: () => [] });
    out.push({ projectName: t.id, components: res.inventory.components });
  }
  return out;
}

export async function runGate(opts: GateOptions) {
  const model = LikelyCompromiseModel.load(opts.bundle);
  const cutoff = String((model.bundle.meta as { cutoff?: string } | undefined)?.cutoff ?? '');
  const store = openStore({ cacheDir: opts.cache, overlayDir: opts.overlay ?? join(DATA_DIR, 'registry'), ...(opts.dropReconstructed ? { dropReconstructed: true } : {}) });
  const req = opts.requests;
  const want = (name: string, at: Date | number) => req?.push({ name, releasedAt: new Date(at).toISOString() });
  const so: ScoreOptions = { ...(opts.downloads ? { downloadsDir: opts.downloads } : {}), ...(req ? { onYoung: (n: string, at: Date) => want(n, at) } : {}) };
  const releaseMs = (name: string, version: string) => {
    const p = store.get(name);
    return typeof p?.time?.[version] === 'string' ? Date.parse(p.time[version] as string) : NaN;
  };

  // --- Recall on recorded compromises (replay incidents) -------------------------------------
  const recallRows: RecallRow[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  for (const inc of INCIDENTS) {
    for (const b of inc.bad) {
      const t = releaseMs(b.name, b.version);
      if (!Number.isFinite(t)) {
        dropped.push(`${b.name}@${b.version}: no release time`);
        continue;
      }
      want(b.name, t);
      const asOf = new Date(t + H);
      const base = baseline(store, b.name, b.version, asOf, so);
      const mod = modelVerdict(model, store, b.name, b.version, asOf, so);
      if (!base || !mod) {
        dropped.push(`${b.name}@${b.version}: no manifest`);
        continue;
      }
      seen.add(`${b.name}@${b.version}`);
      recallRows.push({ incident: inc.id, release: `${b.name}@${b.version}`, heldOut: cutoff !== '' && new Date(t).toISOString() >= cutoff, source: 'replay', baseline: base, model: mod });
    }
  }

  // --- Held-out compromises and negatives from the dataset -------------------------------------
  const ds = opts.dataset && !req ? readDataset(opts.dataset).filter((r) => r.split === 'test') : [];
  const modelAll = confusion(); // model on every held-out row (history features; manifest not needed)
  const modelBoth = confusion(); // model on rows the noisy-OR can also score
  const baseBoth = confusion();
  const campaigns = new Map<string, { positives: number; modelFlagged: number; comparable: number; modelComparable: number; baselineComparable: number }>();
  let notScorable = 0;
  for (const r of ds) {
    const t = Date.parse(r.releasedAt);
    const asOf = new Date(t + H);
    const mod = modelVerdict(model, store, r.name, r.version, asOf, { ...so, allowMissingManifest: true });
    if (!mod) {
      notScorable++;
      continue;
    }
    tally(modelAll, r.label, mod.flagged);
    const base = baseline(store, r.name, r.version, asOf, so);
    if (base) {
      tally(modelBoth, r.label, mod.flagged);
      tally(baseBoth, r.label, base.flagged);
    }
    if (r.label !== 1) continue;
    const c = campaigns.get(r.campaign ?? '?') ?? { positives: 0, modelFlagged: 0, comparable: 0, modelComparable: 0, baselineComparable: 0 };
    c.positives++;
    c.modelFlagged += +mod.flagged;
    if (base) {
      c.comparable++;
      c.modelComparable += +mod.flagged;
      c.baselineComparable += +base.flagged;
      const key = `${r.name}@${r.version}`;
      if (!seen.has(key)) {
        seen.add(key);
        recallRows.push({ incident: r.campaign ?? '?', release: key, heldOut: true, source: 'dataset', baseline: base, model: mod });
      }
    }
    campaigns.set(r.campaign ?? '?', c);
  }

  const recall = (rows: typeof recallRows, who: 'baseline' | 'model', key: 'flagged' | 'mediumPlus' = 'flagged') => (rows.length ? rows.filter((r) => r[who][key]).length / rows.length : NaN);
  const heldOut = recallRows.filter((r) => r.heldOut);
  const inSample = recallRows.filter((r) => !r.heldOut);

  // --- Noise: Acme org repos and hammer controls -----------------------------------------------
  const incidentPkgs = new Set(INCIDENTS.flatMap((i) => [...i.packages, ...i.bad.map((b) => b.name)]));
  let missing = 0;
  const noiseFor = (inv: { projectName: string; components: Component[] }): RepoNoise => {
    const comps = new Map<string, Component>();
    for (const c of inv.components) if (c.ecosystem === 'npm' && !incidentPkgs.has(c.name)) comps.set(`${c.name}@${c.version}`, c);
    const counts = { components: 0, baselineAtRelease: 0, baselineMediumAtRelease: 0, modelAtRelease: 0, baselineScanDay: 0, baselineMediumScanDay: 0, modelScanDay: 0 };
    const examples: { baseline: string[]; model: string[] } = { baseline: [], model: [] };
    for (const c of [...comps.values()].sort((a, b) => a.purl.localeCompare(b.purl))) {
      const t = releaseMs(c.name, c.version);
      if (!Number.isFinite(t) || t + H > SCAN_DAY.getTime()) {
        missing++;
        continue;
      }
      want(c.name, t);
      const atRel = new Date(t + H);
      const b1 = baseline(store, c.name, c.version, atRel, so);
      const b2 = baseline(store, c.name, c.version, SCAN_DAY, so);
      const m1 = modelVerdict(model, store, c.name, c.version, atRel, so);
      const m2 = modelVerdict(model, store, c.name, c.version, SCAN_DAY, so);
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
    return { repo: inv.projectName, ...counts, examples };
  };
  const repos = (await orgInventories()).map((inv) => noiseFor({ projectName: inv.projectName, components: inv.inventory.components }));
  const controls = (await inventories(opts.controls ?? [])).map(noiseFor);
  type K = Exclude<keyof RepoNoise, 'repo' | 'examples'>;
  const meanOf = (rs: RepoNoise[], k: K) => rs.reduce((n, r) => n + r[k], 0) / Math.max(1, rs.length);
  const mean = (k: K) => meanOf(repos, k);
  const hasControls = controls.length > 0;
  const modelSide: Side = { recall: recall(heldOut, 'model'), noiseAtRelease: mean('modelAtRelease'), noiseOnScanDay: mean('modelScanDay'), ...(hasControls ? { controlsAtRelease: meanOf(controls, 'modelAtRelease'), controlsOnScanDay: meanOf(controls, 'modelScanDay') } : {}) };
  const baseSide: Side = { recall: recall(heldOut, 'baseline'), noiseAtRelease: mean('baselineAtRelease'), noiseOnScanDay: mean('baselineScanDay'), ...(hasControls ? { controlsAtRelease: meanOf(controls, 'baselineAtRelease'), controlsOnScanDay: meanOf(controls, 'baselineScanDay') } : {}) };
  const verdict = gateVerdict(modelSide, baseSide);
  const per = (rows: RecallRow[]) => {
    const m = new Map<string, { releases: number; model: number; baseline: number }>();
    for (const r of rows) {
      const e = m.get(r.incident) ?? { releases: 0, model: 0, baseline: 0 };
      e.releases++;
      e.model += +r.model.flagged;
      e.baseline += +r.baseline.flagged;
      m.set(r.incident, e);
    }
    return [...m.entries()].map(([campaign, v]) => ({ campaign, ...v })).sort((a, b) => b.releases - a.releases || a.campaign.localeCompare(b.campaign));
  };
  return {
    generatedAt: new Date().toISOString(),
    cutoff,
    threshold: model.threshold,
    variant: (model.bundle.meta as { variant?: string } | undefined)?.variant ?? null,
    options: { downloads: Boolean(opts.downloads), dataset: Boolean(opts.dataset), controls: (opts.controls ?? []).map((c) => c.id), dropReconstructed: Boolean(opts.dropReconstructed) },
    recall: {
      heldOut: { releases: heldOut.length, model: modelSide.recall, baseline: baseSide.recall, baselineMediumPlus: recall(heldOut, 'baseline', 'mediumPlus'), modelOnly: heldOut.filter((r) => r.model.flagged && !r.baseline.flagged).length, baselineOnly: heldOut.filter((r) => !r.model.flagged && r.baseline.flagged).length, both: heldOut.filter((r) => r.model.flagged && r.baseline.flagged).length },
      inSample: { releases: inSample.length, model: recall(inSample, 'model'), baseline: recall(inSample, 'baseline'), baselineMediumPlus: recall(inSample, 'baseline', 'mediumPlus') },
      perCampaignHeldOut: per(heldOut),
      rows: recallRows,
    },
    dataset: opts.dataset
      ? {
          testRows: ds.length,
          notScorable,
          modelAllRows: modelAll,
          comparableRows: { model: modelBoth, baseline: baseBoth },
          perCampaign: [...campaigns.entries()].map(([campaign, v]) => ({ campaign, ...v })).sort((a, b) => b.positives - a.positives || a.campaign.localeCompare(b.campaign)),
        }
      : null,
    noise: {
      repos,
      controls,
      meanPerRepo: { modelAtRelease: modelSide.noiseAtRelease, baselineAtRelease: baseSide.noiseAtRelease, baselineMediumAtRelease: mean('baselineMediumAtRelease'), modelScanDay: modelSide.noiseOnScanDay, baselineScanDay: baseSide.noiseOnScanDay, baselineMediumScanDay: mean('baselineMediumScanDay') },
      meanPerControl: hasControls ? { modelAtRelease: modelSide.controlsAtRelease, baselineAtRelease: baseSide.controlsAtRelease, modelScanDay: modelSide.controlsOnScanDay, baselineScanDay: baseSide.controlsOnScanDay, baselineMediumScanDay: meanOf(controls, 'baselineMediumScanDay') } : null,
      componentsWithoutData: missing,
    },
    dropped,
    gate: { pass: verdict.strict, paretoBetter: verdict.pareto, reasons: verdict.reasons },
  };
}

export function gateMarkdown(r: Awaited<ReturnType<typeof runGate>>): string {
  const pct = (x: number) => (Number.isFinite(x) ? `${Math.round(x * 1000) / 10}%` : 'n/a');
  const n = (x: number | undefined) => (x === undefined ? 'n/a' : (Math.round(x * 100) / 100).toString());
  const cm = (c: Confusion) => `TP ${c.tp}, FN ${c.fn}, FP ${c.fp}, TN ${c.tn} (recall ${pct(c.tp / Math.max(1, c.tp + c.fn))}, false-positive rate ${pct(c.fp / Math.max(1, c.fp + c.tn))}, precision ${pct(c.tp / Math.max(1, c.tp + c.fp))})`;
  const noiseRows = (rs: RepoNoise[]) => rs.map((x) => `| ${x.repo} | ${x.components} | ${x.modelAtRelease} | ${x.baselineAtRelease} | ${x.modelScanDay} | ${x.baselineScanDay} (${x.baselineMediumScanDay}) |`);
  const L = [
    '# Model backtest gate',
    '',
    `Gate: **${r.gate.pass ? 'PASS' : 'FAIL'}** (model must beat the noisy-OR on held-out recall and on noise in every viewpoint). Pareto-better: ${r.gate.paretoBetter ? 'yes' : 'no'}.`,
    '',
    ...r.gate.reasons.map((x) => `- ${x}`),
    '',
    `Cutoff ${r.cutoff}; calibrated threshold ${r.threshold}; variant ${r.variant ?? 'n/a'}. Options: ${JSON.stringify(r.options)}.`,
    '',
    '## Recall before disclosure (release + 1 h)',
    '',
    'Held-out = replay incidents released on/after the cutoff plus the dataset test split; only releases both sides can score (npm still serves the manifest).',
    '',
    `| Set | Releases | Model | Noisy-OR (any finding) | Noisy-OR (medium+) |`,
    '|---|---|---|---|---|',
    `| Held-out | ${r.recall.heldOut.releases} | ${pct(r.recall.heldOut.model)} | ${pct(r.recall.heldOut.baseline)} | ${pct(r.recall.heldOut.baselineMediumPlus)} |`,
    `| Replay incidents before the cutoff (in-sample) | ${r.recall.inSample.releases} | ${pct(r.recall.inSample.model)} | ${pct(r.recall.inSample.baseline)} | ${pct(r.recall.inSample.baselineMediumPlus)} |`,
    '',
    `Held-out overlap: both flag ${r.recall.heldOut.both}, model only ${r.recall.heldOut.modelOnly}, noisy-OR only ${r.recall.heldOut.baselineOnly}.`,
    '',
    '| Campaign (held-out) | Releases | Model | Noisy-OR |',
    '|---|---|---|---|',
    ...r.recall.perCampaignHeldOut.map((x) => `| ${x.campaign} | ${x.releases} | ${x.model} | ${x.baseline} |`),
    '',
    ...(r.dataset
      ? [
          '## Dataset test split (2026)',
          '',
          `${r.dataset.testRows} rows, ${r.dataset.notScorable} not scorable.`,
          '',
          `- Model, every row (history features): ${cm(r.dataset.modelAllRows)}`,
          `- Model, rows the noisy-OR can score: ${cm(r.dataset.comparableRows.model)}`,
          `- Noisy-OR, same rows: ${cm(r.dataset.comparableRows.baseline)}`,
          '',
          '| Campaign | Positives | Model flagged (all) | Comparable | Model (comparable) | Noisy-OR (comparable) |',
          '|---|---|---|---|---|---|',
          ...r.dataset.perCampaign.map((x) => `| ${x.campaign} | ${x.positives} | ${x.modelFlagged} | ${x.comparable} | ${x.modelComparable} | ${x.baselineComparable} |`),
          '',
        ]
      : []),
    '## Noise: findings per Acme org repo (incident packages excluded)',
    '',
    '| Repo | Releases scored | Model at release | Noisy-OR at release | Model on scan day | Noisy-OR on scan day (medium+) |',
    '|---|---|---|---|---|---|',
    ...noiseRows(r.noise.repos),
    `| **Mean per repo** | | ${n(r.noise.meanPerRepo.modelAtRelease)} | ${n(r.noise.meanPerRepo.baselineAtRelease)} | ${n(r.noise.meanPerRepo.modelScanDay)} | ${n(r.noise.meanPerRepo.baselineScanDay)} (${n(r.noise.meanPerRepo.baselineMediumScanDay)}) |`,
    '',
    ...(r.noise.meanPerControl
      ? [
          '## Noise: hammer control repos (pinned commits, lockfiles only)',
          '',
          '| Repo | Releases scored | Model at release | Noisy-OR at release | Model on scan day | Noisy-OR on scan day (medium+) |',
          '|---|---|---|---|---|---|',
          ...noiseRows(r.noise.controls),
          `| **Mean per repo** | | ${n(r.noise.meanPerControl.modelAtRelease)} | ${n(r.noise.meanPerControl.baselineAtRelease)} | ${n(r.noise.meanPerControl.modelScanDay)} | ${n(r.noise.meanPerControl.baselineScanDay)} (${n(r.noise.meanPerControl.baselineMediumScanDay)}) |`,
          '',
        ]
      : []),
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
  const all = (f: string) => args.flatMap((a, i) => (a === f && args[i + 1] ? [args[i + 1]!] : []));
  const bundle = get('--bundle');
  const cache = get('--cache');
  if (!bundle || !cache) {
    process.stderr.write('usage: gate.ts --bundle model.json --cache DIR [--overlay DIR] [--downloads DIR] [--dataset DIR] [--control ID=DIR]... [--no-reconstructed] [--write-requests FILE] [--out DIR]\n');
    process.exit(2);
  }
  const controls = all('--control').map((c) => {
    const i = c.indexOf('=');
    return { id: c.slice(0, i), dir: c.slice(i + 1) };
  });
  const reqFile = get('--write-requests');
  const requests: { name: string; releasedAt: string }[] | undefined = reqFile ? [] : undefined;
  const r = await runGate({
    bundle,
    cache,
    ...(get('--overlay') ? { overlay: get('--overlay')! } : {}),
    ...(get('--downloads') ? { downloads: get('--downloads')! } : {}),
    ...(get('--dataset') ? { dataset: get('--dataset')! } : {}),
    ...(controls.length ? { controls } : {}),
    ...(args.includes('--no-reconstructed') ? { dropReconstructed: true } : {}),
    ...(requests ? { requests } : {}),
  });
  if (reqFile && requests) {
    const uniq = [...new Map(requests.map((q) => [`${q.name} ${q.releasedAt.slice(0, 10)}`, q])).values()];
    writeFileSync(reqFile, uniq.map((q) => JSON.stringify(q)).join('\n') + '\n');
    process.stdout.write(`${uniq.length} download windows → ${reqFile}\n`);
  } else {
    const out = get('--out') ?? join(fileURLToPath(new URL('.', import.meta.url)), 'out');
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'gate.json'), `${JSON.stringify(r, null, 1)}\n`);
    writeFileSync(join(out, 'gate.md'), gateMarkdown(r));
    process.stdout.write(gateMarkdown(r));
    process.exitCode = r.gate.pass ? 0 : 3;
  }
}
