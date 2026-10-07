/**
 * Features CLI: the bootstrap's only way to compute features, so training rows and scan-time
 * vectors come from the same code (docs/DATA-ML.md §2.4).
 *
 *   tsx src/features/cli.ts schema
 *       → {"schema": "...", "names": [...]}
 *   tsx src/features/cli.ts releases --cache DIR [--overlay DIR] --names FILE [--offset-ms 3600000] [--until ISO]
 *       → one row per release of every listed package, as of release + offset
 *   tsx src/features/cli.ts rows --cache DIR [--overlay DIR] < requests.jsonl
 *       → one row per request {"name","version","asOf", ...extra fields copied through}
 *
 * Rows are JSONL: {name, version, releasedAt, asOf, origin, features: [...]} with null for NaN.
 * Packuments come from disk only (see store.ts); nothing here touches the network.
 */
import { createReadStream, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { isObject } from '../enrich/npm/registry.js';
import { featureArray, FEATURE_NAMES, FEATURE_SCHEMA, featuresAsOf } from './asof.js';
import { openStore, type PackumentStore } from './store.js';

function arg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function row(store: PackumentStore, name: string, version: string, asOf: Date, extra: Record<string, unknown> = {}): string | undefined {
  const p = store.get(name);
  if (!p) return undefined;
  const t = isObject(p.time) ? p.time[version] : undefined;
  const f = featuresAsOf(p, name, version, asOf, { firstPublished: (d) => store.firstPublished(d, asOf.getTime()) });
  if (!f) return undefined;
  return JSON.stringify({
    ...extra,
    name,
    version,
    releasedAt: typeof t === 'string' ? t : null,
    asOf: asOf.toISOString(),
    origin: store.origin(name),
    features: featureArray(f).map((x) => (Number.isFinite(x) ? x : null)),
  });
}

export async function main(argv: string[], out: (line: string) => void, err: (line: string) => void): Promise<number> {
  const [cmd, ...args] = argv;
  if (cmd === 'schema') {
    out(JSON.stringify({ schema: FEATURE_SCHEMA, names: FEATURE_NAMES }));
    return 0;
  }
  const cacheDir = arg(args, '--cache');
  const overlayDir = arg(args, '--overlay');
  if (!cacheDir && !overlayDir) {
    err('need --cache DIR and/or --overlay DIR');
    return 2;
  }
  const store = openStore({ ...(cacheDir ? { cacheDir } : {}), ...(overlayDir ? { overlayDir } : {}) });
  let missing = 0;
  if (cmd === 'releases') {
    const namesFile = arg(args, '--names');
    if (!namesFile) {
      err('need --names FILE');
      return 2;
    }
    const offset = Number(arg(args, '--offset-ms') ?? 3_600_000);
    const until = Date.parse(arg(args, '--until') ?? '2100-01-01T00:00:00Z');
    const names = readFileSync(namesFile, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
    for (const name of names) {
      const p = store.get(name);
      if (!p) {
        missing++;
        continue;
      }
      const time = isObject(p.time) ? p.time : {};
      const versions = isObject(p.versions) ? p.versions : {};
      for (const v of Object.keys(versions).sort()) {
        const t = typeof time[v] === 'string' ? Date.parse(time[v]) : NaN;
        if (!Number.isFinite(t) || t + offset > until) continue;
        const line = row(store, name, v, new Date(t + offset));
        if (line) out(line);
      }
    }
  } else if (cmd === 'rows') {
    const rl = createInterface({ input: arg(args, '--requests') ? createReadStream(arg(args, '--requests')!) : process.stdin, crlfDelay: Infinity });
    for await (const raw of rl) {
      if (!raw.trim()) continue;
      const req = JSON.parse(raw) as Record<string, unknown>;
      const name = typeof req.name === 'string' ? req.name : '';
      const version = typeof req.version === 'string' ? req.version : '';
      const asOf = new Date(typeof req.asOf === 'string' ? req.asOf : NaN);
      const line = name && version && Number.isFinite(asOf.getTime()) ? row(store, name, version, asOf, req) : undefined;
      if (line) out(line);
      else {
        missing++;
        out(JSON.stringify({ ...req, features: null, dropped: store.get(name) ? 'release not visible at asOf' : 'no packument' }));
      }
    }
  } else {
    err('usage: cli.ts schema | releases --cache DIR [--overlay DIR] --names FILE | rows --cache DIR [--overlay DIR] < requests.jsonl');
    return 2;
  }
  if (missing) err(`${missing} package(s)/request(s) without a usable packument`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const code = await main(process.argv.slice(2), (l) => process.stdout.write(`${l}\n`), (l) => process.stderr.write(`${l}\n`));
  process.exitCode = code;
}
