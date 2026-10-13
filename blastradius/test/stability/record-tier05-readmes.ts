/**
 * Record the Tier 0.5 README fixture ONCE (needs network; never run in tests or CI):
 *   npx tsx test/stability/record-tier05-readmes.ts
 *
 * The independent verification of the Tier 0 re-scans found README "ended" calls that documented a
 * feature, not the project: rc-util (superset, "### deprecated" documents its deprecated() helper)
 * and amplitude-js (jitsi-meet, "## Deprecated - React Native"). moment's "legacy project, now in
 * maintenance mode" and the real declarations (request, crypto-js, path-is-absolute, …) are the
 * controls. For each: the README as npm serves it (e-mail addresses removed) and the trimmed
 * packument / deps.dev project at the version the real scan used (record-lib.ts).
 * Output: test/fixtures/stability/recorded/tier05-readmes.json.gz.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { installEnvProxy } from '../../src/core/proxy.js';
import { packumentUrl } from '../../src/enrich/npm/registry.js';
import { STABILITY_DIR, type RecordedPackage } from './fixture.js';
import { EMAIL_RE, getJson, recordPackage, recordProject, type Json } from './record-lib.js';

/** name → version in use and the scan it came from (verification re-scans, 2026-10-12). */
export const TIER05_README_SUBJECTS: Record<string, { version: string; scan: string; asOf: string }> = {
  'rc-util': { version: '5.44.4', scan: 'superset', asOf: '2026-10-12T18:02:25.818Z' },
  'amplitude-js': { version: '8.21.9', scan: 'jitsi-meet', asOf: '2026-10-12T17:17:09.146Z' },
  '@xmpp/jid': { version: '0.13.2', scan: 'jitsi-meet', asOf: '2026-10-12T17:17:09.146Z' },
  moment: { version: '2.29.4', scan: 'parse-server', asOf: '2026-10-12T16:58:26.090Z' },
  'typescript-json-schema': { version: '0.68.0', scan: 'superset', asOf: '2026-10-12T18:02:25.818Z' },
  request: { version: '2.88.2', scan: 'control', asOf: '2026-10-12T18:02:25.818Z' },
  'crypto-js': { version: '4.2.0', scan: 'parse-server', asOf: '2026-10-12T16:58:26.090Z' },
  'path-is-absolute': { version: '1.0.1', scan: 'jitsi-meet', asOf: '2026-10-12T17:17:09.146Z' },
  'node-domexception': { version: '1.0.0', scan: 'superset', asOf: '2026-10-12T18:02:25.818Z' },
  'buf-compare': { version: '1.0.1', scan: 'superset', asOf: '2026-10-12T18:02:25.818Z' },
  'core-assert': { version: '0.2.1', scan: 'superset', asOf: '2026-10-12T18:02:25.818Z' },
  'deep-strict-equal': { version: '0.2.0', scan: 'superset', asOf: '2026-10-12T18:02:25.818Z' },
  'os-homedir': { version: '1.0.2', scan: 'superset', asOf: '2026-10-12T18:02:25.818Z' },
};

export interface Tier05ReadmeFixture {
  _note: string;
  recordedAt: string;
  readmes: Record<string, string>;
  packages: Record<string, RecordedPackage & { project?: Json }>;
}

if (process.argv[1]?.endsWith('record-tier05-readmes.ts')) {
  await installEnvProxy();
  const recordedAt = new Date();
  const out: Tier05ReadmeFixture = {
    _note: `Recorded live ${recordedAt.toISOString()} by test/stability/record-tier05-readmes.ts: npm READMEs (e-mail addresses removed), trimmed packuments, deps.dev / Scorecard Maintained check.`,
    recordedAt: recordedAt.toISOString(),
    readmes: {},
    packages: {},
  };
  for (const [name, s] of Object.entries(TIER05_README_SUBJECTS)) {
    const raw = await getJson(packumentUrl(name));
    if (typeof raw.body?.readme === 'string') out.readmes[name] = raw.body.readme.replace(EMAIL_RE, '<e-mail address removed>');
    const r = await recordPackage(name, [s.version]);
    if (!r) continue;
    const entry: RecordedPackage & { project?: Json } = r.pkg;
    if (r.pkg.repo) {
      const p = await recordProject(r.pkg.repo.url);
      if (p) entry.project = p;
    }
    out.packages[name] = entry;
    console.log(`  ${name}: README ${out.readmes[name]?.length ?? 0} chars, declared ${JSON.stringify(entry.packument._declaredStatus ?? null)}`);
  }
  writeFileSync(join(STABILITY_DIR, 'tier05-readmes.json.gz'), gzipSync(`${JSON.stringify(out)}\n`));
}
