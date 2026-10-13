/**
 * Scan one recorded org repo against the replay server as of a moment in time. Only the
 * enrichers the replay serves (OSV, npm) run, with an empty incident KB so no hindsight leaks in:
 * everything the scan knows came from the replayed registry and advisory feed.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNpmEnricher } from '../../src/enrich/npm/index.js';
import { createOsvEnricher } from '../../src/enrich/osv/index.js';
import { HttpClient } from '../../src/core/http.js';
import { scan, type ScanOutput } from '../../src/pipeline.js';
import { DATA_DIR, type ReplayServer } from './server.js';

const EMPTY_KB = mkdtempSync(join(tmpdir(), 'replay-kb-'));

export function orgRepoDir(repo: string): string {
  return join(DATA_DIR, 'org', repo.replace('/', '__'));
}

export async function scanAt(server: ReplayServer, repo: string, at: Date): Promise<ScanOutput> {
  server.setClock(at);
  const http = new HttpClient({ offline: false, cacheDir: false, minIntervalMs: 0, hostIntervals: {}, maxRetries: 0 });
  return scan({
    target: orgRepoDir(repo),
    formats: [],
    offline: false,
    now: at,
    kbDir: EMPTY_KB,
    http,
    enrichers: () => [createOsvEnricher({ baseUrl: server.osvUrl }), createNpmEnricher({ registry: server.registryUrl })],
  });
}
