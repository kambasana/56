/**
 * Record the stability fixtures ONCE (needs network; never run in tests or CI):
 *   npx tsx test/stability/record.ts [--subjects] [--control]
 *
 * For the §8 subjects (subjects.ts) and every production npm dependency of the control
 * repositories (test/replay/data/org):
 *   - the npm packument (https://registry.npmjs.org/<name>), trimmed to what the stability inputs read:
 *     dist-tags, time, maintainers, repository and per version `_npmUser.name` / trusted publishing /
 *     `deprecated` (plus repository for the versions in use and the latest). The README is reduced
 *     to the declared status slimPackument derives from it. Registry e-mail addresses are dropped;
 *   - the source repository's history through the real P2 collector (src/history/git.ts: blobless
 *     bare clone, fixed-format git log) with a random salt that is discarded afterwards, plus the
 *     npm accounts whose registry e-mail address hashes to an id in that history (S5a link);
 *   - the deps.dev project (https://api.deps.dev/v3/projects/<id>), trimmed to the Scorecard result;
 *     the Scorecard API (https://api.securityscorecards.dev) when deps.dev has none.
 *
 * Output: test/fixtures/stability/recorded/subjects.json and history/<slug>.json (subjects), and
 * control.json.gz (control set). Clones go to a temporary directory, each deleted once read.
 *
 *   npx tsx test/stability/record.ts --augment
 * adds the finished / low-surface inputs to the existing fixtures without touching what is there
 * (so the labels keep their recording time): for each version in use and the latest release, the
 * registry's `dist.unpackedSize` / `dist.fileCount` and declared dependencies; for versions in use
 * the registry has no size for, the same numbers read from the published tarball (`tarballs`); and
 * the OSV advisories affecting each version in use (`osv`, querybatch + /vulns/{id}, trimmed to the
 * fields the OSV enricher reads; no credits). Published sizes and tarballs are immutable.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { installEnvProxy } from '../../src/core/proxy.js';
import type { HistoryRecord } from '../../src/history/record.js';
import { productionComponents } from '../../src/stability/production.js';
import { scan } from '../../src/pipeline.js';
import { encodeFixture, type HistoryFixture } from '../history/fixture.js';
import { controlRepos, ORG_DIR, STABILITY_SUBJECTS } from './subjects.js';
import { STABILITY_DIR, type ControlFixture, type RecordedPackage } from './fixture.js';
import { augmentPackage, cloneKey, recordHistory as recordHistoryWith, recordPackage, recordProject, type Json } from './record-lib.js';

await installEnvProxy();
const args = process.argv.slice(2);
const doAugment = args.includes('--augment');
const doSubjects = !doAugment && (args.length === 0 || args.includes('--subjects'));
const doControl = !doAugment && (args.length === 0 || args.includes('--control'));
const recordedAt = new Date();
const salt = randomBytes(32);
const cacheDir = mkdtempSync(join(process.env.BR_RECORD_TMP ?? tmpdir(), 'br-stability-'));
mkdirSync(join(STABILITY_DIR, 'history'), { recursive: true });

const recordHistory = (url: string, emails: Map<string, Set<string>>) => recordHistoryWith(url, emails, salt, cacheDir);

try {
  if (doAugment) {
    const osvRecords = new Map<string, Json>();
    const subjects = JSON.parse(readFileSync(join(STABILITY_DIR, 'subjects.json'), 'utf8')) as { _note: string; augmentedAt?: string; packages: Record<string, RecordedPackage> };
    for (const [slug, pkg] of Object.entries(subjects.packages)) {
      await augmentPackage(pkg, osvRecords);
      console.log(`subject ${slug}: osv ${Object.values(pkg.osv ?? {}).flat().length}, tarballs ${Object.keys(pkg.tarballs ?? {}).length}`);
    }
    subjects.augmentedAt = recordedAt.toISOString();
    writeFileSync(join(STABILITY_DIR, 'subjects.json'), `${JSON.stringify(subjects, null, 1)}\n`);
    const control = JSON.parse(gunzipSync(readFileSync(join(STABILITY_DIR, 'control.json.gz'))).toString('utf8')) as ControlFixture;
    let n = 0;
    for (const pkg of Object.values(control.packages)) {
      await augmentPackage(pkg, osvRecords);
      if (++n % 25 === 0) console.log(`control: ${n}/${Object.keys(control.packages).length}`);
    }
    control.augmentedAt = recordedAt.toISOString();
    writeFileSync(join(STABILITY_DIR, 'control.json.gz'), gzipSync(JSON.stringify(control), { level: 9 }));
    console.log(`augmented ${n} control packages; ${osvRecords.size} OSV records`);
  }
  if (doSubjects) {
    const out: { _note: string; recordedAt: string; packages: Record<string, RecordedPackage & { project?: Json; historyError?: string }> } = {
      _note: `Recorded live ${recordedAt.toISOString()} by test/stability/record.ts: npm packuments (trimmed, no e-mail addresses), deps.dev / Scorecard Maintained check. Histories in history/.`,
      recordedAt: recordedAt.toISOString(),
      packages: {},
    };
    for (const s of STABILITY_SUBJECTS) {
      console.log(s.slug);
      const r = await recordPackage(s.name, [s.version]);
      if (!r) continue;
      const entry: RecordedPackage & { project?: Json; historyError?: string } = r.pkg;
      if (r.pkg.repo) {
        const project = await recordProject(r.pkg.repo.url);
        if (project) entry.project = project;
      }
      if (s.history && 'record' in s.history) {
        const rec = await recordHistory(s.history.record, r.emails);
        if ('error' in rec) entry.historyError = rec.error;
        else writeFileSync(join(STABILITY_DIR, 'history', `${s.slug}.json`), `${JSON.stringify(encodeFixture(rec, `Recorded live ${recordedAt.toISOString()} by test/stability/record.ts from ${s.history.record}: ${s.note}. Emails hashed with a random salt that was discarded; npmPublishers maps npm accounts whose registry e-mail hashes to an id here.`, recordedAt))}\n`);
      }
      out.packages[s.slug] = entry;
    }
    writeFileSync(join(STABILITY_DIR, 'subjects.json'), `${JSON.stringify(out, null, 1)}\n`);
  }

  if (doControl) {
    const byName = new Map<string, Set<string>>();
    for (const d of controlRepos()) {
      const res = await scan({ target: join(ORG_DIR, d), formats: [], offline: true, cacheDir: false, enrichers: () => [] });
      const prod = productionComponents(res.inventory);
      for (const c of res.inventory.components) {
        if (c.ecosystem !== 'npm' || !prod.has(c.purl)) continue;
        const s = byName.get(c.name) ?? new Set<string>();
        s.add(c.version);
        byName.set(c.name, s);
      }
    }
    const fixture: ControlFixture = { _note: '', recordedAt: recordedAt.toISOString(), packages: {}, projects: {}, histories: {}, historyErrors: {} };
    const emailsByRepo = new Map<string, Map<string, Set<string>>>();
    const names = [...byName.keys()].sort();
    console.log(`control: ${names.length} production npm packages`);
    for (const name of names) {
      const r = await recordPackage(name, [...byName.get(name)!].sort());
      if (!r) continue;
      fixture.packages[name] = r.pkg;
      // Monorepo packages (repository.directory) share their repository's history, as in the enricher.
      const key = r.pkg.repo ? cloneKey(r.pkg.repo.url) : undefined;
      if (!key) continue;
      const m = emailsByRepo.get(key) ?? new Map<string, Set<string>>();
      for (const [n, set] of r.emails) m.set(n, new Set([...(m.get(n) ?? []), ...set]));
      emailsByRepo.set(key, m);
    }
    const repos = [...emailsByRepo.keys()].sort();
    console.log(`control: ${repos.length} repositories`);
    for (const url of repos) {
      const project = await recordProject(url);
      if (project) fixture.projects[url] = project;
      const rec = await recordHistory(url, emailsByRepo.get(url)!);
      if ('error' in rec) fixture.historyErrors[url] = rec.error;
      else {
        // Control histories are only used for labels: no time-zone months or GraphQL lookups, and
        // commit oids only where a tag points at them.
        const tagged = new Set(rec.tags.map((t) => t.commit));
        const slim: HistoryRecord = { ...rec, tzMonths: {}, lookup: [], commits: rec.commits.map((c) => ({ ...c, oid: tagged.has(c.oid) ? c.oid : '' })) };
        fixture.histories[url] = encodeFixture(slim, '', recordedAt) as HistoryFixture;
      }
    }
    fixture._note = `Recorded live ${recordedAt.toISOString()} by test/stability/record.ts: the production npm dependencies of the control repositories (test/replay/data/org), their trimmed packuments, deps.dev / Scorecard Maintained checks and pseudonymised histories (random salt, discarded).`;
    writeFileSync(join(STABILITY_DIR, 'control.json.gz'), gzipSync(JSON.stringify(fixture), { level: 9 }));
    console.log(`control: ${Object.keys(fixture.histories).length} histories, ${Object.keys(fixture.historyErrors).length} not read`);
  }
} finally {
  rmSync(cacheDir, { recursive: true, force: true });
}
