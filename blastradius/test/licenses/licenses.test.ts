/**
 * P1 gate (docs/WHO-BEHIND-PLAN.md §6, §8 rows 8–10 adapted to recorded deps.dev data): the
 * licences enricher, replayed offline on real deps.dev / ClearlyDefined responses recorded by
 * record.ts, reports the real relicensing events and nothing on the control packages. Releases
 * without deps.dev licence data are filled from the package registry's own metadata (recorded
 * PyPI JSON API responses for sentry).
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { HttpClient } from '../../src/core/http.js';
import { parsePurl, type Component, type Fact, type Inventory, type LicenseChangeValue } from '../../src/core/types.js';
import { createLicenseEnricher } from '../../src/enrich/licenses/index.js';
import { describeChangePlacement } from '../../src/licenses/history.js';
import { buildLicenseReport } from '../../src/licenses/report.js';
import { LICENSE_SUBJECTS } from './subjects.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'licenses');

let facts: Fact[] = [];
const warnings: string[] = [];
let inventory: Inventory;

function changesOf(pkg: string): LicenseChangeValue[] {
  return facts.filter((f): f is Extract<Fact, { kind: 'license_change' }> => f.kind === 'license_change' && f.subject === pkg).map((f) => f.value);
}

beforeAll(async () => {
  const components: Component[] = LICENSE_SUBJECTS.map((s) => {
    const p = parsePurl(s.purl);
    const name = p.namespace ? `${p.namespace}${p.type === 'maven' ? ':' : '/'}${p.name}` : p.name;
    return { purl: s.purl, ecosystem: p.type === 'npm' ? 'npm' : 'generic', name, version: p.version! };
  });
  inventory = { assets: [], components, edges: [] };
  const http = new HttpClient({ offline: true, fixturesDir: FIXTURES, cacheDir: false, transport: () => Promise.reject(new Error('no network in tests')) });
  facts = await createLicenseEnricher().enrich(inventory, { http, now: new Date('2026-10-11T00:00:00Z'), offline: true, warn: (m) => warnings.push(m) });
});

describe('licence changes on recorded deps.dev data (P1 gate)', () => {
  it('replays fully offline', () => {
    expect(warnings).toEqual([]);
  });

  it('Elasticsearch: Apache-2.0 → SSPL-1.0 / Elastic-2.0 at 7.11.0, then AGPL-3.0 added at 8.16.0', () => {
    const ch = changesOf('pkg:maven/org.elasticsearch/elasticsearch');
    expect(ch.map((c) => [c.previousVersion, c.version])).toEqual([
      ['7.10.2', '7.11.0'],
      ['8.15.5', '8.16.0'],
    ]);
    expect(ch[0]).toMatchObject({ from: ['Apache-2.0'], to: ['Elastic-2.0', 'SSPL-1.0'], fromCategory: 'permissive', toCategory: 'source_available', added: ['Elastic-2.0', 'SSPL-1.0'], removed: ['Apache-2.0'] });
    expect(ch[0]!.date?.slice(0, 10)).toBe('2021-02-10');
    // deps.dev does not say how the three combine, so the category stays the most restrictive.
    expect(ch[1]).toMatchObject({ added: ['AGPL-3.0-only'], removed: [], fromCategory: 'source_available', toCategory: 'source_available' });
    expect(ch[1]!.date?.slice(0, 10)).toBe('2024-11-12');
  });

  it('React: BSD-3-Clause → MIT at 15.6.2 (2017-09-26), after the version in use', () => {
    const ch = changesOf('pkg:npm/react');
    expect(ch).toHaveLength(1);
    expect(ch[0]).toMatchObject({ previousVersion: '15.6.1', version: '15.6.2', from: ['BSD-3-Clause'], to: ['MIT'], fromCategory: 'permissive', toCategory: 'permissive' });
    expect(ch[0]!.date?.slice(0, 10)).toBe('2017-09-26');
    const report = buildLicenseReport(inventory, facts);
    expect(report.changes.find((c) => c.name === 'react')).toMatchObject({ relation: 'after_in_use', inUse: ['15.6.1'], categoryChange: false });
  });

  it('immutable: BSD-3-Clause → MIT at 3.8.2', () => {
    expect(changesOf('pkg:npm/immutable').at(-1)).toMatchObject({ previousVersion: '3.8.1', version: '3.8.2', from: ['BSD-3-Clause'], to: ['MIT'] });
  });

  it('sentry (PyPI): "BSD" → "BSL-1.1" at 10.0.0 (2020-01-07), from PyPI metadata where deps.dev has a gap', () => {
    // deps.dev has "BSD" for 9.1.2, no licence data for 10.0.0–20.8.0 and "BSL-1.1" from 20.10.1.
    // PyPI's own info.license for 10.0.0 is "BSL-1.1" (classifier "Other/Proprietary License"),
    // so the change is placed at 10.0.0, not at the first release deps.dev has data for again.
    const facts1 = facts.filter((f): f is Extract<Fact, { kind: 'license_change' }> => f.kind === 'license_change' && f.subject === 'pkg:pypi/sentry');
    expect(facts1).toHaveLength(1);
    const [f] = facts1;
    expect(f!.source).toBe('registry');
    expect(f!.value).toMatchObject({ previousVersion: '9.1.2', version: '10.0.0', from: ['BSD'], to: ['BSL-1.1'], fromStatus: 'non_standard', toStatus: 'non_standard', fromSource: 'depsdev', toSource: 'registry' });
    expect(f!.value.unknownBetween).toBeUndefined();
    expect(f!.value.date?.slice(0, 10)).toBe('2020-01-07');
    // deps.dev's own view stays visible: a range across its gap.
    expect(f!.value.primary).toEqual({ source: 'depsdev', previousVersion: '9.1.2', version: '20.10.1', unknownBetween: 7 });
    expect(f!.evidence?.[0]).toBe('https://pypi.org/pypi/sentry/10.0.0/json');
    expect(f!.evidence).toContain('https://deps.dev/pypi/sentry/10.0.0');
  });

  it('sentry without registry data: reported as a range across deps.dev\'s gap, never pinned to 20.10.1', async () => {
    const http = new HttpClient({ offline: true, fixturesDir: FIXTURES, cacheDir: false, transport: () => Promise.reject(new Error('no network in tests')) });
    const notes: string[] = [];
    const without = await createLicenseEnricher({ registry: false }).enrich(inventory, { http, now: new Date('2026-10-11T00:00:00Z'), offline: true, warn: (m) => notes.push(m) });
    expect(notes).toEqual([]);
    const ch = without.filter((f): f is Extract<Fact, { kind: 'license_change' }> => f.kind === 'license_change' && f.subject === 'pkg:pypi/sentry');
    expect(ch).toHaveLength(1);
    expect(ch[0]!.source).toBe('depsdev');
    expect(ch[0]!.value).toMatchObject({ previousVersion: '9.1.2', version: '20.10.1', unknownBetween: 7 });
    expect(describeChangePlacement(ch[0]!.value)).toBe('changed between 9.1.2 and 20.10.1; 7 releases in between had no licence data');
  });

  it('sentry: "already in the version you use" follows the corrected release', () => {
    const at = (version: string) => {
      const inv: Inventory = { assets: [], edges: [], components: [{ purl: `pkg:pypi/sentry@${version}`, ecosystem: 'generic', name: 'sentry', version }] };
      return buildLicenseReport(inv, facts).changes.find((c) => c.name === 'sentry')!.relation;
    };
    expect(at('9.1.2')).toBe('after_in_use');
    // Before the fix, 10.0.0 was told "upgrading past it changes the licence" (change at 20.10.1).
    expect(at('10.0.0')).toBe('in_use_or_earlier');
    expect(at('20.7.0')).toBe('in_use_or_earlier');
  });

  it('Terraform (Go): deps.dev reports MPL-2.0 for every release, so the upstream BUSL-1.1 change at v1.6.0 is not visible', () => {
    // Recorded result, written up in docs/WHO-BEHIND-PLAN.md (P1 gate): deps.dev derives Go
    // licences with licensecheck, which does not recognise BUSL-1.1.
    expect(changesOf('pkg:golang/github.com/hashicorp/terraform')).toEqual([]);
  });

  it('the registry is asked only where deps.dev has a gap: Elasticsearch, React, immutable and the controls are unchanged', () => {
    const registry = facts.filter((f) => f.source === 'registry');
    expect([...new Set(registry.map((f) => f.subject))].sort()).toEqual(['pkg:pypi/sentry', 'pkg:pypi/sentry@9.1.2'].sort());
    for (const pkg of ['pkg:maven/org.elasticsearch/elasticsearch', 'pkg:npm/react', 'pkg:npm/immutable']) {
      for (const c of changesOf(pkg)) expect(c, pkg).not.toHaveProperty('fromSource');
    }
  });

  it('control packages show no licence change', () => {
    for (const s of LICENSE_SUBJECTS.filter((x) => x.role === 'control')) {
      const p = parsePurl(s.purl);
      const pkg = `pkg:${p.type}/${p.namespace ? `${encodeURIComponent(p.namespace)}/` : ''}${p.name}`;
      expect(changesOf(pkg), s.purl).toEqual([]);
    }
  });

  it('records the source of every licence value and shows where sources disagree', () => {
    const report = buildLicenseReport(inventory, facts);
    const react = report.components.find((c) => c.name === 'react')!;
    expect(react.source).toBe('depsdev');
    expect(react.sources.map((s) => s.source)).toEqual(['depsdev', 'clearlydefined']);
    expect(react.sources[1]!.expressions).toEqual(['BSD-3-Clause AND LicenseRef-scancode-facebook-patent-rights-2']);
    expect(react.disagreement).toBe(true);
    expect(react.sources[0]!.evidence?.[0]).toBe('https://deps.dev/npm/react/15.6.1');
    const sentry = report.components.find((c) => c.name === 'sentry')!;
    // deps.dev has the author's "BSD" with no SPDX form; ClearlyDefined's curated value is used.
    expect(sentry).toMatchObject({ source: 'clearlydefined', expressions: ['BSD-3-Clause'], category: 'permissive', disagreement: false });
    // PyPI's own metadata is a separate source with its evidence URL.
    expect(sentry.sources.map((s) => s.source)).toEqual(['depsdev', 'clearlydefined', 'registry']);
    expect(sentry.sources[2]).toMatchObject({ raw: ['BSD'], status: 'non_standard', evidence: ['https://pypi.org/pypi/sentry/9.1.2/json'] });
    expect(report.changes.find((c) => c.name === 'sentry')).toMatchObject({ source: 'registry', version: '10.0.0', relation: 'after_in_use' });
    const express = report.components.find((c) => c.name === 'express')!;
    expect(express).toMatchObject({ expressions: ['MIT'], category: 'permissive', disagreement: false });
    expect(report.counts.unknown).toBe(0);
  });
});

describe('GitHub Actions: the repository licence, marked as such', () => {
  it('uses deps.dev GetProject for actions, and not in a replay', async () => {
    const inv: Inventory = {
      assets: [],
      edges: [],
      components: [
        { purl: 'pkg:githubactions/actions/checkout@v4', ecosystem: 'githubactions', name: 'actions/checkout', version: 'v4' },
        { purl: 'pkg:githubactions/actions/setup-node@v4', ecosystem: 'githubactions', name: 'actions/setup-node', version: 'v4' },
      ],
    };
    const http = new HttpClient({ offline: true, fixturesDir: FIXTURES, cacheDir: false, transport: () => Promise.reject(new Error('no network in tests')) });
    const notes: string[] = [];
    const live = await createLicenseEnricher({ clearlyDefined: false }).enrich(inv, { http, now: new Date('2026-10-11T00:00:00Z'), offline: true, warn: (m) => notes.push(m) });
    expect(notes).toEqual([]);
    expect(live.map((f) => [f.subject, f.kind === 'license' ? [f.value.expressions, f.value.basis] : null])).toEqual([
      ['pkg:githubactions/actions/checkout@v4', [['MIT'], 'repository']],
      ['pkg:githubactions/actions/setup-node@v4', [['MIT'], 'repository']],
    ]);
    const replay = await createLicenseEnricher({ clearlyDefined: false }).enrich(inv, { http, now: new Date('2018-11-27T00:00:00Z'), offline: true, historical: true });
    expect(replay).toEqual([]);
  });
});

describe('registry gap fill in the enricher (synthetic responses)', () => {
  // Synthetic package "gapdemo": deps.dev has MIT for 1.0.0 and BUSL-1.1 for 1.3.0, no licence
  // data for 1.1.0 and 1.2.0. Not real data: it exercises the npm packument path and the PyPI
  // field order, which the recorded subjects do not.
  const depsdev = (system: string, name: string) => (req: { url: string; body?: string }) => {
    if (req.url === `https://api.deps.dev/v3/systems/${system.toLowerCase()}/packages/${encodeURIComponent(name)}`) {
      return { versions: ['1.0.0', '1.1.0', '1.2.0', '1.3.0'].map((version) => ({ versionKey: { version } })) };
    }
    if (req.url === 'https://api.deps.dev/v3alpha/versionbatch') {
      const lic: Record<string, string | undefined> = { '1.0.0': 'MIT', '1.3.0': 'BUSL-1.1' };
      const body = JSON.parse(req.body!) as { requests: { versionKey: { system: string; name: string; version: string } }[] };
      return { responses: body.requests.map((r) => ({ request: r, version: { licenseDetails: lic[r.versionKey.version] ? [{ license: lic[r.versionKey.version], spdx: lic[r.versionKey.version] }] : [] } })) };
    }
    return undefined;
  };
  const run = async (purl: string, routes: (req: { url: string; body?: string }) => unknown, opts: { registry?: boolean } = {}) => {
    const asked: string[] = [];
    const http = new HttpClient({
      offline: false,
      cacheDir: false,
      transport: async (req) => {
        asked.push(req.url);
        const r = routes(req);
        return r === undefined ? { status: 404, body: '' } : { status: 200, body: JSON.stringify(r) };
      },
    });
    const p = parsePurl(purl);
    const inv: Inventory = { assets: [], edges: [], components: [{ purl, ecosystem: p.type === 'npm' ? 'npm' : 'generic', name: p.name, version: p.version! }] };
    const notes: string[] = [];
    const out = await createLicenseEnricher({ clearlyDefined: false, ...opts }).enrich(inv, { http, now: new Date('2026-10-11T00:00:00Z'), offline: false, warn: (m) => notes.push(m) });
    expect(notes).toEqual([]);
    return { out, asked, changes: out.filter((f): f is Extract<Fact, { kind: 'license_change' }> => f.kind === 'license_change') };
  };

  it('npm: the per-version licence in the packument places the change at 1.1.0', async () => {
    const routes = (req: { url: string; body?: string }) =>
      depsdev('NPM', 'gapdemo')(req) ??
      (req.url === 'https://registry.npmjs.org/gapdemo'
        ? { name: 'gapdemo', versions: { '1.0.0': { license: 'MIT' }, '1.1.0': { license: { type: 'BUSL-1.1' } }, '1.2.0': { licenses: [{ type: 'BUSL-1.1' }] }, '1.3.0': { license: 'BUSL-1.1' } }, time: { '1.1.0': '2023-08-10T00:00:00Z' } }
        : undefined);
    const { changes, out } = await run('pkg:npm/gapdemo@1.0.0', routes);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.source).toBe('registry');
    expect(changes[0]!.value).toMatchObject({ previousVersion: '1.0.0', version: '1.1.0', from: ['MIT'], to: ['BUSL-1.1'], date: '2023-08-10T00:00:00Z', fromCategory: 'permissive', toCategory: 'source_available', primary: { previousVersion: '1.0.0', version: '1.3.0', unknownBetween: 2 } });
    expect(changes[0]!.evidence?.[0]).toBe('https://www.npmjs.com/package/gapdemo/v/1.1.0');
    expect(out.find((f) => f.kind === 'license' && f.source === 'registry')).toMatchObject({ subject: 'pkg:npm/gapdemo@1.0.0', evidence: ['https://www.npmjs.com/package/gapdemo/v/1.0.0'] });
  });

  it('PyPI: license_expression, then license, then classifiers', async () => {
    const info: Record<string, unknown> = {
      '1.0.0': { license: 'MIT', classifiers: ['License :: OSI Approved :: MIT License'] },
      '1.1.0': { license_expression: 'BUSL-1.1', license: 'whatever' },
      // 1.2.0: not on PyPI (404).
      '1.3.0': { license: 'UNKNOWN', classifiers: ['License :: Other/Proprietary License'] },
    };
    const routes = (req: { url: string; body?: string }) => {
      const d = depsdev('PYPI', 'gapdemo')(req);
      if (d) return d;
      const m = /^https:\/\/pypi\.org\/pypi\/gapdemo\/([^/]+)\/json$/.exec(req.url);
      return m && info[m[1]!] ? { info: info[m[1]!], urls: [{ upload_time_iso_8601: '2023-08-10T00:00:00Z' }] } : undefined;
    };
    const { changes, asked } = await run('pkg:pypi/gapdemo@1.0.0', routes);
    expect(asked.filter((u) => u.startsWith('https://pypi.org/'))).toHaveLength(4);
    // 1.0.0 MIT → 1.1.0 BUSL-1.1 (registry). 1.1.0 (registry BUSL-1.1) and 1.3.0 (deps.dev
    // BUSL-1.1) state the same licence, so the registry's classifier for 1.3.0 is not a change.
    expect(changes.map((c) => [c.value.previousVersion, c.value.version, c.value.unknownBetween ?? 0, c.source])).toEqual([['1.0.0', '1.1.0', 0, 'registry']]);
    expect(changes[0]!.evidence?.[0]).toBe('https://pypi.org/pypi/gapdemo/1.1.0/json');
  });

  it('PyPI: a 404 in the gap with no other data keeps the change a range', async () => {
    const routes = (req: { url: string; body?: string }) => {
      const d = depsdev('PYPI', 'gapdemo')(req);
      if (d) return d;
      const m = /^https:\/\/pypi\.org\/pypi\/gapdemo\/([^/]+)\/json$/.exec(req.url);
      return m && m[1] === '1.0.0' ? { info: { license: 'MIT' } } : m && m[1] === '1.3.0' ? { info: { license_expression: 'BUSL-1.1' } } : undefined;
    };
    const { changes } = await run('pkg:pypi/gapdemo@1.0.0', routes);
    expect(changes.map((c) => [c.source, c.value.previousVersion, c.value.version, c.value.unknownBetween])).toEqual([['depsdev', '1.0.0', '1.3.0', 2]]);
  });

  it('registry: false keeps the deps.dev range and asks no registry', async () => {
    const { changes, asked } = await run('pkg:npm/gapdemo@1.0.0', depsdev('NPM', 'gapdemo'), { registry: false });
    expect(asked.some((u) => u.includes('registry.npmjs.org'))).toBe(false);
    expect(changes.map((c) => [c.source, c.value.previousVersion, c.value.version, c.value.unknownBetween])).toEqual([['depsdev', '1.0.0', '1.3.0', 2]]);
  });
});
