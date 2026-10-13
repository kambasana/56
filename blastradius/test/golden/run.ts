/**
 * Golden-output harness (docs/ARCHITECTURE.md §4, stage 0; docs/REFACTOR.md).
 *
 *   npm run golden:check     replay every case, diff against snapshots/, fail on any undeclared diff
 *   npm run golden:update    rewrite snapshots/ (intentional output changes only; declare them first)
 *   tsx test/golden/run.ts --determinism   two plain runs + two shuffled input orders must be identical
 *
 * Each case is replayed offline through the real scan() with the default plugin set (no injected
 * enrichers), the bundled incident KB, and all five report formats written by the pipeline itself.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { ALL_OUTPUT_FORMATS, scan } from '../../src/pipeline.js';
import { REPORT_FILENAMES } from '../../src/report/index.js';
import { CASE_IDS, loadCase } from './cases.js';
import { loadDeclared, type Declared } from './declared.js';
import { diffJson, diffLines, formatEntry, type DiffEntry } from './diff.js';
import { FORMATS, normaliseHtml, normaliseJson, type Format, type Json } from './normalise.js';

export const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/', import.meta.url));

/** caseId → format → normalised output (JSON value, or text for html). */
export type GoldenOutputs = Record<string, Record<Format, Json>>;

/** Environment that would change a scan's answer; cleared so local shells and CI agree. */
const SCAN_ENV = ['BLASTRADIUS_PACK', 'BLASTRADIUS_FIXTURES', 'GITHUB_TOKEN', 'OPENCOLLECTIVE_API_KEY', 'ANTHROPIC_API_KEY'];

/** Deterministic shuffle (mulberry32); seed 0 = keep the order. */
export function shuffler(seed: number): <T>(xs: T[]) => T[] {
  let s = seed >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return <T>(xs: T[]): T[] => {
    if (seed === 0) return xs;
    for (let i = xs.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [xs[i], xs[j]] = [xs[j]!, xs[i]!];
    }
    return xs;
  };
}

/**
 * Replay every case and return the normalised outputs. `seed` ≠ 0 shuffles the input order: the
 * case order, the order manifests are written in, and the order of the recorded HTTP responses.
 */
export async function runGolden(opts: { seed?: number; cases?: readonly string[] } = {}): Promise<GoldenOutputs> {
  const shuffle = shuffler(opts.seed ?? 0);
  const saved = Object.fromEntries(SCAN_ENV.map((k) => [k, process.env[k]]));
  for (const k of SCAN_ENV) delete process.env[k];
  const root = mkdtempSync(path.join(tmpdir(), 'golden-'));
  const outputs: GoldenOutputs = {};
  try {
    for (const id of shuffle([...(opts.cases ?? CASE_IDS)])) {
      const c = loadCase(id as (typeof CASE_IDS)[number]);
      const target = path.join(root, 'targets', c.id);
      for (const [rel, text] of shuffle([...c.files])) {
        mkdirSync(path.dirname(path.join(target, rel)), { recursive: true });
        writeFileSync(path.join(target, rel), text);
      }
      const outDir = path.join(root, 'out', c.id);
      await scan({ target, offline: true, cacheDir: false, now: c.now, http: c.http(shuffle), outDir, formats: [...ALL_OUTPUT_FORMATS] });
      const byFormat = {} as Record<Format, Json>;
      for (const f of FORMATS) {
        const text = readFileSync(path.join(outDir, REPORT_FILENAMES[f]), 'utf8');
        byFormat[f] = f === 'html' ? normaliseHtml(text, target) : normaliseJson(f, text, target);
      }
      outputs[c.id] = byFormat;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  }
  // Report in a fixed case order whatever the run order was.
  return Object.fromEntries(Object.keys(outputs).sort().map((k) => [k, outputs[k]!]));
}

function snapshotFile(id: string, f: Format): string {
  return path.join(SNAPSHOT_DIR, id, `${f}.${f === 'html' ? 'html' : 'json'}.gz`);
}

function serialise(f: Format, v: Json): string {
  return f === 'html' ? (v as string) : `${JSON.stringify(v, null, 1)}\n`;
}

export function writeSnapshots(outputs: GoldenOutputs): { file: string; bytes: number }[] {
  const written: { file: string; bytes: number }[] = [];
  for (const [id, byFormat] of Object.entries(outputs)) {
    mkdirSync(path.join(SNAPSHOT_DIR, id), { recursive: true });
    for (const f of FORMATS) {
      // gzip without a file name or mtime in the header: the bytes depend on the content only.
      const gz = gzipSync(serialise(f, byFormat[f]), { level: 9 });
      writeFileSync(snapshotFile(id, f), gz);
      written.push({ file: path.relative(SNAPSHOT_DIR, snapshotFile(id, f)), bytes: gz.length });
    }
  }
  return written;
}

export function readSnapshot(id: string, f: Format): Json | undefined {
  let buf: Buffer;
  try {
    buf = readFileSync(snapshotFile(id, f));
  } catch {
    return undefined;
  }
  const text = gunzipSync(buf).toString('utf8');
  return f === 'html' ? text : (JSON.parse(text) as Json);
}

export interface GoldenDiff {
  scope: string;
  entry: DiffEntry;
  declared?: Declared;
}

export function diffOutputs(before: GoldenOutputs, after: GoldenOutputs, declared: Declared[] = []): GoldenDiff[] {
  const out: GoldenDiff[] = [];
  for (const id of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    for (const f of FORMATS) {
      const a = before[id]?.[f];
      const b = after[id]?.[f];
      const scope = `${id}/${f}`;
      let entries: DiffEntry[];
      if (a === undefined && b === undefined) continue;
      if (a === undefined) entries = [{ path: '$', kind: 'added', after: '(new snapshot)' }];
      else if (b === undefined) entries = [{ path: '$', kind: 'removed', before: '(snapshot without output)' }];
      else entries = f === 'html' ? diffLines(a as string, b as string) : diffJson(a, b);
      for (const entry of entries) {
        const d = declared.find((x) => x.match(scope, entry.path));
        out.push({ scope, entry, ...(d ? { declared: d } : {}) });
      }
    }
  }
  return out;
}

export function loadSnapshots(ids: readonly string[] = CASE_IDS): GoldenOutputs {
  const out: GoldenOutputs = {};
  for (const id of ids) {
    const byFormat = {} as Record<Format, Json>;
    let any = false;
    for (const f of FORMATS) {
      const v = readSnapshot(id, f);
      if (v !== undefined) {
        byFormat[f] = v;
        any = true;
      }
    }
    if (any) out[id] = byFormat;
  }
  return out;
}

export function printDiffs(diffs: GoldenDiff[], limit = 200): string {
  const undeclared = diffs.filter((d) => !d.declared);
  const lines = undeclared.slice(0, limit).map((d) => formatEntry(d.scope, d.entry));
  if (undeclared.length > limit) lines.push(`… ${undeclared.length - limit} more undeclared difference(s)`);
  const declared = diffs.length - undeclared.length;
  if (declared > 0) lines.push(`(${declared} declared difference(s) allowed by DECLARED.md)`);
  return lines.join('\n');
}

async function main(argv: string[]): Promise<number> {
  const t0 = Date.now();
  if (argv.includes('--update')) {
    const written = writeSnapshots(await runGolden());
    for (const w of written) console.log(`  ${w.file}  ${(w.bytes / 1024).toFixed(1)} KiB`);
    console.log(`golden: ${written.length} snapshot(s) written to test/golden/snapshots in ${Date.now() - t0} ms; declare every intended change in test/golden/DECLARED.md`);
    return 0;
  }
  if (argv.includes('--determinism')) {
    const base = await runGolden();
    let bad = 0;
    for (const [label, seed] of [['second run', 0], ['shuffled input order #1', 0x5eed1], ['shuffled input order #2', 0xc0ffee]] as const) {
      const d = diffOutputs(base, await runGolden({ seed }));
      console.log(`golden determinism: ${label}: ${d.length} difference(s)`);
      if (d.length > 0) console.log(printDiffs(d, 50));
      bad += d.length;
    }
    console.log(`golden determinism: ${bad === 0 ? 'ok' : 'FAILED'} in ${Date.now() - t0} ms`);
    return bad === 0 ? 0 : 1;
  }
  const diffs = diffOutputs(loadSnapshots(), await runGolden(), loadDeclared());
  const undeclared = diffs.filter((d) => !d.declared).length;
  if (diffs.length > 0) console.log(printDiffs(diffs));
  console.log(`golden: ${undeclared === 0 ? 'ok' : 'FAILED'}: ${undeclared} undeclared, ${diffs.length - undeclared} declared difference(s) across ${CASE_IDS.length} case(s) × ${FORMATS.length} format(s) in ${Date.now() - t0} ms`);
  if (undeclared > 0) console.log('golden: if the change is intended, declare it in test/golden/DECLARED.md and run `npm run golden:update` (docs/REFACTOR.md).');
  return undeclared === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
