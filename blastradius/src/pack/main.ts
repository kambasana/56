/**
 * Bootstrap: build the knowledge pack from downloaded sources.
 *   tsx src/pack/main.ts --osv-dir <dir of OSV npm JSON> --attack-data <supplychain-attack-data checkout> --out pack.json.gz
 * The pack workflow (pack/ci/pack.yml) downloads the sources and runs this once.
 */
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { emptyPack, finishPack, readAttackData, readOsvDir } from './build.js';
import type { PackSource } from './types.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const osvDir = arg('--osv-dir');
const attack = arg('--attack-data');
const out = arg('--out') ?? 'pack.json.gz';
const snapshot = arg('--snapshot') ?? new Date().toISOString().slice(0, 10);
if (!osvDir && !attack) {
  console.error('usage: main.ts --osv-dir <dir> --attack-data <dir> [--out pack.json.gz] [--snapshot YYYY-MM-DD]');
  process.exit(2);
}
const pack = emptyPack(new Date().toISOString());
const sources: PackSource[] = [];
if (osvDir) {
  const n = await readOsvDir(osvDir, pack.malware);
  sources.push({ name: 'OSV npm export (MAL-* and CWE-506 GitHub advisories)', url: 'https://storage.googleapis.com/osv-vulnerabilities/npm/all.zip', licence: 'CC-BY-4.0 / Apache-2.0 (per record source)', snapshot, records: n });
}
if (attack) {
  pack.incidents = await readAttackData(attack, 'https://github.com/tstromberg/supplychain-attack-data');
  sources.push({ name: 'tstromberg/supplychain-attack-data', url: 'https://github.com/tstromberg/supplychain-attack-data', licence: 'Apache-2.0', snapshot, records: pack.incidents.length });
}
finishPack(pack, sources);
const bytes = gzipSync(Buffer.from(JSON.stringify(pack)), { level: 9 });
await writeFile(out, bytes);
const sha = createHash('sha256').update(bytes).digest('hex');
await writeFile(`${out}.sha256`, `${sha}  ${out.split('/').pop()}\n`);
console.log(JSON.stringify({ out, bytes: bytes.length, sha256: sha, counts: pack.counts, sources }, null, 2));
