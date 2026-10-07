/** The replay "Acme" org: the recorded repos and their inventories (ingest only, no network). */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scan } from '../../src/pipeline.js';
import type { StoredInventory } from '../../src/watch/match.js';
import { DATA_DIR } from './server.js';

export interface IncidentConfig {
  id: string;
  title: string;
  advisories: string[];
  bad: { name: string; version: string; publisher: string; source: string }[];
  packages: string[];
  expectEarlyWarning: string;
}

export const INCIDENTS = (JSON.parse(readFileSync(join(DATA_DIR, '..', 'incidents.config.json'), 'utf8')) as { incidents: IncidentConfig[] }).incidents;

export function advisory(id: string): Record<string, any> {
  return JSON.parse(readFileSync(join(DATA_DIR, 'advisories', `${id}.json`), 'utf8')) as Record<string, any>;
}

export function orgRepos(): string[] {
  return readdirSync(join(DATA_DIR, 'org')).sort().map((d) => d.replace('__', '/'));
}

/** Inventories as a server would have stored them from earlier scans. */
export async function orgInventories(): Promise<StoredInventory[]> {
  const out: StoredInventory[] = [];
  for (const repo of orgRepos()) {
    const res = await scan({ target: join(DATA_DIR, 'org', repo.replace('/', '__')), formats: [], offline: true, cacheDir: false, enrichers: () => [] });
    out.push({ projectId: repo, projectName: repo, inventory: res.inventory });
  }
  return out;
}
