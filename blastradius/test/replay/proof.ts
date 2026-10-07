/**
 * Proof run (docs/NEXT-LEVEL.md): replay every recorded incident and measure what Blastradius
 * knew, and when, using only the recorded data.
 *
 * For each incident:
 *   - early warning: scan at "bad release + 1 hour" (the advisory does not exist yet) and record
 *     the signals on the bad version;
 *   - detection: scan after the advisory and check the bad version is critical;
 *   - org exposure: match the advisories against the stored inventories of the Acme org (no
 *     re-scan) and time it.
 * Org repos that pin a bad version are scanned as they are; incidents no org repo pins are checked
 * with a one-package probe project (real registry data, a minimal lockfile).
 *   npm run proof   → test/replay/out/proof.md and proof.json
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Finding } from '../../src/core/types.js';
import { createNpmEnricher } from '../../src/enrich/npm/index.js';
import { createOsvEnricher } from '../../src/enrich/osv/index.js';
import { HttpClient } from '../../src/core/http.js';
import { scan } from '../../src/pipeline.js';
import { advisoryAffects, matchAdvisories } from '../../src/watch/match.js';
import { INCIDENTS, advisory, orgInventories } from './org.js';
import { DATA_DIR, startReplayServer, type ReplayServer } from './server.js';
import { orgRepoDir } from './scan-at.js';
import { readFileSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EMPTY_KB = mkdtempSync(join(tmpdir(), 'proof-kb-'));
/** Pre-disclosure signals (upkeep factors such as no_provenance are not early warnings). */
const SIGNAL_FACTORS = new Set(['publisher_change', 'maintainer_change', 'install_script', 'repo_transfer', 'provenance_dropped']);

export interface BadVersionResult {
  name: string;
  version: string;
  releasedAt: string;
  advisoryAt: string;
  /** Hours from the bad release to the first advisory naming it. */
  exposureHours: number;
  scannedIn: string;
  earlyWarning: { level: string; signals: string[] } | null;
  afterAdvisory: { level: string; malware: boolean } | null;
}

export interface IncidentResult {
  id: string;
  title: string;
  bad: BadVersionResult[];
  org: { projects: string[]; hits: { project: string; component: string; advisory: string; production: boolean; reach: string }[]; ms: number };
}

function packument(name: string): Record<string, any> {
  return JSON.parse(readFileSync(join(DATA_DIR, 'registry', `${name.replace('/', '__')}.json`), 'utf8')) as Record<string, any>;
}

/** A one-package project: real registry data, minimal lockfile. */
function probeProject(name: string, version: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'probe-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'probe', version: '1.0.0', dependencies: { [name]: version } }));
  writeFileSync(
    join(dir, 'package-lock.json'),
    JSON.stringify({ name: 'probe', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'probe', version: '1.0.0', dependencies: { [name]: version } }, [`node_modules/${name}`]: { version } } }),
  );
  return dir;
}

async function scanDirAt(server: ReplayServer, dir: string, at: Date) {
  server.setClock(at);
  return scan({
    target: dir,
    formats: [],
    offline: false,
    now: at,
    kbDir: EMPTY_KB,
    http: new HttpClient({ offline: false, cacheDir: false, minIntervalMs: 0, hostIntervals: {}, maxRetries: 0 }),
    enrichers: () => [createOsvEnricher({ baseUrl: server.osvUrl }), createNpmEnricher({ registry: server.registryUrl })],
  });
}

const H = 3600_000;

export async function runProof(): Promise<IncidentResult[]> {
  const server = await startReplayServer({ clock: new Date(0) });
  const inventories = await orgInventories();
  const results: IncidentResult[] = [];
  try {
    for (const inc of INCIDENTS) {
      const advs = inc.advisories.map(advisory);
      const t = performance.now();
      const hits = matchAdvisories(inventories, advs as never);
      const ms = Math.round((performance.now() - t) * 10) / 10;
      const bad: BadVersionResult[] = [];
      for (const b of inc.bad) {
        const releasedAt = packument(b.name).time?.[b.version] as string | undefined;
        const naming = advs.filter((a) => advisoryAffects(a as never, b.name, b.version));
        const advisoryAt = naming.map((a) => a.published as string).sort()[0];
        if (!releasedAt || !advisoryAt) continue;
        const purl = `pkg:npm/${b.name.startsWith('@') ? `%40${b.name.slice(1)}` : b.name}@${b.version}`;
        const hit = hits.find((h) => h.purl === purl);
        const dir = hit ? orgRepoDir(hit.projectId) : probeProject(b.name, b.version);
        const scannedIn = hit ? hit.projectName : 'probe project (no org repo pins it)';
        const pick = (f: Finding | undefined) => f;
        const early = pick((await scanDirAt(server, dir, new Date(Date.parse(releasedAt) + H))).result.findings.find((f) => f.purl === purl));
        const after = pick((await scanDirAt(server, dir, new Date(Date.parse(advisoryAt) + H))).result.findings.find((f) => f.purl === purl));
        bad.push({
          name: b.name,
          version: b.version,
          releasedAt,
          advisoryAt,
          exposureHours: Math.round(((Date.parse(advisoryAt) - Date.parse(releasedAt)) / H) * 10) / 10,
          scannedIn,
          earlyWarning: early ? { level: early.level, signals: [...new Set(early.reasons.filter((r) => r.value > 0 && SIGNAL_FACTORS.has(r.factor)).map((r) => r.factor))] } : null,
          afterAdvisory: after ? { level: after.level, malware: after.reasons.some((r) => r.factor === 'malware') } : null,
        });
      }
      results.push({
        id: inc.id,
        title: inc.title,
        bad,
        org: {
          projects: [...new Set(hits.map((h) => h.projectName))],
          hits: hits.map((h) => ({ project: h.projectName, component: `${h.name}@${h.version}`, advisory: h.advisoryId!, production: h.production, reach: h.reachText })),
          ms,
        },
      });
    }
  } finally {
    await server.close();
  }
  return results;
}

export function proofMarkdown(results: IncidentResult[]): string {
  const lines = ['# Blastradius proof run (recorded real events, replayed offline)', ''];
  const all = results.flatMap((r) => r.bad);
  const detected = all.filter((b) => b.afterAdvisory?.level === 'critical').length;
  const warned = all.filter((b) => (b.earlyWarning?.signals.length ?? 0) > 0);
  lines.push(`- Bad releases replayed: **${all.length}** across ${results.length} incidents.`);
  lines.push(`- Critical once the advisory exists: **${detected}/${all.length}**.`);
  lines.push(`- Early warning before any advisory: **${warned.length}/${all.length}** (${warned.map((b) => `${b.name}@${b.version}`).join(', ') || 'none'}).`);
  lines.push(`- Org exposure answered from stored inventories in ${Math.max(...results.map((r) => r.org.ms))} ms or less per incident.`);
  lines.push('');
  lines.push('| Incident | Bad release | Released → advisory | Early warning (release + 1 h) | After advisory | Scanned in |');
  lines.push('|---|---|---|---|---|---|');
  for (const r of results)
    for (const b of r.bad)
      lines.push(
        `| ${r.id} | ${b.name}@${b.version} | ${b.exposureHours} h | ${b.earlyWarning ? (b.earlyWarning.signals.length ? `${b.earlyWarning.level}: ${b.earlyWarning.signals.join(', ')}` : 'no signal') : 'no finding'} | ${b.afterAdvisory ? `${b.afterAdvisory.level}${b.afterAdvisory.malware ? ' (malware)' : ''}` : 'not flagged'} | ${b.scannedIn} |`,
      );
  lines.push('', '## Org exposure (Acme org, stored inventories, no re-scan)', '');
  for (const r of results) {
    lines.push(`**${r.id}**: ${r.org.hits.length ? '' : 'no project pins an affected version.'} (${r.org.ms} ms)`);
    for (const h of r.org.hits) lines.push(`- ${h.project}: ${h.component} [${h.advisory}]${h.production ? ' **production**' : ''}: ${h.reach}`);
    lines.push('');
  }
  lines.push('Data: test/replay/data (recorded once; see manifest.json). Bad versions were unpublished by npm and are reconstructed from their advisories; everything else is recorded.');
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const results = await runProof();
  const out = join(HERE, 'out');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'proof.json'), `${JSON.stringify(results, null, 2)}\n`);
  writeFileSync(join(out, 'proof.md'), proofMarkdown(results));
  console.log(proofMarkdown(results));
}
