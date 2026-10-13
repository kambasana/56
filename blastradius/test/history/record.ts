/**
 * Record the git history fixtures ONCE (needs network; never run in tests or CI):
 *   npx tsx test/history/record.ts [slug …]      → test/fixtures/history/recorded/<slug>.json
 *
 * Runs the real collector (src/history/git.ts: blobless bare clone, fixed-format git log) on the
 * subjects in subjects.ts, with a random salt that is discarded afterwards, and writes the
 * pseudonymised record in the compact form of fixture.ts. Clones go to a temporary cache that is
 * deleted at the end.
 *
 * GitHub GraphQL responses (login mapping, verification) are recorded too when `--graphql` is
 * given and $GITHUB_TOKEN reaches the GraphQL API; they are written as HttpClient fixture
 * envelopes under test/fixtures/history/graphql/. The token is only sent, never printed.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureClone, readHistory } from '../../src/history/git.js';
import { buildMappingQueries } from '../../src/history/graphql.js';
import { installEnvProxy } from '../../src/core/proxy.js';
import { encodeFixture, RECORDED_DIR } from './fixture.js';
import { HISTORY_SUBJECTS } from './subjects.js';

await installEnvProxy();
const args = process.argv.slice(2);
const wantGraphql = args.includes('--graphql');
const only = args.filter((a) => !a.startsWith('--'));
const subjects = HISTORY_SUBJECTS.filter((s) => only.length === 0 || only.includes(s.slug));
const cacheDir = mkdtempSync(join(process.env.BR_RECORD_TMP ?? tmpdir(), 'br-history-'));
const salt = randomBytes(32);
mkdirSync(RECORDED_DIR, { recursive: true });
const recordedAt = new Date();
try {
  for (const s of subjects) {
    const t0 = Date.now();
    const dir = await ensureClone(s.repo, { dir: cacheDir, maxBytes: 300e6, timeoutMs: 600_000 });
    const rec = await readHistory(dir, { repo: s.repo, salt, timeoutMs: 600_000 });
    writeFileSync(
      join(RECORDED_DIR, `${s.slug}.json`),
      `${JSON.stringify(encodeFixture(rec, `Recorded live ${recordedAt.toISOString()} by test/history/record.ts from ${s.repo}: ${s.note}. Emails hashed with a random salt that was discarded.`, recordedAt))}\n`,
    );
    console.log(`${s.slug}: ${rec.commits.length} commits, ${rec.tags.length} release tags, ${rec.lookup.length} hashed ids, mailmap ${rec.mailmap}, bots ${rec.bots}, ${Date.now() - t0} ms`);
    if (wantGraphql) {
      const token = process.env.GITHUB_TOKEN ?? '';
      const m = /github\.com\/([^/]+)\/([^/]+)$/.exec(s.repo);
      if (!token || !m) continue;
      const out = join(RECORDED_DIR, '..', 'graphql');
      mkdirSync(out, { recursive: true });
      for (const [i, q] of buildMappingQueries(m[1]!, m[2]!, rec.lookup).entries()) {
        const res = await fetch('https://api.github.com/graphql', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ query: q.query, variables: q.variables }) });
        const text = await res.text();
        if (res.status !== 200) {
          console.log(`${s.slug}: GraphQL answered ${res.status}: ${text.slice(0, 160)}`);
          break;
        }
        writeFileSync(join(out, `${s.slug}-${i}.json`), `${JSON.stringify({ request: { url: 'https://api.github.com/graphql', method: 'POST', body: { query: q.query, variables: q.variables } }, status: res.status, response: JSON.parse(text) })}\n`);
      }
    }
  }
} finally {
  rmSync(cacheDir, { recursive: true, force: true });
}
