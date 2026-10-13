/**
 * Record the Tier 0 fixtures ONCE (needs network; never run in tests or CI):
 *   npx tsx test/tier0/record.ts <targets-dir>
 *
 * <targets-dir> holds checkouts of the pinned commits (test/tier0/targets.ts):
 *   parse-server 23d7bbca9a6c9bdebdb12d166544375a83ef47fc, jitsi-meet 36d4c1c7945016ecc588338ac0dff82cd060bbbf,
 *   flask d086db856be187255b8ec61ef409357393020f32, superset 42bbfa49079eff910ead01b7880b94d09c5ca520.
 *
 * For each case it writes a trimmed copy of the real manifests (a lockfile subset closed under
 * the dependencies of the chosen root entries, flags and integrity kept as npm / uv wrote them)
 * to test/fixtures/tier0/<case>/repo/, then runs the real enrichers the tests use (OSV, plus
 * licences for the Python cases) over it with a recording transport, and writes every request
 * and response as a fixture envelope to test/fixtures/tier0/<case>/http/. Responses are stored as
 * the services returned them, minus people's details nothing reads (OSV credits, ClearlyDefined
 * attribution) and with e-mail addresses masked.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultTransport, HttpClient, type Transport } from '../../src/core/http.js';
import { installEnvProxy } from '../../src/core/proxy.js';
import type { Enricher } from '../../src/core/plugin.js';
import { ingestDetailed } from '../../src/ingest/index.js';
import { createOsvEnricher } from '../../src/enrich/osv/index.js';
import { createLicenseEnricher } from '../../src/enrich/licenses/index.js';
import { TIER0_CASES, TIER0_NOW, type Tier0Case } from './targets.js';

await installEnvProxy();
const targets = process.argv[2];
if (!targets) throw new Error('usage: record.ts <targets-dir>');
const FIX = fileURLToPath(new URL('../fixtures/tier0/', import.meta.url));

type Json = Record<string, unknown>;
const readJson = (p: string): Json => JSON.parse(readFileSync(p, 'utf8')) as Json;
const write = (p: string, data: string): void => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
};

/** Close a lockfile v3 `packages` map under the dependencies of the given root entries (npm resolution). */
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
    if (at && !keep.has(at)) (keep.add(at), queue.push(at));
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
  const out: Record<string, Json> = {
    '': { name: root['name'], version: root['version'], license: root['license'], dependencies: rootDeps, devDependencies: rootDev },
  };
  const FIELDS = ['version', 'resolved', 'integrity', 'dev', 'optional', 'devOptional', 'peer', 'license', 'hasInstallScript', 'dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'os', 'cpu'];
  for (const key of [...keep].sort()) {
    const e = packages[key]!;
    const t: Json = {};
    for (const f of FIELDS) if (e[f] !== undefined) t[f] = e[f];
    out[key] = t;
  }
  return { name: lock['name'], version: lock['version'], lockfileVersion: lock['lockfileVersion'], requires: true, packages: out };
}

function pick(obj: Record<string, string>, names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of names) {
    if (obj[n] === undefined) throw new Error(`no ${n} in manifest`);
    out[n] = obj[n]!;
  }
  return out;
}

/** uv.lock: keep the root project and the packages reachable from the chosen groups (text blocks kept verbatim). */
function uvSubset(text: string, keepNames: ReadonlySet<string>): string {
  const blocks = text.split(/\n(?=\[\[package\]\]\n)/);
  return (
    blocks
      .filter((b, i) => {
        if (i === 0) return true; // header (version, requires-python, resolution-markers)
        const name = /^name = "([^"]+)"/m.exec(b)?.[1];
        return name !== undefined && keepNames.has(name);
      })
      .join('\n')
      .trimEnd() + '\n'
  );
}

/**
 * Privacy: drop people's details the enrichers never read (OSV `credits`, ClearlyDefined
 * `attribution` parties) and mask any e-mail address left in a string.
 */
function scrub(v: unknown): unknown {
  if (typeof v === 'string') return v.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<e-mail removed>');
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (k !== 'credits' && k !== 'attribution') out[k] = scrub(x);
    return out;
  }
  return v;
}

async function record(c: Tier0Case, enrichers: Enricher[]): Promise<void> {
  const repoDir = join(FIX, c.id, 'repo');
  const httpDir = join(FIX, c.id, 'http');
  rmSync(httpDir, { recursive: true, force: true });
  const ing = await ingestDetailed(repoDir);
  const calls: { request: { url: string; method: string; body?: unknown }; status: number; response: unknown }[] = [];
  const recording: Transport = async (req) => {
    const res = await defaultTransport(req);
    let response: unknown = res.body;
    try {
      response = JSON.parse(res.body);
    } catch {
      /* text response */
    }
    calls.push({ request: { url: req.url, method: req.method, ...(req.body !== undefined ? { body: JSON.parse(req.body) } : {}) }, status: res.status, response: scrub(response) });
    return res;
  };
  const http = new HttpClient({ transport: recording, cacheDir: false, offline: false });
  const warnings: string[] = [];
  for (const e of enrichers) await e.enrich(ing.inventory, { http, now: TIER0_NOW, offline: false, warn: (m) => warnings.push(m) });
  calls.forEach((call, i) => write(join(httpDir, `${String(i).padStart(4, '0')}.json`), `${JSON.stringify(call)}\n`));
  console.log(`${c.id}: ${ing.inventory.components.length} components, ${calls.length} recorded calls${warnings.length ? `; warnings: ${warnings.join(' | ')}` : ''}`);
}

for (const c of TIER0_CASES) {
  const src = join(targets, c.target);
  const repo = join(FIX, c.id, 'repo');
  rmSync(repo, { recursive: true, force: true });
  if (c.id === 'parse-server') {
    const pkg = readJson(join(src, 'package.json'));
    const deps = pick(pkg['dependencies'] as Record<string, string>, c.npmRuntime!);
    const dev = pick(pkg['devDependencies'] as Record<string, string>, c.npmDev!);
    write(join(repo, 'package.json'), `${JSON.stringify({ name: pkg['name'], version: pkg['version'], license: pkg['license'], dependencies: deps, devDependencies: dev }, null, 2)}\n`);
    write(join(repo, 'package-lock.json'), `${JSON.stringify(npmSubset(readJson(join(src, 'package-lock.json')), deps, dev), null, 2)}\n`);
    await record(c, [createOsvEnricher()]);
  } else if (c.id === 'jitsi-meet') {
    const pkg = readJson(join(src, 'package.json'));
    const deps = pick(pkg['dependencies'] as Record<string, string>, c.npmRuntime!);
    write(join(repo, 'package.json'), `${JSON.stringify({ name: pkg['name'], version: pkg['version'], license: pkg['license'], dependencies: deps }, null, 2)}\n`);
    write(join(repo, 'package-lock.json'), `${JSON.stringify(npmSubset(readJson(join(src, 'package-lock.json')), deps, {}), null, 2)}\n`);
    // The SDK manifest as committed (no lockfile, 0.0.0 placeholders), trimmed to some entries.
    const sdk = readJson(join(src, 'react-native-sdk', 'package.json'));
    const sdkDeps = pick(sdk['dependencies'] as Record<string, string>, c.sdkEntries!);
    const sdkPeers = pick(sdk['peerDependencies'] as Record<string, string>, Object.keys(sdk['peerDependencies'] as Record<string, string>).slice(0, 3));
    write(join(repo, 'react-native-sdk', 'package.json'), `${JSON.stringify({ name: sdk['name'], version: sdk['version'], dependencies: sdkDeps, peerDependencies: sdkPeers }, null, 2)}\n`);
    // Manifests of ecosystems we do not analyse, as committed: they must be reported, never dropped.
    for (const f of ['Gemfile', 'Gemfile.lock', 'android/app/build.gradle']) write(join(repo, f), readFileSync(join(src, f), 'utf8'));
    await record(c, [createOsvEnricher()]);
  } else if (c.id === 'flask') {
    write(join(repo, 'pyproject.toml'), readFileSync(join(src, 'pyproject.toml'), 'utf8'));
    write(join(repo, 'uv.lock'), uvSubset(readFileSync(join(src, 'uv.lock'), 'utf8'), new Set(c.uvPackages!)));
    await record(c, [createOsvEnricher(), createLicenseEnricher()]);
  } else if (c.id === 'superset') {
    // requirements/base.txt lines for the chosen packages, with their `# via` comments, as compiled.
    const lines = readFileSync(join(src, 'requirements', 'base.txt'), 'utf8').split('\n');
    const out: string[] = lines.slice(0, 2);
    let keep = false;
    for (const l of lines.slice(2)) {
      const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)==/.exec(l);
      if (m) keep = c.requirements!.includes(m[1]!.toLowerCase());
      else if (/^\S/.test(l)) keep = false;
      if (keep) out.push(l);
    }
    write(join(repo, 'requirements', 'base.txt'), `${out.join('\n')}\n`);
    await record(c, [createOsvEnricher(), createLicenseEnricher()]);
  }
}
