/**
 * P1 gate (docs/WHO-BEHIND-PLAN.md §6, §8 rows 8–10 adapted to recorded deps.dev data): the
 * licences enricher, replayed offline on real deps.dev / ClearlyDefined responses recorded by
 * record.ts, reports the real relicensing events and nothing on the control packages.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { HttpClient } from '../../src/core/http.js';
import { parsePurl, type Component, type Fact, type Inventory, type LicenseChangeValue } from '../../src/core/types.js';
import { createLicenseEnricher } from '../../src/enrich/licenses/index.js';
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

  it('sentry (PyPI): "BSD" → "BSL-1.1", neither mapped to SPDX by deps.dev, across releases without licence data', () => {
    const ch = changesOf('pkg:pypi/sentry');
    expect(ch).toHaveLength(1);
    expect(ch[0]).toMatchObject({ previousVersion: '9.1.2', version: '20.10.1', from: ['BSD'], to: ['BSL-1.1'], fromStatus: 'non_standard', toStatus: 'non_standard', fromCategory: 'unknown' });
    expect(ch[0]!.unknownBetween).toBeGreaterThan(0);
  });

  it('Terraform (Go): deps.dev reports MPL-2.0 for every release, so the upstream BUSL-1.1 change at v1.6.0 is not visible', () => {
    // Recorded result, written up in docs/WHO-BEHIND-PLAN.md (P1 gate): deps.dev derives Go
    // licences with licensecheck, which does not recognise BUSL-1.1.
    expect(changesOf('pkg:golang/github.com/hashicorp/terraform')).toEqual([]);
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
