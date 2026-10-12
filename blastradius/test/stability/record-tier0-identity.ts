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
] as const;

if (process.argv[1]?.endsWith('record-tier0-identity.ts')) {
  await installEnvProxy();
  const recordedAt = new Date();
  const salt = randomBytes(32);
  const cacheDir = mkdtempSync(join(process.env.BR_RECORD_TMP ?? tmpdir(), 'br-tier0-'));
  const out: { _note: string; recordedAt: string; packages: Record<string, RecordedPackage & { project?: Json; historyError?: string }> } = {
    _note: `Recorded live ${recordedAt.toISOString()} by test/stability/record-tier0-identity.ts: npm packuments (trimmed, no e-mail addresses), deps.dev / Scorecard Maintained check. Histories in history/tier0-<slug>.json (salted ids and salted display-name keys only; salt discarded).`,
    recordedAt: recordedAt.toISOString(),
    packages: {},
  };
  try {
    for (const s of TIER0_IDENTITY_SUBJECTS) {
      const r = await recordPackage(s.name, [s.version]);
      if (!r) continue;
      const entry: RecordedPackage & { project?: Json; historyError?: string } = r.pkg;
      if (r.pkg.repo) {
        const p = await recordProject(r.pkg.repo.url);
        if (p) entry.project = p;
      }
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
