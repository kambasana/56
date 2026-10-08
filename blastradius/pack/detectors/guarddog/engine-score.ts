/**
 * Score Datadog npm compromised samples with Blastradius's own release signals, the same way the
 * replay proof does (test/replay/proof.ts): a one-package probe project scanned at
 * "bad release + 1 hour" against the replay server, with no advisories and an empty KB.
 *
 * Input is only each sample's registry metadata (the packument Datadog stored next to the code,
 * extracted by extract_meta.py); no package code is read. The replay server hides every version
 * published after the clock, so nothing after release + 1 h leaks in. Dependencies added by the
 * bad release are not served (their packuments are not in the dataset), so `dependency_added`
 * cannot judge "young" for them; it still fires on the added name.
 *
 *   npx tsx pack/detectors/guarddog/engine-score.ts <catch-targets.json> <meta dir> <out.json>
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpClient } from '../../../src/core/http.js';
import { createNpmEnricher } from '../../../src/enrich/npm/index.js';
import { scan } from '../../../src/pipeline.js';
import { startReplayServer } from '../../../test/replay/server.js';

const SIGNAL_FACTORS = new Set(['publisher_change', 'maintainer_change', 'install_script', 'repo_transfer', 'provenance_dropped', 'dependency_added']);
const H = 3600_000;

interface Target {
  id: string;
  name: string;
  version: string;
  set: string;
  split: string;
  replay: boolean;
}

function probeProject(name: string, version: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'gd-probe-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'probe', version: '1.0.0', dependencies: { [name]: version } }));
  writeFileSync(
    join(dir, 'package-lock.json'),
    JSON.stringify({ name: 'probe', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'probe', version: '1.0.0', dependencies: { [name]: version } }, [`node_modules/${name}`]: { version } } }),
  );
  return dir;
}

async function main(): Promise<void> {
  const [targetsPath, metaDir, outPath] = process.argv.slice(2) as [string, string, string];
  const targets = (JSON.parse(readFileSync(targetsPath, 'utf8')) as Target[]).filter((t) => t.set === 'compromised_lib');
  const kb = mkdtempSync(join(tmpdir(), 'gd-kb-'));
  const rows: Record<string, unknown>[] = [];
  for (const t of targets) {
    const metaFile = join(metaDir, `${createHash('sha256').update(t.id).digest('hex')}.json`);
    const row: Record<string, unknown> = { id: t.id, name: t.name, version: t.version, split: t.split, replay: t.replay };
    rows.push(row);
    if (!existsSync(metaFile)) {
      row.status = 'no metadata in sample';
      continue;
    }
    const p = JSON.parse(readFileSync(metaFile, 'utf8')) as { name?: string; time?: Record<string, string>; versions?: Record<string, unknown> };
    const releasedAt = p.time?.[t.version];
    if (p.name !== t.name || !releasedAt) {
      row.status = 'no release time for the version';
      continue;
    }
    if (!p.versions?.[t.version]) {
      row.status = 'version manifest missing from stored packument';
      continue;
    }
    row.releasedAt = releasedAt;
    row.priorVersions = Object.entries(p.time ?? {}).filter(([v, at]) => v !== 'created' && v !== 'modified' && Date.parse(at) < Date.parse(releasedAt)).length;
    const dataDir = mkdtempSync(join(tmpdir(), 'gd-data-'));
    mkdirSync(join(dataDir, 'registry'));
    mkdirSync(join(dataDir, 'advisories'));
    copyFileSync(metaFile, join(dataDir, 'registry', 'p.json'));
    const at = new Date(Date.parse(releasedAt) + H);
    const server = await startReplayServer({ clock: at, dataDir });
    const dir = probeProject(t.name, t.version);
    try {
      const out = await scan({
        target: dir,
        formats: [],
        offline: false,
        now: at,
        kbDir: kb,
        http: new HttpClient({ offline: false, cacheDir: false, minIntervalMs: 0, hostIntervals: {}, maxRetries: 0 }),
        enrichers: () => [createNpmEnricher({ registry: server.registryUrl })],
      });
      const purl = `pkg:npm/${t.name.startsWith('@') ? `%40${t.name.slice(1)}` : t.name}@${t.version}`;
      const f = out.result.findings.find((x) => x.purl === purl);
      const signals = f ? [...new Set(f.reasons.filter((r) => r.value > 0 && SIGNAL_FACTORS.has(r.factor)).map((r) => r.factor))] : [];
      row.status = 'scored';
      row.level = f && signals.length > 0 ? f.level : null;
      row.signals = signals;
      row.findingLevel = f?.level ?? null; // proof.ts counts any finding on the version
    } catch (e) {
      row.status = `error: ${String(e).slice(0, 200)}`;
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
    if (rows.length % 100 === 0) console.log(`${rows.length}/${targets.length}`);
  }
  writeFileSync(outPath, JSON.stringify(rows, null, 1));
  console.log(`wrote ${rows.length} rows`);
}

await main();
