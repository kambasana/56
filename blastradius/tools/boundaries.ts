/**
 * Boundary ratchet (docs/ARCHITECTURE.md §2.5; docs/REFACTOR.md "Ratchet"). Runs after
 * `depcruise --validate --ignore-known` (which fails on new file-level violations) and adds:
 *   1. shrink-only: a known violation that no longer occurs must be removed from
 *      .dependency-cruiser-known-violations.json (`npm run boundaries:baseline`) in the same PR;
 *   2. module-level cycles (§1.2/§1.3 count cycles between top-level modules, e.g. core ↔ enrich/npm,
 *      which a file-level no-circular rule does not see) against .boundaries-known.json;
 *   3. fetch(): network calls only in core/http (a grep: dependency-cruiser sees imports, not globals),
 *      against .boundaries-known.json;
 *   4. with --against <dir>: the known lists of a base checkout (CI: main); an entry that is not in
 *      the base list is growth and fails. Skipped when the base has no lists yet.
 *
 *   tsx tools/boundaries.ts              check (CI)
 *   tsx tools/boundaries.ts --update     drop stale entries from .boundaries-known.json (never adds)
 *   tsx tools/boundaries.ts --init       write .boundaries-known.json from scratch (stage 0 only)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEPCRUISE_KNOWN = '.dependency-cruiser-known-violations.json';
const OWN_KNOWN = '.boundaries-known.json';

interface DepcruiseViolation {
  type: string;
  from: string;
  to: string;
  rule: { name: string; severity: string };
  cycle?: { name: string }[] | string[];
}

interface OwnKnown {
  _note: string;
  moduleCycles: string[];
  fetch: string[];
}

function depcruiseJson(): { modules: { source: string; dependencies: { resolved: string; coreModule?: boolean; couldNotResolve?: boolean }[] }[]; summary: { violations: DepcruiseViolation[] } } {
  const bin = path.join(ROOT, 'node_modules', '.bin', 'depcruise');
  const out = execFileSync(bin, ['src', 'web/src', '--config', '.dependency-cruiser.cjs', '--output-type', 'json'], { cwd: ROOT, maxBuffer: 256 * 1024 * 1024, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return JSON.parse(out);
}

/** A stable identity for a depcruise violation (the fields --ignore-known matches on). */
function violationKey(v: DepcruiseViolation): string {
  const cycle = v.cycle ? ` [${v.cycle.map((c) => (typeof c === 'string' ? c : c.name)).join(' → ')}]` : '';
  return `${v.rule.name}: ${v.from} → ${v.to}${cycle}`;
}

/** Top-level module of a source file: enrich/<x>, <dir>, or root (cli, pipeline, summary). */
export function moduleOf(file: string): string | undefined {
  const m = file.match(/^src\/(?:(enrich)\/([^/]+)\/|([^/]+)\/)?/);
  if (!m) return undefined;
  if (m[1]) return `enrich/${m[2]}`;
  return m[3] ?? 'root';
}

/** Cycles between top-level modules: for every module edge a → b, the shortest way back b ⇝ a. */
export function moduleCycles(edges: Map<string, Set<string>>): string[] {
  const cycles = new Set<string>();
  for (const [a, outs] of edges) {
    for (const b of outs) {
      // BFS from b back to a.
      const prev = new Map<string, string>([[b, '']]);
      const queue = [b];
      while (queue.length > 0 && !prev.has(a)) {
        const x = queue.shift()!;
        for (const y of [...(edges.get(x) ?? [])].sort()) {
          if (prev.has(y)) continue;
          prev.set(y, x);
          queue.push(y);
        }
      }
      if (!prev.has(a)) continue;
      const pathBack: string[] = [];
      for (let x = a; x !== b; x = prev.get(x)!) pathBack.unshift(x);
      const cycle = [b, ...pathBack]; // b → … → a (→ b)
      const i = cycle.indexOf([...cycle].sort()[0]!);
      const rotated = [...cycle.slice(i), ...cycle.slice(0, i)];
      cycles.add([...rotated, rotated[0]].join(' → '));
    }
  }
  return [...cycles].sort();
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(rel));
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(rel);
  }
  return out;
}

/** Production files that call fetch() outside core/http (comments stripped; `//` after `:` is a URL). */
export function fetchCallers(files: { file: string; text: string }[]): string[] {
  const allowed = /^src\/core\/(http\.ts$|http\/)/;
  const out: string[] = [];
  for (const { file, text } of files) {
    if (allowed.test(file)) continue;
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
    if (/(?<![\w$.])fetch\s*\(|\b(globalThis|window|self)\s*\.\s*fetch\b/.test(code)) out.push(`no-fetch-outside-core-http: ${file}`);
  }
  return out.sort();
}

function readJson<T>(file: string): T | undefined {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : undefined;
}

function main(argv: string[]): number {
  const t0 = Date.now();
  const graph = depcruiseJson();
  const current = new Set(graph.summary.violations.map(violationKey));
  const known = (readJson<DepcruiseViolation[]>(path.join(ROOT, DEPCRUISE_KNOWN)) ?? []).map(violationKey);

  const edges = new Map<string, Set<string>>();
  for (const m of graph.modules) {
    const a = moduleOf(m.source);
    if (!a) continue;
    for (const d of m.dependencies) {
      const b = d.coreModule || d.couldNotResolve ? undefined : moduleOf(d.resolved);
      if (!b || b === a) continue;
      if (!edges.has(a)) edges.set(a, new Set());
      edges.get(a)!.add(b);
    }
  }
  const cycles = moduleCycles(edges).map((c) => `module-cycle: ${c}`);
  const fetches = fetchCallers(listFiles('src').map((file) => ({ file, text: readFileSync(path.join(ROOT, file), 'utf8') })));
  const own: OwnKnown = { _note: 'Known module-level cycles and fetch() callers (tools/boundaries.ts). This list may only shrink: docs/REFACTOR.md.', moduleCycles: cycles, fetch: fetches };

  if (argv.includes('--init')) {
    writeFileSync(path.join(ROOT, OWN_KNOWN), `${JSON.stringify(own, null, 2)}\n`);
    console.log(`boundaries: wrote ${OWN_KNOWN} (${cycles.length} module cycle(s), ${fetches.length} fetch caller(s))`);
    return 0;
  }
  const ownKnown = readJson<OwnKnown>(path.join(ROOT, OWN_KNOWN)) ?? { _note: own._note, moduleCycles: [], fetch: [] };
  const problems: string[] = [];
  const compare = (label: string, now: readonly string[], list: readonly string[], file: string) => {
    const nowSet = new Set(now);
    const listSet = new Set(list);
    for (const v of now) if (!listSet.has(v)) problems.push(`NEW ${label}: ${v}`);
    for (const v of list) if (!nowSet.has(v)) problems.push(`FIXED (remove from ${file}): ${v}`);
  };
  compare('violation', [...current], known, `${DEPCRUISE_KNOWN}: npm run boundaries:baseline`);
  compare('module cycle', cycles, ownKnown.moduleCycles, `${OWN_KNOWN}: npm run boundaries:update`);
  compare('fetch caller', fetches, ownKnown.fetch, `${OWN_KNOWN}: npm run boundaries:update`);

  if (argv.includes('--update')) {
    // Shrink only: keep the known entries that still occur, never add the new ones.
    const keep = (list: readonly string[], now: readonly string[]) => list.filter((v) => now.includes(v));
    writeFileSync(path.join(ROOT, OWN_KNOWN), `${JSON.stringify({ ...ownKnown, moduleCycles: keep(ownKnown.moduleCycles, cycles), fetch: keep(ownKnown.fetch, fetches) }, null, 2)}\n`);
    console.log(`boundaries: ${OWN_KNOWN} updated (stale entries dropped)`);
    return 0;
  }

  const against = argv[argv.indexOf('--against') + 1];
  if (argv.includes('--against') && against) {
    const baseDepcruise = readJson<DepcruiseViolation[]>(path.join(against, DEPCRUISE_KNOWN));
    const baseOwn = readJson<OwnKnown>(path.join(against, OWN_KNOWN));
    if (!baseDepcruise || !baseOwn) console.log(`boundaries: ${against} has no known-violation lists yet; growth check skipped`);
    else {
      const grew = (list: readonly string[], base: readonly string[]) => list.filter((v) => !base.includes(v));
      for (const v of grew(known, baseDepcruise.map(violationKey))) problems.push(`GROWTH (known list may only shrink): ${v}`);
      for (const v of grew([...ownKnown.moduleCycles, ...ownKnown.fetch], [...baseOwn.moduleCycles, ...baseOwn.fetch])) problems.push(`GROWTH (known list may only shrink): ${v}`);
    }
  }

  for (const p of problems) console.log(p);
  const total = known.length + ownKnown.moduleCycles.length + ownKnown.fetch.length;
  console.log(`boundaries: ${problems.length === 0 ? 'ok' : 'FAILED'}: ${known.length} known file-level violation(s), ${ownKnown.moduleCycles.length} module cycle(s), ${ownKnown.fetch.length} fetch caller(s) (${total} known in all) in ${Date.now() - t0} ms`);
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
