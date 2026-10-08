/**
 * Re-record the feeds fixture (a trimmed slice of real data) from downloaded sources:
 *
 *   curl -o /tmp/f/npm-all.zip https://osv-vulnerabilities.storage.googleapis.com/npm/all.zip
 *   curl -o /tmp/f/modified_id.csv https://osv-vulnerabilities.storage.googleapis.com/npm/modified_id.csv
 *   curl -o /tmp/f/dd.json https://raw.githubusercontent.com/DataDog/malicious-software-packages-dataset/main/samples/npm/manifest.json
 *   curl -o /tmp/f/bkc.json https://raw.githubusercontent.com/dasfreak/Backstabbers-Knife-Collection/master/data/packages.json
 *   tsx test/fixtures/feeds/record.ts /tmp/f <day YYYY-MM-DD> <datadog commit> <datadog date> <bkc commit> <bkc date>
 *
 * Keeps every MAL-* row of the day, a few (non-malware) GHSA rows of that day, and a fixed set of
 * older records the tests rely on. E-mail addresses are replaced with redacted@example.invalid. The CSV is cut at the end of the day (newest first, as published).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipEntries, zipRead } from '../../../src/feeds/zip.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const [src, day, ddCommit, ddDate, bkcCommit, bkcDate] = process.argv.slice(2) as [string, string, string, string, string, string];
const BASE = ['MAL-2025-5016', 'MAL-2026-3744', 'MAL-2025-46969', 'MAL-2025-6983', 'MAL-2024-1398', 'MAL-2023-462', 'GHSA-mh6f-8j2x-4483', 'GHSA-7wgh-5q4q-6wx5', 'GHSA-97m3-w2cp-4xx6'];
const GHSA_PER_DAY = 6;

const rows = readFileSync(join(src, 'modified_id.csv'), 'utf8').trim().split('\n');
const end = `${day}T23:59:59.999999999Z`;
let ghsa = 0;
const keep = rows.filter((r) => {
  const [ts, id] = r.split(',') as [string, string];
  if (ts > end) return false;
  if (ts.startsWith(day)) return id.startsWith('MAL-') || (id.startsWith('GHSA-') && ghsa++ < GHSA_PER_DAY);
  return BASE.includes(id);
});
const ids = new Set(keep.map((r) => r.split(',')[1]!));
const zip = readFileSync(join(src, 'npm-all.zip'));
const out = join(HERE, 'osv', 'npm');
mkdirSync(out, { recursive: true });
const names = new Set<string>();
for (const e of zipEntries(zip)) {
  const id = e.name.replace(/\.json$/, '');
  if (!ids.has(id)) continue;
  // Data minimisation (PLAN §7): no real e-mail addresses in committed fixtures.
  const text = zipRead(zip, e)!.toString('utf8').replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g, 'redacted@example.invalid');
  const rec = JSON.parse(text) as { affected?: { package?: { name?: string } }[] };
  for (const a of rec.affected ?? []) if (a.package?.name) names.add(a.package.name);
  writeFileSync(join(out, e.name), `${JSON.stringify(rec, null, 1)}\n`);
}
writeFileSync(join(out, 'modified_id.csv'), `${keep.join('\n')}\n`);

// Dataset slices: entries for the fixture's packages plus a few well-known ones.
const extra = ['chalk', 'debug', 'node-ipc', 'event-stream', '02-echo', '000webhost-admin', '0h'];
const dd = JSON.parse(readFileSync(join(src, 'dd.json'), 'utf8')) as Record<string, unknown>;
const ddOut = Object.fromEntries(Object.entries(dd).filter(([n]) => names.has(n) || extra.includes(n)));
const ddDir = join(HERE, 'git', 'DataDog__malicious-software-packages-dataset');
mkdirSync(join(ddDir, 'samples', 'npm'), { recursive: true });
writeFileSync(join(ddDir, 'samples', 'npm', 'manifest.json'), `${JSON.stringify(ddOut, null, 4)}\n`);
writeFileSync(join(ddDir, 'HEAD.json'), `${JSON.stringify({ commit: ddCommit, date: ddDate })}\n`);
const bkc = JSON.parse(readFileSync(join(src, 'bkc.json'), 'utf8')) as Record<string, string[]>;
const bkcOut = { npm: bkc.npm!.filter((n) => names.has(n) || extra.includes(n)), pypi: bkc.pypi!.slice(0, 3) };
const bkcDir = join(HERE, 'git', 'dasfreak__Backstabbers-Knife-Collection');
mkdirSync(join(bkcDir, 'data'), { recursive: true });
writeFileSync(join(bkcDir, 'data', 'packages.json'), `${JSON.stringify(bkcOut)}\n`);
writeFileSync(join(bkcDir, 'HEAD.json'), `${JSON.stringify({ commit: bkcCommit, date: bkcDate })}\n`);
console.log(`${keep.length} CSV rows, ${ids.size} records, ${Object.keys(ddOut).length} Datadog entries, ${bkcOut.npm.length} BKC npm names`);
