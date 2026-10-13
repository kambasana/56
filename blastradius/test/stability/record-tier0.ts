/**
 * Record the Tier 0 "Ended" fixture ONCE (needs network; never run in tests or CI):
 *   npx tsx test/stability/record-tier0.ts <scans dir>
 *
 * Input: real `blastradius scan --history` outputs (<scans dir>/<repo>/blastradius.json) of
 * parse-server, jitsi-meet and superset at the pinned commits of the teardown (Tier 0, problem 3).
 * For every production package one of them labelled `fragile_ended_production`, records:
 *   - the npm packument trimmed as record.ts does (no e-mail addresses), with `repository` for the
 *     versions in use and the latest release (the moved-repo check reads both);
 *   - sizes, declared dependencies and OSV advisories of the versions in use (record.ts --augment);
 *   - the deps.dev project (Scorecard Maintained check) of the repository the version in use
 *     declares (what the deps.dev enricher looks up) and of the one the latest release declares.
 * Output: test/fixtures/stability/recorded/tier0-ended.json.gz.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { installEnvProxy } from '../../src/core/proxy.js';
import { repoFromManifestField } from '../../src/enrich/npm/repo.js';
import { STABILITY_DIR, type RecordedPackage } from './fixture.js';
import { augmentPackage, recordPackage, recordProject, type Json } from './record-lib.js';

await installEnvProxy();
const scansDir = process.argv[2];
if (!scansDir) throw new Error('usage: record-tier0.ts <scans dir>');
const REPOS = ['parse-server', 'jitsi-meet', 'superset'];
const recordedAt = new Date();

export interface Tier0EndedFixture {
  _note: string;
  recordedAt: string;
  /** Per scanned repository: the scan time and the packages it labelled Fragile: ended in production (name → versions). */
  scans: Record<string, { asOf: string; ended: Record<string, string[]> }>;
  packages: Record<string, RecordedPackage>;
  /** deps.dev / Scorecard project per normalised repository URL. */
  projects: Record<string, Json>;
}

const out: Tier0EndedFixture = { _note: '', recordedAt: recordedAt.toISOString(), scans: {}, packages: {}, projects: {} };
const versions = new Map<string, Set<string>>();
for (const r of REPOS) {
  const d = JSON.parse(readFileSync(join(scansDir, r, 'blastradius.json'), 'utf8')) as Json;
  const ended: Record<string, string[]> = {};
  for (const p of d.stability.packages as Json[]) {
    if (!p.production || !p.rules.some((x: Json) => x.rule === 'fragile_ended_production')) continue;
    ended[p.name] = p.versions;
    const s = versions.get(p.name) ?? new Set<string>();
    for (const v of p.versions) s.add(v);
    versions.set(p.name, s);
  }
  out.scans[r] = { asOf: d.stability.asOf, ended };
  console.log(`${r}: ${Object.keys(ended).length} ended`);
}
const urls = new Set<string>();
const osvRecords = new Map<string, Json>();
for (const [name, vs] of [...versions].sort()) {
  const rec = await recordPackage(name, [...vs].sort());
  if (!rec) continue;
  // Sizes, declared dependencies (the family test builds the real ldapjs → @ldapjs/* edges from
  // them) and OSV advisories of the versions in use.
  await augmentPackage(rec.pkg, osvRecords);
  out.packages[name] = rec.pkg;
  if (rec.pkg.repo) urls.add(rec.pkg.repo.url);
  const latest = rec.pkg.packument['dist-tags']?.latest;
  const lr = repoFromManifestField(rec.pkg.packument.versions?.[latest]?.repository);
  if (lr) urls.add(lr.url);
  for (const v of vs) {
    const r = repoFromManifestField(rec.pkg.packument.versions?.[v]?.repository);
    if (r) urls.add(r.url);
  }
}
for (const u of [...urls].sort()) {
  const p = await recordProject(u);
  if (p) out.projects[u.toLowerCase()] = p;
  console.log(`project ${u}: ${p ? (p.scorecard?.checks?.[0]?.reason ?? p.checks?.[0]?.reason ?? 'no Maintained check') : 'none'}`);
}
out._note = `Recorded live ${recordedAt.toISOString()} by test/stability/record-tier0.ts from the real --history scans of ${REPOS.join(', ')} (teardown scans at the pinned commits): trimmed npm packuments (no e-mail addresses) and deps.dev / Scorecard Maintained checks for the repository of each version in use and of the latest release.`;
writeFileSync(join(STABILITY_DIR, 'tier0-ended.json.gz'), gzipSync(JSON.stringify(out), { level: 9 }));
console.log(`wrote ${Object.keys(out.packages).length} packages, ${Object.keys(out.projects).length} projects`);
