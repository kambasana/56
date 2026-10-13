/**
 * Record the Tier 0.5 PyPI release-continuity fixture ONCE (needs network; never run in tests or CI):
 *   npx tsx test/stability/record-tier05-pypi-history.ts
 *
 * Labelling PyPI packages (Tier 0.5) brought git-side release-continuity observations without an
 * npm publisher to check them against. In superset's re-scan, 10 production packages had one; the
 * recorded subjects are the false ones and their causes:
 *   filelock, humanize: releases published through PyPI Trusted Publishing (PEP 740 attestations);
 *   sqlglot: lightweight tags on pull-request commits GitHub's web flow merged (the "release maker"
 *   was the pull request's author).
 * For each: the git history through the real collector (salted ids and display-name keys; salt
 * discarded; clone deleted) and the PyPI responses trimmed as in record-tier05-pypi.ts.
 * Output: test/fixtures/stability/recorded/tier05-pypi-history.json.gz.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { installEnvProxy } from '../../src/core/proxy.js';
import { encodeFixture, type HistoryFixture } from '../../src/history/fixture.js';
import { STABILITY_DIR } from './fixture.js';
import { recordHistory, type Json } from './record-lib.js';
import { trimResponse } from './record-tier05-pypi.js';

export const TIER05_PYPI_HISTORY_SUBJECTS = [
  { name: 'filelock', version: '3.20.3', repo: 'https://github.com/tox-dev/py-filelock' },
  { name: 'humanize', version: '4.12.3', repo: 'https://github.com/python-humanize/humanize' },
  { name: 'sqlglot', version: '30.21.0', repo: 'https://github.com/tobymao/sqlglot' },
] as const;

/** superset's re-scan time (2026-10-12). */
export const TIER05_PYPI_HISTORY_AS_OF = '2026-10-12T19:48:30Z';

export interface Tier05PypiHistoryFixture {
  _note: string;
  recordedAt: string;
  responses: Record<string, Json | null>;
  histories: Record<string, HistoryFixture>;
}

if (process.argv[1]?.endsWith('record-tier05-pypi-history.ts')) {
  await installEnvProxy();
  const recordedAt = new Date();
  const salt = randomBytes(32);
  const cacheDir = mkdtempSync(join(process.env.BR_RECORD_TMP ?? tmpdir(), 'br-t05py-'));
  const out: Tier05PypiHistoryFixture = {
    _note: `Recorded live ${recordedAt.toISOString()} by test/stability/record-tier05-pypi-history.ts: PyPI responses trimmed to the fields the enricher reads; histories with salted ids and display-name keys (salt discarded).`,
    recordedAt: recordedAt.toISOString(),
    responses: {},
    histories: {},
  };
  try {
    for (const s of TIER05_PYPI_HISTORY_SUBJECTS) {
      for (const [url, accept] of [
        [`https://pypi.org/pypi/${s.name}/json`, 'application/json'],
        [`https://pypi.org/simple/${s.name}/`, 'application/vnd.pypi.simple.v1+json'],
      ] as const) {
        const res = await fetch(url, { headers: { accept } });
        out.responses[url] = res.status === 200 ? trimResponse(url, (await res.json()) as Json) : null;
      }
      const rec = await recordHistory(s.repo, new Map(), salt, cacheDir);
      if ('error' in rec) throw new Error(`${s.repo}: ${rec.error}`);
      out.histories[s.repo] = encodeFixture(rec, `Recorded live ${recordedAt.toISOString()} from ${s.repo}.`, recordedAt);
    }
    writeFileSync(join(STABILITY_DIR, 'tier05-pypi-history.json.gz'), gzipSync(`${JSON.stringify(out)}\n`));
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
}
