/**
 * Record the Tier 0 identity fixture ONCE (needs network; never run in tests or CI):
 *   npx tsx test/stability/record-tier0-identity.ts
 *
 * The teardown's false takeover alerts (problem 4), at the versions the real scans used:
 *   nanoid 3.3.19 (parse-server): its author changed e-mail domain in 2026;
 *   react 18.3.1 (superset): a maintainer moved from a personal to an employer address;
 *   picocolors 1.1.1 (all three): the creator's own first commit read as a "takeover";
 *   moment 2.31.0 (superset): released through npm trusted publishing.
 * For each: the trimmed packument and deps.dev project (record-lib.ts), and the history through the
 * real collector (src/history/git.ts), which now also keeps salted display-name keys and every id
 * the npm accounts' registry addresses hash to. Random salt, discarded; clones deleted once read.
 * Tier 0.5 added process-warning, react-native-sound, react-native-video (false S5a items in the
 * re-scans) and react-native-paper / -safe-area-context (real, benign), with each publishing
 * account's cross-registry sibling answer (`siblings`).
 * Output: test/fixtures/stability/recorded/tier0-identity.json and history/tier0-<slug>.json.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installEnvProxy } from '../../src/core/proxy.js';
import { encodeFixture } from '../history/fixture.js';
import { STABILITY_DIR, type RecordedPackage } from './fixture.js';
import { recordHistory, recordPackage, recordProject, type Json } from './record-lib.js';

export const TIER0_IDENTITY_SUBJECTS = [
  { slug: 'nanoid', name: 'nanoid', version: '3.3.19', repo: 'https://github.com/ai/nanoid', scan: 'parse-server' },
  { slug: 'react', name: 'react', version: '18.3.1', repo: 'https://github.com/facebook/react', scan: 'superset' },
  { slug: 'picocolors', name: 'picocolors', version: '1.1.1', repo: 'https://github.com/alexeyraspopov/picocolors', scan: 'parse-server' },
  { slug: 'moment', name: 'moment', version: '2.31.0', repo: 'https://github.com/moment/moment', scan: 'superset' },
  // jitsi-meet's re-scan (Tier 0): a git-side takeover for 0.8.12, published on npm by the account that published 0.8.11.
  { slug: 'xmldom', name: '@xmldom/xmldom', version: '0.8.12', repo: 'https://github.com/xmldom/xmldom', scan: 'jitsi-meet' },
  // jitsi-meet's re-scan: facebook/react's v19.0.1 tag read as a scheduler release; history shared with react.
  { slug: 'scheduler', name: 'scheduler', version: '0.26.0', repo: 'https://github.com/facebook/react', scan: 'jitsi-meet', historyFrom: 'react' },
  // Tier 0.5 (independent verification of the Tier 0 re-scans): false S5a items.
  // process-warning: v5.1.0 tagged by "KaKa" (a short one-word name) from a new address; the same
  // person committed as the no-reply login climba03003, the npm account that published 5.1.0 and
  // that already published fastify and fast-json-stringify (same repository owner).
  { slug: 'process-warning', name: 'process-warning', version: '2.3.2', repo: 'https://github.com/fastify/process-warning', scan: 'parse-server' },
  // react-native-sound: "RomualdPercereau" and "Romuald Percereau" are one person.
  { slug: 'react-native-sound', name: 'react-native-sound', version: '0.11.2', repo: 'https://github.com/zmxv/react-native-sound', scan: 'jitsi-meet' },
  // react-native-video: a 7.0.0-beta.9 pre-release while 6.19.1 is in use.
  { slug: 'react-native-video', name: 'react-native-video', version: '6.19.1', repo: 'https://github.com/TheWidlarzGroup/react-native-video', scan: 'jitsi-meet' },
  // The remaining jitsi-meet S5a items (real, benign: kept as observations).
  { slug: 'react-native-paper', name: 'react-native-paper', version: '5.14.5', repo: 'https://github.com/callstack/react-native-paper', scan: 'jitsi-meet' },
  { slug: 'react-native-safe-area-context', name: 'react-native-safe-area-context', version: '5.9.1', repo: 'https://github.com/AppAndFlow/react-native-safe-area-context', scan: 'jitsi-meet' },
] as const;

/** Repository owner of a recorded subject (the enricher's sibling key). */
function ownerOf(repo: string): string {
  return repo.replace(/^https:\/\/[^/]+\//, '').split('/')[0]!.toLowerCase();
}

if (process.argv[1]?.endsWith('record-tier0-identity.ts')) {
  await installEnvProxy();
  const { HttpClient } = await import('../../src/core/http.js');
  const { npmSiblingRelease } = await import('../../src/enrich/history/index.js');
  const http = new HttpClient({ cacheDir: false });
  const recordedAt = new Date();
  const salt = randomBytes(32);
  const cacheDir = mkdtempSync(join(process.env.BR_RECORD_TMP ?? tmpdir(), 'br-tier0-'));
  const out: { _note: string; recordedAt: string; packages: Record<string, RecordedPackage & { project?: Json; historyError?: string }> } = {
    _note: `Recorded live ${recordedAt.toISOString()} by test/stability/record-tier0-identity.ts: npm packuments (trimmed, no e-mail addresses), deps.dev / Scorecard Maintained check. Histories in history/tier0-<slug>.json (salted ids and salted display-name keys only; salt discarded).`,
    recordedAt: recordedAt.toISOString(),
    packages: {},
  };
  // `npx tsx record-tier0-identity.ts xmldom scheduler` records only those and keeps the rest.
  const only = process.argv.slice(2);
  const existingFile = join(STABILITY_DIR, 'tier0-identity.json');
  if (only.length) {
    const { existsSync, readFileSync } = await import('node:fs');
    if (existsSync(existingFile)) out.packages = (JSON.parse(readFileSync(existingFile, 'utf8')) as typeof out).packages;
  }
  try {
    for (const s of TIER0_IDENTITY_SUBJECTS) {
      if (only.length && !only.includes(s.slug)) continue;
      const r = await recordPackage(s.name, [s.version]);
      if (!r) continue;
      const entry: RecordedPackage & { project?: Json; historyError?: string } = r.pkg;
      if (r.pkg.repo) {
        const p = await recordProject(r.pkg.repo.url);
        if (p) entry.project = p;
      }
      if ('historyFrom' in s) {
        out.packages[s.slug] = entry;
        continue;
      }
      // Tier 0.5: the cross-registry sibling answer for every account that published the package
      // (the default lookup of the enricher, live), keyed by account.
      const siblings: Record<string, { name: string; firstAt: string } | null> = {};
      for (const account of Object.keys(Object.fromEntries(Object.values(r.pkg.packument.versions as Record<string, any>).map((m) => [m?._npmUser?.name, 1]))).filter((a) => a && a !== 'undefined').sort()) {
        // The npm search API rate-limits (429): wait and retry.
        for (let attempt = 0; ; attempt++) {
          try {
            siblings[account] = (await npmSiblingRelease({ http }, account, ownerOf(s.repo), s.name)) ?? null;
            break;
          } catch (err) {
            if (attempt >= 6) throw err;
            await new Promise((r) => setTimeout(r, 15_000 * (attempt + 1)));
          }
        }
      }
      (entry as any).siblings = { owner: ownerOf(s.repo), byAccount: siblings };
      const rec = await recordHistory(s.repo, r.emails, salt, cacheDir);
      if ('error' in rec) entry.historyError = rec.error;
      else writeFileSync(join(STABILITY_DIR, 'history', `tier0-${s.slug}.json`), `${JSON.stringify(encodeFixture(rec, `Recorded live ${recordedAt.toISOString()} by test/stability/record-tier0-identity.ts from ${s.repo}. Emails and display names hashed with a random salt that was discarded; npmPublishers / npmPublisherIds map npm accounts whose registry e-mail hashes to ids here.`, recordedAt))}\n`);
      out.packages[s.slug] = entry;
    }
    writeFileSync(join(STABILITY_DIR, 'tier0-identity.json'), `${JSON.stringify(out, null, 1)}\n`);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
}
