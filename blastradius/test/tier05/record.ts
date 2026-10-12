/**
 * Record the Tier 0.5 fixtures ONCE (needs network; never run in tests or CI):
 *   npx tsx test/tier05/record.ts <targets-dir>
 *
 * <targets-dir>/<case>/<dir>/package.json and package-lock.json are the files of the pinned commits
 * (test/tier05/targets.ts), e.g. fetched from raw.githubusercontent.com/<repo>/<commit>/<path>.
 *
 * For each case it keeps a lockfile subset closed under the dependencies of the chosen root entries
 * (entries as npm wrote them), runs the real scan with the OSV, deps.dev and npm enrichers through a
 * recording transport, and writes test/fixtures/tier05/<case>.json.gz:
 *   { note, repo, commit, recordedAt, now, files: { path: text }, http: [envelope, …] }
 * Packuments are slimmed the way the npm enricher slims them (src/enrich/npm/registry.ts), so every
 * field the enricher reads is kept; e-mail addresses are masked and OSV credits dropped.
 * Extra packuments (`EXTRA`) are recorded for single derivations the tests make outside a scan.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { defaultTransport, HttpClient, type Transport } from '../../src/core/http.js';
import { installEnvProxy } from '../../src/core/proxy.js';
import { scan } from '../../src/pipeline.js';
import { createOsvEnricher } from '../../src/enrich/osv/index.js';
import { createDepsDevEnricher } from '../../src/enrich/depsdev/index.js';
import { createNpmEnricher } from '../../src/enrich/npm/index.js';
import { slimPackument } from '../../src/enrich/npm/registry.js';
import { TIER05_CASES, TIER05_NOW } from './targets.js';

await installEnvProxy();
const targets = process.argv[2];
if (!targets) throw new Error('usage: record.ts <targets-dir>');
const OUT = fileURLToPath(new URL('../fixtures/tier05/', import.meta.url));
mkdirSync(OUT, { recursive: true });
const EMPTY_KB = mkdtempSync(join(tmpdir(), 'tier05-kb-'));

/** Extra recordings: packuments read on their own (agent-base: owner evidence; nx: the provenance control). */
const EXTRA: Record<string, string[]> = {
  'parse-server': ['https://registry.npmjs.org/agent-base'],
  'jitsi-meet': [],
  superset: ['https://api.deps.dev/v3/systems/pypi/packages/uvicorn/versions/0.52.0'],
};

type Json = Record<string, unknown>;
const readJson = (p: string): Json => JSON.parse(readFileSync(p, 'utf8')) as Json;

function npmSubset(lock: Json, rootDeps: Record<string, string>, rootDev: Record<string, string>): Json {
  const packages = lock['packages'] as Record<string, Json>;
  const resolveFrom = (fromKey: string, dep: string): string | undefined => {
    let base = fromKey;
    for (let i = 0; i < 64; i++) {
      const candidate = base === '' ? `node_modules/${dep}` : `${base}/node_modules/${dep}`;
      if (packages[candidate]) return candidate;
      if (base === '') return undefined;
      const idx = base.lastIndexOf('/node_modules/');
      base = idx >= 0 ? base.slice(0, idx) : '';
    }
    return undefined;
  };
  const keep = new Set<string>();
  const queue: string[] = [];
  for (const dep of [...Object.keys(rootDeps), ...Object.keys(rootDev)]) {
    const at = resolveFrom('', dep);
    if (!at) throw new Error(`${dep} not in the lockfile`);
    if (!keep.has(at)) (keep.add(at), queue.push(at));
  }
  while (queue.length > 0) {
    const key = queue.pop()!;
    const entry = packages[key]!;
    for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const dep of Object.keys((entry[section] as Record<string, string>) ?? {})) {
        const at = resolveFrom(key, dep);
        if (at && !keep.has(at)) (keep.add(at), queue.push(at));
      }
    }
  }
  const root = packages[''] as Json;
  const out: Record<string, Json> = { '': { name: root['name'], version: root['version'], license: root['license'], dependencies: rootDeps, devDependencies: rootDev } };
  const FIELDS = ['version', 'resolved', 'integrity', 'dev', 'optional', 'devOptional', 'peer', 'license', 'hasInstallScript', 'dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'os', 'cpu'];
  for (const key of [...keep].sort()) {
    const e = packages[key]!;
    const t: Json = {};
    for (const f of FIELDS) if (e[f] !== undefined) t[f] = e[f];
    out[key] = t;
  }
  return { name: lock['name'], version: lock['version'], lockfileVersion: lock['lockfileVersion'], requires: true, packages: out };
}

function pickDeps(pkg: Json, names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of names) {
    const v = (['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const).map((s) => (pkg[s] as Record<string, string> | undefined)?.[n]).find((x) => x !== undefined);
    if (v === undefined) throw new Error(`no ${n} in manifest`);
    out[n] = v;
  }
  return out;
}

function scrub(v: unknown): unknown {
  if (typeof v === 'string') return v.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<e-mail removed>');
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (k !== 'credits' && k !== 'email') out[k] = scrub(x);
    return out;
  }
  return v;
}

for (const c of TIER05_CASES) {
  const files: Record<string, string> = {};
  const keepPackuments = new Set<string>();
  for (const part of c.parts) {
    const src = join(targets, c.id, part.dir);
    const pkg = readJson(join(src, 'package.json'));
    const deps = pickDeps(pkg, part.runtime);
    const dev = pickDeps(pkg, part.dev ?? []);
    const prefix = part.dir ? `${part.dir}/` : '';
    files[`${prefix}package.json`] = `${JSON.stringify({ name: pkg['name'], version: pkg['version'], license: pkg['license'], dependencies: deps, devDependencies: dev }, null, 2)}\n`;
    const lock = readJson(join(src, 'package-lock.json'));
    files[`${prefix}package-lock.json`] = `${JSON.stringify(npmSubset(lock, deps, dev), null, 2)}\n`;
    for (const k of c.packuments) {
      const root = k.startsWith('closure:') ? k.slice('closure:'.length) : undefined;
      if (!root) keepPackuments.add(k);
      else if (deps[root] !== undefined) for (const key of Object.keys((npmSubset(lock, { [root]: deps[root] }, {}) as { packages: Json }).packages)) if (key) keepPackuments.add(key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length));
    }
  }
  const keepUrl = (url: string) => {
    if (!url.startsWith('https://registry.npmjs.org/')) return true;
    const name = decodeURIComponent(url.slice('https://registry.npmjs.org/'.length));
    return keepPackuments.has(name) || EXTRA[c.id]?.includes(url) === true;
  };
  const dir = mkdtempSync(join(tmpdir(), `tier05-${c.id}-`));
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  const calls: { request: { url: string; method: string; body?: unknown }; status: number; response: unknown }[] = [];
  const recording: Transport = async (req) => {
    const res = await defaultTransport(req);
    let response: unknown = res.body;
    try {
      response = JSON.parse(res.body);
    } catch {
      /* text response */
    }
    if (req.url.startsWith('https://registry.npmjs.org/') && res.status === 200 && response && typeof response === 'object') response = slimPackument(response as Record<string, unknown>);
    if (keepUrl(req.url)) calls.push({ request: { url: req.url, method: req.method, ...(req.body !== undefined ? { body: JSON.parse(req.body) } : {}) }, status: res.status, response: scrub(response) });
    return res;
  };
  const http = new HttpClient({ transport: recording, cacheDir: false, offline: false });
  const out = await scan({
    target: dir,
    offline: false,
    now: TIER05_NOW,
    kbDir: EMPTY_KB,
    http,
    enrichers: () => [createOsvEnricher(), createDepsDevEnricher(), createNpmEnricher({ snapshots: false, downloadsApi: false })],
  });
  for (const url of EXTRA[c.id] ?? []) await http.fetchJsonOrNull(url);
  rmSync(dir, { recursive: true, force: true });
  const data = {
    note: `Recorded live ${new Date().toISOString()} by test/tier05/record.ts: ${c.repo} at ${c.commit}, lockfile subset (${c.parts.map((p) => `${p.dir || '.'}: ${[...p.runtime, ...(p.dev ?? [])].join(', ')}`).join('; ')}). Packuments slimmed as the npm enricher slims them; e-mail addresses masked; OSV credits dropped.`,
    repo: c.repo,
    commit: c.commit,
    recordedAt: new Date().toISOString(),
    now: TIER05_NOW.toISOString(),
    files,
    http: calls,
  };
  writeFileSync(join(OUT, `${c.id}.json.gz`), gzipSync(JSON.stringify(data)));
  console.log(`${c.id}: ${out.inventory.components.length} components, ${out.result.findings.length} findings, ${calls.length} recorded calls`);
}
rmSync(EMPTY_KB, { recursive: true, force: true });
