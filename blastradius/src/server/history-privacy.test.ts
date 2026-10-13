/**
 * Storage guardrails for git history (docs/WHO-BEHIND-PLAN.md §5, P2 gate):
 *   - no clear-text email (or name) of a contributor anywhere in the database file;
 *   - no per-person time-zone rows: time zones are stored only as repo-level window aggregates,
 *     and nothing about a person carries an offset, hour, location or country.
 * Real inputs: a local repository read by the real git reader (known emails, names, offsets),
 * and the recorded xz-utils history at 2024-02-01 (whose windows do carry time-zone aggregates).
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpClient } from '../core/http.js';
import { makeFact, type Fact } from '../core/types.js';
import { createHistoryEnricher } from '../enrich/history/index.js';
import { readHistory } from '../history/git.js';
import type { HistoryRecord } from '../history/record.js';
import { buildHistoryReport } from '../history/report.js';
import { LOCAL_SECRETS, makeLocalRepo } from '../history/testing.js';
import { loadFixture } from '../../test/history/fixture.js';
import { all, closeStore, completeScan, createOrg, createProject, createUser, enqueueScan, getScanResult, markScanRunning, openStore, type Store } from './store/index.js';
import { makeResult } from './store/testing.js';

const PERSON_KEYS = new Set(['id', 'login', 'author', 'committer', 'by', 'email', 'name']);
const PLACE_OR_TIME_RE = /offset|zone|^tz|hour|location|country|nationality|ethnic|language/i;

let tmp: string;
let store: Store;
let dbFile: string;
let orgId: string;
let scanId: string;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'br-history-privacy-'));
  const local = makeLocalRepo(path.join(tmp, 'repo'));
  const localRec = await readHistory(local.dir, { repo: 'https://github.com/example/local', salt: 'privacy-test-salt-0123' });
  const records = new Map<string, HistoryRecord>([
    ['https://github.com/example/local', localRec],
    ['https://github.com/tukaani-project/xz', loadFixture('xz').record],
  ]);
  const repoFacts: Fact[] = [
    makeFact('repo', 'pkg:npm/local-lib', { url: 'https://github.com/example/local', host: 'github', via: 'npm.repository' }, { source: 'npm', fetchedAt: '2024-02-01T00:00:00Z' }),
    makeFact('repo', 'pkg:generic/xz-utils', { url: 'https://github.com/tukaani-project/xz', host: 'github', via: 'npm.repository' }, { source: 'npm', fetchedAt: '2024-02-01T00:00:00Z' }),
  ];
  const facts = await createHistoryEnricher({ repoFacts: () => repoFacts, recorded: (u) => records.get(u), salt: 'unused' }).enrich(
    { assets: [], components: [], edges: [] },
    { http: new HttpClient({ offline: true, cacheDir: false }), now: new Date('2025-12-31T00:00:00Z'), offline: true },
  );
  const result = makeResult([{ name: 'local-lib', score: 0.1 }]);
  result.history = buildHistoryReport(facts);
  expect(result.history?.repos).toHaveLength(2);

  dbFile = path.join(tmp, 'br.db');
  store = openStore({ path: dbFile });
  const actor = createUser(store, { email: 'admin@company.test', name: 'Admin' }).id;
  orgId = createOrg(store, { name: 'Acme' }, actor).id;
  const p = createProject(store, orgId, { name: 'app', tier: 'Standard', target: 'https://github.com/acme/app' }, actor);
  scanId = enqueueScan(store, orgId, p.id, { requestedBy: actor }).id;
  markScanRunning(store, scanId);
  completeScan(store, scanId, { result });
}, 60_000);

afterAll(() => {
  try {
    closeStore(store);
  } catch {
    // closed in a test
  }
  rmSync(tmp, { recursive: true, force: true });
});

/** Every JSON value stored in any text column of any table. */
function storedJson(): { table: string; value: unknown }[] {
  const out: { table: string; value: unknown }[] = [];
  const tables = all<{ name: string }>(store, "SELECT name FROM sqlite_master WHERE type = 'table'");
  for (const { name } of tables) {
    for (const row of all<Record<string, unknown>>(store, `SELECT * FROM "${name}"`)) {
      for (const v of Object.values(row)) {
        if (typeof v !== 'string' || !/^[[{]/.test(v)) continue;
        try {
          out.push({ table: name, value: JSON.parse(v) });
        } catch {
          // not JSON
        }
      }
    }
  }
  return out;
}

function walk(v: unknown, pathKeys: string[], visit: (o: Record<string, unknown>, p: string[]) => void): void {
  if (Array.isArray(v)) v.forEach((x) => walk(x, [...pathKeys, '[]'], visit));
  else if (v && typeof v === 'object') {
    visit(v as Record<string, unknown>, pathKeys);
    for (const [k, x] of Object.entries(v)) walk(x, [...pathKeys, k], visit);
  }
}

describe('git history in the database', () => {
  it('stores the history with the scan', () => {
    const r = getScanResult(store, orgId, scanId)!.result;
    expect(r.history?.repos.map((x) => x.repo)).toEqual(['https://github.com/example/local', 'https://github.com/tukaani-project/xz']);
    // The xz windows do carry repo-level time-zone aggregates, so the checks below are not vacuous.
    expect(r.history!.repos[1]!.history.windows.some((w) => w.timeZones)).toBe(true);
  });

  it('has no per-person time-zone, hour, location or country field anywhere', () => {
    let tzObjects = 0;
    for (const { value } of storedJson()) {
      walk(value, [], (o, p) => {
        const keys = Object.keys(o);
        if (keys.some((k) => PERSON_KEYS.has(k))) {
          for (const k of keys) expect(k, `person-level object at ${p.join('.')}`).not.toMatch(PLACE_OR_TIME_RE);
        }
        if ('timeZones' in o) {
          tzObjects++;
          // Only on a repo-level 12-month window: { from, to, commits, contributors, … }.
          expect(p.slice(-1)).toEqual(['[]']);
          expect(p.slice(-2, -1)).toEqual(['windows']);
          expect(o.contributors as number).toBeGreaterThanOrEqual(5);
          const tz = o.timeZones as Record<string, unknown>;
          expect(Object.keys(tz).sort()).toEqual(['hourOfWeekUtc', 'offsets']);
          // Offsets map to commit counts, never to people.
          for (const [k, n] of Object.entries(tz.offsets as Record<string, unknown>)) {
            expect(k).toMatch(/^[+-]\d{4}$/);
            expect(typeof n).toBe('number');
          }
        }
      });
    }
    expect(tzObjects).toBeGreaterThan(0);
  });

  it('has no column for a time zone, hour, location or country in any table', () => {
    const tables = all<{ name: string }>(store, "SELECT name FROM sqlite_master WHERE type = 'table'");
    for (const { name } of tables) {
      for (const c of all<{ name: string }>(store, `PRAGMA table_info("${name}")`)) expect(`${name}.${c.name}`).not.toMatch(/time_?zone|utc_offset|tz_|hour_of|country|nationality/i);
    }
  });

  it('has no contributor email or name anywhere in the database file', () => {
    closeStore(store);
    const files = readdirSync(tmp).filter((f) => f.startsWith('br.db'));
    expect(files).toContain('br.db');
    for (const f of files) {
      const bytes = readFileSync(path.join(tmp, f));
      const text = bytes.toString('latin1');
      for (const s of LOCAL_SECRETS) expect(text.includes(s), `${s} in ${f}`).toBe(false);
      // The only email-shaped strings are the app user's own login, not contributors'.
      const emails = new Set(text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g) ?? []);
      for (const e of emails) expect(e).toContain('@company.test');
    }
    store = openStore({ path: dbFile });
  });
});
