/**
 * Golden-output cases (docs/ARCHITECTURE.md §4, stage 0): the recorded real scans, replayed fully
 * offline through the real scan() with the default plugin set.
 *   - parse-server, jitsi-meet, superset: test/fixtures/tier05/<id>.json.gz (manifests + OSV,
 *     deps.dev and npm responses);
 *   - flask: test/fixtures/tier0/flask (uv.lock slice + OSV, deps.dev and ClearlyDefined responses)
 *     plus test/fixtures/stability/recorded/tier05-pypi-flask.json.gz (deps.dev, Scorecard, PyPI).
 * Anything not recorded (GitHub, most npm packuments, the licence enricher's deps.dev lookups) is an
 * offline miss, which the scan reports in coverage/warnings: deterministic, but partial (DECLARED.md).
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { HttpClient } from '../../src/core/http.js';
import { loadFixture, recordedHttp, type Envelope } from '../tier05/replay.js';
import { TIER05_NOW } from '../tier05/targets.js';
import { TIER0_NOW } from '../tier0/targets.js';

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));

export interface GoldenCase {
  id: string;
  /** Reference time of the recording (scan `now`). */
  now: Date;
  /** Manifest files of the target, relative path → text. */
  files: [string, string][];
  /** A fresh offline HttpClient answering only from the recordings (network access throws). */
  http: (shuffle: <T>(xs: T[]) => T[]) => HttpClient;
}

export const CASE_IDS = ['parse-server', 'jitsi-meet', 'superset', 'flask'] as const;

function tier05Case(id: 'parse-server' | 'jitsi-meet' | 'superset'): GoldenCase {
  const fx = loadFixture(id);
  return {
    id,
    now: TIER05_NOW,
    files: Object.entries(fx.files),
    http: (shuffle) => recordedHttp({ ...fx, http: shuffle([...fx.http]) }),
  };
}

function flaskCase(): GoldenCase {
  const dir = path.join(FIXTURES, 'tier0', 'flask');
  const repo = path.join(dir, 'repo');
  const files = readdirSync(repo)
    .sort()
    .map((f): [string, string] => [f, readFileSync(path.join(repo, f), 'utf8')]);
  const envelopes = readdirSync(path.join(dir, 'http'))
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(path.join(dir, 'http', f), 'utf8')) as Envelope);
  const pypi = JSON.parse(gunzipSync(readFileSync(path.join(FIXTURES, 'stability', 'recorded', 'tier05-pypi-flask.json.gz'))).toString('utf8')) as {
    responses: Record<string, unknown>;
  };
  // The PyPI recording is URL → trimmed body (null = 404), as test/stability/tier05.ts replays it.
  const pypiEnvelopes: Envelope[] = Object.entries(pypi.responses).map(([url, body]) => ({ request: { url, method: 'GET' }, status: body === null ? 404 : 200, response: body }));
  return {
    id: 'flask',
    now: TIER0_NOW,
    files,
    http: (shuffle) => recordedHttp({ note: '', repo: '', commit: '', now: '', files: {}, http: shuffle([...envelopes, ...pypiEnvelopes]) }),
  };
}

export function loadCase(id: (typeof CASE_IDS)[number]): GoldenCase {
  return id === 'flask' ? flaskCase() : tier05Case(id);
}
