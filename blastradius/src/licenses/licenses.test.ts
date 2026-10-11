import { describe, expect, it } from 'vitest';
import satisfies from 'spdx-satisfies';
import { categoryOfExpression, categoryOfId, categoryOfSet, CLASSIFICATION_SOURCES } from './classify.js';
import { DEFAULT_LICENSE_POLICY, evaluatePolicy, parseLicensePolicy, type LicensePolicy } from './policy.js';
import { changeRelation, detectLicenseChanges, sortReleases } from './history.js';
import { currentId, licenseIds, normalizeLicense } from './spdx.js';
import { licenseValue, licenseValueFromStrings } from './value.js';
import { buildLicenseReport } from './report.js';
import { makeFact, type Inventory } from '../core/types.js';

describe('normalizeLicense (spdx-expression-parse + guarded spdx-correct)', () => {
  it.each([
    ['MIT', 'spdx', 'MIT'],
    ['(MIT OR Apache-2.0)', 'spdx', 'MIT OR Apache-2.0'],
    ['(MIT OR Apache-2.0) AND BSD-3-Clause', 'spdx', '(MIT OR Apache-2.0) AND BSD-3-Clause'],
    ['AGPL-3.0', 'spdx', 'AGPL-3.0'],
    ['GPL-2.0-only WITH Classpath-exception-2.0', 'spdx', 'GPL-2.0-only WITH Classpath-exception-2.0'],
    ['mit', 'corrected', 'MIT'],
    ['Apache 2', 'corrected', 'Apache-2.0'],
    ['The Apache Software License, Version 2.0', 'corrected', 'Apache-2.0'],
    ['GPLv3', 'corrected', 'GPL-3.0-or-later'],
  ])('%s → %s %s', (raw, status, expression) => {
    expect(normalizeLicense(raw)).toMatchObject({ status, expression });
  });

  it.each([
    // spdx-correct would answer BSL-1.0 (Boost) / BSD-2-Clause / GPL-3.0-or-later: a version the author never wrote.
    ['BSL-1.1', 'non_standard'],
    ['BSD', 'non_standard'],
    ['GPL', 'non_standard'],
    ['Server Side Public License, v 1', 'non_standard'],
    ['non-standard', 'non_standard'],
    ['UNLICENSED', 'unlicensed'],
    ['SEE LICENSE IN LICENSE.md', 'see_file'],
    ['NOASSERTION', 'unknown'],
    ['', 'unknown'],
  ])('%s stays %s', (raw, status) => {
    const n = normalizeLicense(raw);
    expect(n.status).toBe(status);
    expect(n.expression).toBeUndefined();
  });

  it('maps deprecated GNU ids to their current form for classification', () => {
    expect(licenseIds('GPL-2.0+')).toEqual(['GPL-2.0-or-later']);
    expect(licenseIds('AGPL-3.0 OR LGPL-2.1')).toEqual(['AGPL-3.0-only', 'LGPL-2.1-only']);
    expect(currentId({ license: 'MIT' })).toBe('MIT');
  });
});

describe('categories from Blue Oak Council and ScanCode LicenseDB', () => {
  it.each([
    ['MIT', 'permissive', 'blueoak-list'],
    ['Apache-2.0', 'permissive', 'blueoak-list'],
    ['MPL-2.0', 'weak_copyleft', 'blueoak-copyleft'],
    ['LGPL-2.1-only', 'weak_copyleft', 'blueoak-copyleft'],
    ['GPL-3.0-only', 'strong_copyleft', 'blueoak-copyleft'],
    ['AGPL-3.0-only', 'network_copyleft', 'blueoak-copyleft'],
    // Blue Oak's copyleft guide lists SSPL in its network family; that listing wins over ScanCode's "Source-available".
    ['SSPL-1.0', 'network_copyleft', 'blueoak-copyleft'],
    ['BUSL-1.1', 'source_available', 'scancode'],
    ['Elastic-2.0', 'source_available', 'scancode'],
    ['LicenseRef-acme-internal', 'unknown', 'none'],
  ])('%s is %s (%s)', (id, category, by) => {
    expect(categoryOfId(id)).toEqual({ category, by });
  });

  it('combines with the SPDX operators: OR takes the least restrictive, AND the most', () => {
    expect(categoryOfExpression('MIT OR GPL-3.0-only')).toBe('permissive');
    expect(categoryOfExpression('MIT AND GPL-3.0-only')).toBe('strong_copyleft');
    expect(categoryOfExpression('(MIT OR AGPL-3.0-only) AND MPL-2.0')).toBe('weak_copyleft');
    expect(categoryOfExpression('MIT AND LicenseRef-x')).toBe('unknown');
    expect(categoryOfExpression('not an expression')).toBe('unknown');
    // A set whose relation the source does not state: all apply.
    expect(categoryOfSet(['Elastic-2.0', 'SSPL-1.0', 'AGPL-3.0'])).toBe('source_available');
    expect(categoryOfSet([])).toBe('unknown');
  });

  it('names its sources and their licences', () => {
    expect(CLASSIFICATION_SOURCES.map((s) => s.license)).toEqual(['CC0-1.0', 'CC0-1.0', 'CC-BY-4.0']);
  });
});

describe('licence policy', () => {
  const strict: LicensePolicy = {
    version: 1,
    categories: { ...DEFAULT_LICENSE_POLICY.categories, network_copyleft: 'deny', source_available: 'deny', strong_copyleft: 'review' },
    ids: [
      { id: 'MPL-2.0', decision: 'allow' },
      { id: 'GPL-2.0', decision: 'deny', note: 'written as the deprecated id' },
    ],
  };

  it('default template: permissive allowed, everything else reviewed, nothing denied', () => {
    expect(evaluatePolicy(['MIT'], 'spdx')).toEqual({ decision: 'allow', rule: 'category Permissive (MIT)' });
    expect(evaluatePolicy(['AGPL-3.0-only'], 'spdx').decision).toBe('review');
    expect(evaluatePolicy([], 'unknown')).toEqual({ decision: 'review', rule: 'unknown: no licence declared' });
    expect(evaluatePolicy([], 'non_standard').decision).toBe('review');
    expect(evaluatePolicy([], 'unlicensed').rule).toMatch(/UNLICENSED/);
  });

  it('id rules win over categories, OR picks the best option, AND the worst', () => {
    expect(evaluatePolicy(['MPL-2.0'], 'spdx', strict)).toEqual({ decision: 'allow', rule: 'licence MPL-2.0' });
    expect(evaluatePolicy(['AGPL-3.0-only'], 'spdx', strict)).toEqual({ decision: 'deny', rule: 'category Network copyleft (AGPL-3.0-only)' });
    expect(evaluatePolicy(['MIT OR AGPL-3.0-only'], 'spdx', strict).decision).toBe('allow');
    expect(evaluatePolicy(['MIT AND AGPL-3.0-only'], 'spdx', strict).decision).toBe('deny');
    expect(evaluatePolicy(['GPL-2.0'], 'spdx', strict)).toEqual({ decision: 'deny', rule: 'licence GPL-2.0' });
    // Unspecified relation between entries: all apply.
    expect(evaluatePolicy(['MIT', 'SSPL-1.0'], 'spdx', strict).decision).toBe('deny');
  });

  it('agrees with spdx-satisfies on what is allowed', () => {
    const allowed = ['MIT', 'ISC', 'Apache-2.0', 'MPL-2.0'];
    const policy: LicensePolicy = {
      version: 1,
      categories: { permissive: 'deny', weak_copyleft: 'deny', strong_copyleft: 'deny', network_copyleft: 'deny', source_available: 'deny', proprietary: 'deny', unknown: 'deny' },
      ids: allowed.map((id) => ({ id, decision: 'allow' as const })),
    };
    const ids = ['MIT', 'ISC', 'Apache-2.0', 'MPL-2.0', 'GPL-3.0-only', 'AGPL-3.0-only', 'BSD-3-Clause'];
    const exprs: string[] = [];
    for (const a of ids) for (const b of ids) for (const op of ['AND', 'OR']) exprs.push(`${a} ${op} ${b}`);
    for (const a of ids) for (const b of ids) exprs.push(`(${a} OR ${b}) AND MIT`, `(${a} AND ${b}) OR GPL-3.0-only`);
    for (const e of exprs) expect(evaluatePolicy([e], 'spdx', policy).decision === 'allow', e).toBe(satisfies(e, allowed));
  });

  it('validates a policy; unknown licences can never be allowed', () => {
    expect(parseLicensePolicy(DEFAULT_LICENSE_POLICY)).toEqual(DEFAULT_LICENSE_POLICY);
    expect(() => parseLicensePolicy({ ...DEFAULT_LICENSE_POLICY, categories: { ...DEFAULT_LICENSE_POLICY.categories, unknown: 'allow' } })).toThrow(/never allowed/);
    expect(() => parseLicensePolicy({ ...DEFAULT_LICENSE_POLICY, ids: [{ id: 'MIT OR ISC', decision: 'allow' }] })).toThrow(/one SPDX licence id/);
    expect(() => parseLicensePolicy({ ...DEFAULT_LICENSE_POLICY, extra: 1 })).toThrow();
    const dup = parseLicensePolicy({ ...DEFAULT_LICENSE_POLICY, ids: [{ id: 'MIT', decision: 'deny' }, { id: 'MIT', decision: 'allow' }] });
    expect(dup.ids).toEqual([{ id: 'MIT', decision: 'deny' }]);
  });
});

describe('licence history', () => {
  const r = (version: string, expressions: string[], extra: Partial<{ status: 'spdx' | 'non_standard' | 'unknown'; raw: string[]; publishedAt: string }> = {}) => ({
    version,
    expressions,
    status: extra.status ?? (expressions.length ? ('spdx' as const) : ('unknown' as const)),
    ...(extra.raw ? { raw: extra.raw } : {}),
    ...(extra.publishedAt ? { publishedAt: extra.publishedAt } : {}),
  });

  it('orders by version, skips pre-releases and gaps, ignores re-ordered lists', () => {
    const changes = detectLicenseChanges([
      r('1.10.0', ['SSPL-1.0', 'Elastic-2.0'], { publishedAt: '2021-02-10T00:00:00Z' }),
      r('1.2.0', ['Apache-2.0']),
      r('1.9.0', []),
      r('1.11.0-beta.1', ['MIT']),
      r('1.11.0', ['Elastic-2.0', 'SSPL-1.0']),
    ]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ previousVersion: '1.2.0', version: '1.10.0', unknownBetween: 1, date: '2021-02-10T00:00:00Z', fromCategory: 'permissive', toCategory: 'source_available' });
  });

  it('compares author strings when there is no SPDX form', () => {
    const changes = detectLicenseChanges([r('9.1.2', [], { status: 'non_standard', raw: ['BSD'] }), r('20.10.1', [], { status: 'non_standard', raw: ['BSL-1.1'] })]);
    expect(changes[0]).toMatchObject({ from: ['BSD'], to: ['BSL-1.1'], fromStatus: 'non_standard', toCategory: 'unknown' });
    expect(detectLicenseChanges([r('1.0.0', [], { status: 'non_standard', raw: ['BSD '] }), r('1.0.1', [], { status: 'non_standard', raw: ['bsd'] })])).toEqual([]);
  });

  it('places a change against the version in use', () => {
    expect(changeRelation({ version: '15.6.2' }, '15.6.1')).toBe('after_in_use');
    expect(changeRelation({ version: '15.6.2' }, '16.0.0')).toBe('in_use_or_earlier');
    expect(changeRelation({ version: '15.6.2' }, 'git-sha')).toBe('unknown');
    expect(sortReleases([{ version: 'v1.10.0' }, { version: 'v1.9.8' }, { version: 'v0.0.0-2014-abc' }]).map((x) => x.version)).toEqual(['v1.9.8', 'v1.10.0']);
  });
});

describe('licence values and report', () => {
  it('uses the source SPDX mapping, keeps the author string, marks corrections', () => {
    const v = licenseValue([{ raw: 'The Apache Software License, Version 2.0', spdx: 'Apache-2.0' }], '0.10.0');
    expect(v).toMatchObject({ raw: ['The Apache Software License, Version 2.0'], expressions: ['Apache-2.0'], status: 'spdx', category: 'permissive' });
    const c = licenseValueFromStrings(['Apache 2'], '1.0.0');
    expect(c).toMatchObject({ status: 'corrected', corrected: [{ from: 'Apache 2', to: 'Apache-2.0' }] });
    expect(licenseValueFromStrings(['MIT', 'BSD'], '1.0.0')).toMatchObject({ status: 'non_standard', category: 'unknown', expressions: ['MIT'] });
    expect(licenseValueFromStrings(['UNLICENSED'], '1.0.0')).toMatchObject({ status: 'unlicensed', category: 'proprietary' });
  });

  it('prefers deps.dev, then ClearlyDefined, then the lockfile, and counts unknowns', () => {
    const inv: Inventory = {
      assets: [],
      edges: [],
      components: [
        { purl: 'pkg:npm/a@1.0.0', ecosystem: 'npm', name: 'a', version: '1.0.0' },
        { purl: 'pkg:npm/b@1.0.0', ecosystem: 'npm', name: 'b', version: '1.0.0' },
        { purl: 'pkg:npm/c@1.0.0', ecosystem: 'npm', name: 'c', version: '1.0.0' },
      ],
    };
    const at = '2026-10-11T00:00:00Z';
    const facts = [
      makeFact('license', 'pkg:npm/a@1.0.0', licenseValueFromStrings(['ISC'], '1.0.0'), { source: 'lockfile', fetchedAt: at }),
      makeFact('license', 'pkg:npm/a@1.0.0', licenseValueFromStrings(['MIT'], '1.0.0'), { source: 'depsdev', fetchedAt: at, evidence: ['https://deps.dev/npm/a/1.0.0'] }),
      makeFact('license', 'pkg:npm/b@1.0.0', licenseValueFromStrings([], '1.0.0'), { source: 'depsdev', fetchedAt: at }),
      makeFact('license', 'pkg:npm/b@1.0.0', licenseValueFromStrings(['GPL-3.0-only'], '1.0.0'), { source: 'lockfile', fetchedAt: at }),
    ];
    const report = buildLicenseReport(inv, facts);
    expect(report.components.map((c) => [c.name, c.source, c.expressions.join(), c.category, c.disagreement])).toEqual([
      ['a', 'depsdev', 'MIT', 'permissive', true],
      ['b', 'lockfile', 'GPL-3.0-only', 'strong_copyleft', false],
      ['c', 'none', '', 'unknown', false],
    ]);
    expect(report.counts).toMatchObject({ permissive: 1, strong_copyleft: 1, unknown: 1 });
    expect(report.note).toMatch(/not legal advice/);
  });
});
