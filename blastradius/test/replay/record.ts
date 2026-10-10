/**
 * Record the replay dataset ONCE (needs network; never run in tests or CI).
 *   tsx test/replay/record.ts --osv-dir <dir with OSV MAL-/GHSA- JSON from the npm export>
 *
 * Writes test/replay/data/:
 *   registry/<name>.json   real packument (slimmed like the engine does), versions trimmed to the
 *                          incident window, plus reconstructed entries for unpublished bad
 *                          versions (marked _replay.reconstructed with the source URL)
 *   advisories/<id>.json   real OSV records (trimmed to the fields the engine reads)
 *   org/<owner>__<repo>/   package.json + package-lock.json of real repos at pinned commits
 *   manifest.json          provenance: what was fetched from where, and when
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { slimPackument } from '../../src/enrich/npm/registry.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, 'data');
/** --registry-only re-records just the npm packuments and keeps the advisories, repos and their manifest entries. */
const registryOnly = process.argv.includes('--registry-only');
const osvDir = process.argv[process.argv.indexOf('--osv-dir') + 1];
if (!registryOnly && (!process.argv.includes('--osv-dir') || !osvDir)) throw new Error('--osv-dir <dir> is required');

interface Bad { name: string; version: string; publisher: string; published?: string; scripts?: Record<string, string>; dependencies?: Record<string, string>; provenance?: boolean; source: string }
interface Inc { id: string; advisories: string[]; bad: Bad[]; packages: string[] }
const config = JSON.parse(readFileSync(join(HERE, 'incidents.config.json'), 'utf8')) as { incidents: Inc[] };

/** Real repos for the org, at the pinned commits verified for the hammer scenarios. */
const ORG = [
  { repo: 'davglass/registry-static', commit: '344aa499dc88b329be0f08d4f1202eb4e11f3137', lockfiles: ['package-lock.json'], env: 'prod' },
  { repo: 'Esri/a11y-map', commit: 'a1f8b3e33ff5d0bfe1e33006f1af63e91c76baa0', lockfiles: ['package-lock.json'], env: 'dev' },
  { repo: 'Esger/Pentominos2', commit: '86c582c0f7fead7c7003ac5d575497de9a073f79', lockfiles: ['package-lock.json'], env: 'prod' },
  { repo: 'project-qwerty/project-qwerty', commit: '6842cfb61b8236e0f768b383e277ebbc6874ac90', lockfiles: ['package-lock.json'], env: 'prod' },
  { repo: 'FinnLeh/vs-code-obsidian', commit: '9c4ac83970cafe94da2c0ec0cad045bb076ee220', lockfiles: ['package-lock.json'], env: 'dev' },
  { repo: 'telefonicaid/logops', commit: '5310b7516caf857ef4ecafc966fe8f9e9f77db81', lockfiles: ['package-lock.json'], env: 'prod' },
];

const now = new Date().toISOString();
const provenance: Record<string, unknown>[] = [];
const write = (rel: string, data: unknown) => {
  const p = join(DATA, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(data, null, 1)}\n`);
};

async function packument(name: string): Promise<Record<string, any> | null> {
  const res = await fetch(`https://registry.npmjs.org/${name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`registry ${name}: HTTP ${res.status}`);
  return (await res.json()) as Record<string, any>;
}

// 1. Registry: every package named by an incident (packages + bad entries).
const names = new Set(config.incidents.flatMap((i) => [...i.packages, ...i.bad.map((b) => b.name)]));
for (const name of [...names].sort()) {
  const incs = config.incidents.filter((i) => i.packages.includes(name) || i.bad.some((b) => b.name === name));
  const bads = incs.flatMap((i) => i.bad.filter((b) => b.name === name));
  const raw = await packument(name);
  const slim = (raw ? slimPackument(raw) : { name, versions: {}, time: {} }) as Record<string, any>;
  const time: Record<string, string> = { ...(slim.time ?? {}) };
  for (const b of bads) if (!time[b.version] && b.published) time[b.version] = b.published;
  // Window: two years before the earliest bad release to 60 days after the latest.
  const badTimes = bads.map((b) => Date.parse(time[b.version] ?? '')).filter((t) => !Number.isNaN(t));
  const from = Math.min(...badTimes) - 2 * 365 * 864e5;
  const to = Math.max(...badTimes) + 60 * 864e5;
  const inWindow = (v: string) => {
    const t = Date.parse(time[v] ?? '');
    return !Number.isNaN(t) && t >= from && t <= to;
  };
  const versions: Record<string, any> = {};
  const all = Object.keys(slim.versions ?? {});
  // Keep the window, the last 3 releases before it (so "previous publisher" is known), and each
  // earlier publisher's latest release before it: without those, an account returning after years
  // (qix on chalk 5.6.1, last published 2.0.1 in 2017) looks like a brand-new publisher.
  const earlier = all.filter((v) => Date.parse(time[v] ?? '') < from).sort((a, b) => Date.parse(time[a]!) - Date.parse(time[b]!));
  const lastBy = new Map<string, string>();
  for (const v of earlier) lastBy.set(String(slim.versions[v]?._npmUser?.name ?? ''), v);
  const before = [...new Set([...earlier.slice(-3), ...lastBy.values()])];
  // Prereleases (nx publishes thousands of canaries) are dropped unless they are a bad version.
  const stable = (v: string) => !v.includes('-') || bads.some((b) => b.version === v);
  for (const v of [...before, ...all.filter(inWindow)].filter(stable)) versions[v] = slim.versions[v];
  for (const b of bads) {
    if (versions[b.version]) continue;
    // The release right before the bad one, by publish time (not insertion order).
    const prev = Object.values(versions)
      .filter((m: any) => Date.parse(time[m.version] ?? '') < Date.parse(time[b.version] ?? ''))
      .sort((x: any, y: any) => Date.parse(time[x.version]!) - Date.parse(time[y.version]!))
      .pop() as Record<string, any> | undefined;
    versions[b.version] = {
      name,
      version: b.version,
      _npmUser: { name: b.publisher },
      maintainers: prev?.maintainers ?? slim.maintainers ?? [],
      dependencies: { ...(prev?.dependencies ?? {}), ...(b.dependencies ?? {}) },
      ...(b.scripts ? { scripts: b.scripts } : {}),
      ...(prev?.repository ? { repository: prev.repository } : {}),
      _replay: { reconstructed: true, reason: 'unpublished by npm; rebuilt from the advisory', source: b.source, provenance: b.provenance ?? null },
    };
  }
  const keep = new Set(Object.keys(versions));
  slim.versions = versions;
  slim.time = Object.fromEntries(Object.entries(time).filter(([k]) => keep.has(k) || k === 'created' || k === 'modified'));
  delete slim['dist-tags']; // the replay server computes dist-tags as of its clock
  write(`registry/${name.replace('/', '__')}.json`, slim);
  provenance.push({ kind: 'packument', name, url: `https://registry.npmjs.org/${name}`, fetchedAt: now, recorded: raw !== null, versions: keep.size, reconstructed: bads.filter((b) => !(raw?.versions ?? {})[b.version]).map((b) => b.version) });
  console.log(`registry ${name}: ${keep.size} versions`);
}

// 2. Advisories from the local OSV export.
for (const id of registryOnly ? [] : [...new Set(config.incidents.flatMap((i) => i.advisories))].sort()) {
  const rec = JSON.parse(readFileSync(join(osvDir!, `${id}.json`), 'utf8'));
  const slim = {
    id: rec.id,
    aliases: rec.aliases,
    published: rec.published,
    modified: rec.modified,
    summary: rec.summary,
    database_specific: rec.database_specific ? { cwe_ids: rec.database_specific.cwe_ids, severity: rec.database_specific.severity } : undefined,
    severity: rec.severity,
    affected: (rec.affected ?? []).filter((a: any) => a.package?.ecosystem === 'npm'),
    references: (rec.references ?? []).slice(0, 5),
  };
  write(`advisories/${id}.json`, slim);
  provenance.push({ kind: 'advisory', id, url: `https://osv.dev/vulnerability/${id}`, source: 'OSV npm export (all.zip)', fetchedAt: now });
}

// 3. Org repos at pinned commits.
for (const o of registryOnly ? [] : ORG) {
  const dir = mkdtempSync(join(tmpdir(), 'replay-'));
  try {
    execFileSync('git', ['init', '-q', dir]);
    execFileSync('git', ['-C', dir, 'fetch', '-q', '--depth', '1', `https://github.com/${o.repo}.git`, o.commit], { stdio: 'ignore' });
    execFileSync('git', ['-C', dir, 'checkout', '-q', 'FETCH_HEAD']);
    const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD']).toString().trim();
    const out = `org/${o.repo.replace('/', '__')}`;
    mkdirSync(join(DATA, out), { recursive: true });
    for (const f of ['package.json', ...o.lockfiles]) if (existsSync(join(dir, f))) copyFileSync(join(dir, f), join(DATA, out, f));
    provenance.push({ kind: 'repo', repo: o.repo, commit: head, url: `https://github.com/${o.repo}/tree/${head}`, files: ['package.json', ...o.lockfiles], environment: o.env, fetchedAt: now });
    console.log(`org ${o.repo}@${head.slice(0, 10)}`);
  } catch (e) {
    console.error(`org ${o.repo}: ${(e as Error).message.split('\n')[0]}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (registryOnly) {
  // Replace only the packument entries; advisories and repos keep their original provenance.
  const old = JSON.parse(readFileSync(join(DATA, 'manifest.json'), 'utf8')) as { items: Record<string, unknown>[] } & Record<string, unknown>;
  write('manifest.json', { ...old, registryRecordedAt: now, items: [...old.items.filter((x) => x.kind !== 'packument'), ...provenance] });
} else {
  write('manifest.json', { recordedAt: now, licences: { registry: 'npm public registry metadata', advisories: 'OSV (CC-BY-4.0 / per source)', repos: 'each repo under its own licence; only lockfiles and package.json are kept' }, items: provenance });
}
