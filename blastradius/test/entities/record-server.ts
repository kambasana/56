/**
 * Records the Tier 0 web fixture from a real scan and the live registries (needs network;
 * docs/WHO-BEHIND-PLAN.md "Tier 0"):
 *
 *   NODE_USE_ENV_PROXY=1 npx tsx test/entities/record-server.ts <parse-server checkout at the pinned commit>
 *
 * Writes test/fixtures/entities/parse-server-server.json.gz:
 *  - `result`: the real ScanResult (no git history; licences dropped to keep the file small; the
 *    target path replaced by the repository URL) and `inventory`: the real engine inventory;
 *  - `registry`: compact npm packuments (account index format: maintainers, repository owner, and
 *    per version the publish time, `_npmUser` and maintainers; no e-mail addresses) of the packages
 *    the server tests ask about and every package account qix maintains;
 *  - `advisories`: the OSV malware advisories (MAL-*) of those packages.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { indexFromPackument, type IndexedPackage } from '../../src/accounts/registry.js';
import { HttpClient } from '../../src/core/http.js';
import { fetchPackument } from '../../src/enrich/npm/registry.js';
import { scan } from '../../src/pipeline.js';
import { fetchMalwareAdvisories } from '../../src/server/known-bad.js';
import type { MalwareAdvisory } from '../../src/server/store/index.js';

/** Packages the server tests ask about. */
export const ASKED = ['debug', 'chalk', 'express', 'babel-loader', 'sprintf-js', 'decompress'];

async function main(): Promise<void> {
  const [target] = process.argv.slice(2);
  if (!target) throw new Error('usage: record-server.ts <target>');
  const commit = execFileSync('git', ['-C', target, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const { result, inventory } = await scan({ target, offline: false, log: (m) => process.stderr.write(`… ${m}\n`) });
  const { licenses: _l, ...rest } = result;
  const slim = { ...rest, target: 'https://github.com/parse-community/parse-server' };

  const http = new HttpClient({});
  const registry: IndexedPackage[] = [];
  const names = new Set(ASKED);
  for (const name of [...ASKED]) {
    const p = await fetchPackument(http, name);
    if (p) registry.push(indexFromPackument(p, name));
  }
  // Every package qix maintains in this inventory (the account pivot test).
  const npmNames = [...new Set(inventory.components.filter((c) => c.ecosystem === 'npm').map((c) => c.name))].sort();
  for (const name of npmNames) {
    if (names.has(name)) continue;
    const p = await fetchPackument(http, name);
    if (!p) continue;
    const idx = indexFromPackument(p, name);
    if (idx.maintainers.includes('qix')) {
      registry.push(idx);
      names.add(name);
    }
  }
  const advisories: { name: string; malware: MalwareAdvisory[] }[] = [];
  for (const name of [...names].sort()) advisories.push({ name, malware: await fetchMalwareAdvisories(http, name) });

  const fixture = {
    target: 'https://github.com/parse-community/parse-server',
    commit,
    recordedAt: new Date().toISOString(),
    note: 'Real scan (no --history) of the pinned commit plus live npm packuments and OSV answers. GitHub API answered 403 in the recording session.',
    result: slim,
    inventory,
    registry: registry.sort((a, b) => a.name.localeCompare(b.name)),
    advisories,
  };
  const dir = path.join(import.meta.dirname, '..', 'fixtures', 'entities');
  await mkdir(dir, { recursive: true });
  const gz = gzipSync(JSON.stringify(fixture));
  await writeFile(path.join(dir, 'parse-server-server.json.gz'), gz);
  process.stderr.write(`recorded ${commit}: ${result.findings.length} findings, ${result.health?.length ?? 0} health, ${registry.length} packuments, ${advisories.filter((a) => a.malware.length).length} with malware; ${gz.length} bytes\n`);
}

await main();
