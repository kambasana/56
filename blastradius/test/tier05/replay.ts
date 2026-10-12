/**
 * Replay a Tier 0.5 fixture (test/tier05/record.ts) fully offline: the recorded manifests are
 * written to a temporary directory named after the case, and the scan answers from the recorded
 * OSV, deps.dev and npm responses only (a request that was not recorded fails, never the network).
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { fixtureKey, HttpClient, type HttpMethod } from '../../src/core/http.js';
import { scan, type ScanOptions, type ScanOutput } from '../../src/pipeline.js';
import { createOsvEnricher } from '../../src/enrich/osv/index.js';
import { createDepsDevEnricher } from '../../src/enrich/depsdev/index.js';
import { createNpmEnricher } from '../../src/enrich/npm/index.js';
import { TIER05_NOW } from './targets.js';

export const FIX05 = fileURLToPath(new URL('../fixtures/tier05/', import.meta.url));

export interface Envelope {
  request: { url: string; method: string; body?: unknown };
  status: number;
  response: unknown;
}
export interface Tier05Fixture {
  note: string;
  repo: string;
  commit: string;
  now: string;
  files: Record<string, string>;
  http: Envelope[];
}

export function loadFixture(id: string): Tier05Fixture {
  return JSON.parse(gunzipSync(readFileSync(path.join(FIX05, `${id}.json.gz`))).toString('utf8')) as Tier05Fixture;
}

/** An offline HttpClient that answers from the recorded envelopes only. */
export function recordedHttp(fx: Tier05Fixture): HttpClient {
  const fixtures: Record<string, unknown> = {};
  for (const e of fx.http) {
    const key = e.request.body === undefined ? e.request.url : fixtureKey(e.request.url, (e.request.method ?? 'GET') as HttpMethod, e.request.body);
    fixtures[key] = { status: e.status, response: e.response };
  }
  return new HttpClient({
    offline: true,
    cacheDir: false,
    fixtures,
    minIntervalMs: 0,
    transport: async (req) => {
      throw new Error(`network access attempted in test: ${req.url}`);
    },
  });
}

/** Write the recorded manifests to <tmp>/<id>/ and scan them offline. */
export async function replay(id: string, extra: Partial<ScanOptions> = {}): Promise<ScanOutput & { dir: string; fx: Tier05Fixture }> {
  const fx = loadFixture(id);
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'tier05-')), id);
  for (const [p, text] of Object.entries(fx.files)) {
    mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    writeFileSync(path.join(dir, p), text);
  }
  const kb = mkdtempSync(path.join(tmpdir(), 'tier05-kb-'));
  const out = await scan({
    target: dir,
    offline: true,
    cacheDir: false,
    now: TIER05_NOW,
    kbDir: kb,
    http: recordedHttp(fx),
    enrichers: () => [createOsvEnricher(), createDepsDevEnricher(), createNpmEnricher({ snapshots: false, downloadsApi: false })],
    ...extra,
  });
  return { ...out, dir, fx };
}
