/**
 * Runs Laya zero-shot on every state in results/states.jsonl (LAYA-PREREGISTRATION.md) and writes
 * results/laya-scores.csv plus results/laya-run.json (model revision, file hashes, latency, memory).
 *
 *   LAYA_MODEL_DIR=<dir holding the pinned receptron/laya-onnx bundle> npx tsx run-laya.ts
 *
 * Without LAYA_MODEL_DIR the bundle is downloaded to the Laya cache at the pinned revision
 * (set NODE_USE_ENV_PROXY=1 behind an HTTPS proxy). Resumable: rows already in the CSV are skipped.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Laya } from '@receptron/laya';
import type { TriagePoint } from './build-states.ts';
import { EXPECTED_SHA256, QUESTIONS, REPO, REVISION } from './questions.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const RES = join(HERE, 'results');
const HEADER = 'id,group,account,incident,qualifying,fired_at,p_takeover,p_kind_takeover,p_kind_automation,p_kind_sweep,risk_score,input_tokens,latency_ms';

async function sha256(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

const q = (s: string) => (/[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};

const points = readFileSync(join(RES, 'states.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as TriagePoint);
const csv = join(RES, 'laya-scores.csv');
const done = new Set<string>();
if (existsSync(csv)) for (const l of readFileSync(csv, 'utf8').trim().split('\n').slice(1)) done.add(l.startsWith('"') ? l.slice(1, l.indexOf('"', 1)) : l.split(',')[0]!);
else writeFileSync(csv, `${HEADER}\n`);

const t0 = performance.now();
const laya = await Laya.load(process.env.LAYA_MODEL_DIR ? { modelDir: process.env.LAYA_MODEL_DIR } : { repo: REPO, revision: REVISION });
const loadMs = performance.now() - t0;
const hashes: Record<string, string> = {};
for (const f of Object.keys(EXPECTED_SHA256)) {
  hashes[f] = await sha256(join(laya.modelDir, f));
  if (hashes[f] !== EXPECTED_SHA256[f]) throw new Error(`${f}: sha256 ${hashes[f]} is not the pinned ${EXPECTED_SHA256[f]}`);
}
const rssAfterLoad = process.memoryUsage().rss;
// Warm-up on a fixed, unrelated state (not recorded as a decision).
await laya.systemOne({ note: 'warm-up' }, QUESTIONS);

const lat: number[] = [];
let maxTokens = 0;
let atLimit = 0;
// Pending states, incident points first (order does not change any score; it only matters if a run is cut short).
const pending = points.filter((p) => !done.has(p.id)).sort((a, b) => Number(b.group === 'incident') - Number(a.group === 'incident'));
for (const p of pending) {
  const s = performance.now();
  const r = await laya.systemOne(p.state, QUESTIONS);
  const ms = performance.now() - s;
  lat.push(ms);
  maxTokens = Math.max(maxTokens, r.usage.input_tokens);
  if (r.usage.input_tokens >= laya.config.max_len) atLimit++;
  const k = r.answers.kind.probabilities;
  appendFileSync(
    csv,
    `${[q(p.id), p.group, q(p.account), p.incident ?? '', p.qualifying === undefined ? '' : p.qualifying ? 1 : 0, p.firedAt, r.answers.takeover.noul.toFixed(6), (k.account_takeover ?? 0).toFixed(6), (k.release_automation ?? 0).toFixed(6), (k.maintainer_sweep ?? 0).toFixed(6), r.answers.risk.score.toFixed(4), r.usage.input_tokens, ms.toFixed(1)].join(',')}\n`,
  );
  if (lat.length % 200 === 0) console.log(`${lat.length + done.size}/${points.length} median ${pct(lat, 0.5).toFixed(0)} ms`);
}
await laya.close();

if (lat.length) {
  const run = {
    runtime: '@receptron/laya 0.1.2 (onnxruntime-node 1.30.0, CPU execution provider, default session options)',
    repo: REPO,
    revision: REVISION,
    sha256: hashes,
    bundleBytes: Object.fromEntries(Object.keys(EXPECTED_SHA256).map((f) => [f, statSync(join(laya.modelDir, f)).size])),
    config: laya.config,
    machine: { cpu: cpus()[0]?.model, cores: cpus().length, totalMemGiB: Math.round((totalmem() / 2 ** 30) * 10) / 10, node: process.version },
    decisions: lat.length,
    loadMs: Math.round(loadMs),
    latencyMs: { median: Math.round(pct(lat, 0.5)), p95: Math.round(pct(lat, 0.95)), max: Math.round(Math.max(...lat)), mean: Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) },
    memory: { rssAfterLoadMiB: Math.round(rssAfterLoad / 2 ** 20), peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024) },
    inputTokens: { max: maxTokens, atMaxLen: atLimit, maxLen: laya.config.max_len },
    statesSha256: readFileSync(join(RES, 'states.sha256'), 'utf8').split(' ')[0],
  };
  // One entry per run segment (the run is resumable; a segment covers the decisions it made).
  const file = join(RES, 'laya-run.json');
  const prev = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as unknown[]) : [];
  writeFileSync(file, `${JSON.stringify([...prev, { ...run, alreadyScoredAtStart: done.size }], null, 1)}\n`);
  console.log(JSON.stringify(run, null, 1));
}
