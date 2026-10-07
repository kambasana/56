/**
 * Model CLI used by the bootstrap (pack/model/train.py):
 *
 *   tsx src/model/cli.ts parity --model lightgbm.json --rows parity.jsonl [--tol 1e-6]
 *     Each row: {"features": [...|null], "raw": <LightGBM raw score>, "prob": <LightGBM predict>}.
 *     Exits 1 when any |TS − LightGBM| exceeds the tolerance. Prints a JSON summary.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GbdtModel, type LgbModelJson } from './gbdt.js';

export function parity(model: GbdtModel, rows: { features: (number | null)[]; raw: number; prob: number }[], tol: number) {
  let maxRaw = 0;
  let maxProb = 0;
  let failures = 0;
  for (const r of rows) {
    const x = r.features.map((v) => (v === null ? NaN : v));
    const dr = Math.abs(model.raw(x) - r.raw);
    const dp = Math.abs(model.predict(x) - r.prob);
    maxRaw = Math.max(maxRaw, dr);
    maxProb = Math.max(maxProb, dp);
    if (!(dr <= tol && dp <= tol)) failures++;
  }
  return { rows: rows.length, maxAbsDiffRaw: maxRaw, maxAbsDiffProb: maxProb, tolerance: tol, failures, ok: failures === 0 && rows.length > 0 };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const get = (f: string) => {
    const i = args.indexOf(f);
    return i >= 0 ? args[i + 1] : undefined;
  };
  if (args[0] !== 'parity' || !get('--model') || !get('--rows')) {
    process.stderr.write('usage: cli.ts parity --model lightgbm.json --rows parity.jsonl [--tol 1e-6]\n');
    process.exit(2);
  }
  const model = new GbdtModel(JSON.parse(readFileSync(get('--model')!, 'utf8')) as LgbModelJson);
  const rows = readFileSync(get('--rows')!, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const res = parity(model, rows, Number(get('--tol') ?? 1e-6));
  process.stdout.write(`${JSON.stringify(res)}\n`);
  process.exitCode = res.ok ? 0 : 1;
}
