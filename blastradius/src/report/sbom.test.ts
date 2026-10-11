import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as CDX from '@cyclonedx/cyclonedx-library';
import { Ajv } from 'ajv';
import addFormatsModule from 'ajv-formats';
import { makeFact, type Inventory, type ScanResult } from '../core/types.js';
import { buildLicenseReport } from '../licenses/report.js';
import { licenseValue, licenseValueFromStrings } from '../licenses/value.js';
import { parseCycloneDx } from '../ingest/syft.js';
import { renderCycloneDx, renderSpdx, toSpdx } from './sbom.js';
import { renderReport } from './index.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures', 'licenses');
const at = '2026-10-11T00:00:00.000Z';

const inventory: Inventory = {
  assets: [{ id: 'repo:app', kind: 'repo', name: 'app', environment: 'prod', criticality: 3, sourceFile: 'package.json' }],
  components: [
    { purl: 'pkg:npm/express@4.21.2', ecosystem: 'npm', name: 'express', version: '4.21.2' },
    { purl: 'pkg:npm/%40scope/dual@1.0.0', ecosystem: 'npm', name: '@scope/dual', version: '1.0.0' },
    { purl: 'pkg:maven/org.elasticsearch/elasticsearch@7.11.0', ecosystem: 'generic', name: 'org.elasticsearch:elasticsearch', version: '7.11.0' },
    { purl: 'pkg:pypi/sentry@20.10.1', ecosystem: 'generic', name: 'sentry', version: '20.10.1' },
    { purl: 'pkg:npm/private@1.0.0', ecosystem: 'npm', name: 'private', version: '1.0.0' },
    { purl: 'pkg:npm/nolicense@1.0.0', ecosystem: 'npm', name: 'nolicense', version: '1.0.0' },
  ],
  edges: [
    { from: 'repo:app', to: 'pkg:npm/express@4.21.2', scope: 'runtime', direct: true },
    { from: 'pkg:npm/express@4.21.2', to: 'pkg:npm/%40scope/dual@1.0.0', scope: 'runtime', direct: false },
  ],
};

const facts = [
  makeFact('license', 'pkg:npm/express@4.21.2', licenseValueFromStrings(['MIT'], '4.21.2'), { source: 'depsdev', fetchedAt: at }),
  makeFact('license', 'pkg:npm/%40scope/dual@1.0.0', licenseValueFromStrings(['(MIT OR Apache-2.0)'], '1.0.0'), { source: 'depsdev', fetchedAt: at }),
  makeFact(
    'license',
    'pkg:maven/org.elasticsearch/elasticsearch@7.11.0',
    licenseValue(
      [
        { raw: 'Server Side Public License, v 1', spdx: 'SSPL-1.0' },
        { raw: 'Elastic License 2.0', spdx: 'Elastic-2.0' },
      ],
      '7.11.0',
    ),
    { source: 'depsdev', fetchedAt: at },
  ),
  makeFact('license', 'pkg:pypi/sentry@20.10.1', licenseValue([{ raw: 'BSL-1.1', spdx: 'non-standard' }], '20.10.1'), { source: 'depsdev', fetchedAt: at }),
  makeFact('license', 'pkg:npm/private@1.0.0', licenseValueFromStrings(['UNLICENSED'], '1.0.0'), { source: 'lockfile', fetchedAt: at }),
  makeFact(
    'license_change',
    'pkg:maven/org.elasticsearch/elasticsearch',
    { version: '7.11.0', previousVersion: '7.10.2', from: ['Apache-2.0'], to: ['Elastic-2.0', 'SSPL-1.0'], fromStatus: 'spdx', toStatus: 'spdx', fromCategory: 'permissive', toCategory: 'source_available', added: ['Elastic-2.0', 'SSPL-1.0'], removed: ['Apache-2.0'], date: '2021-02-10T19:02:31Z' },
    { source: 'depsdev', fetchedAt: at },
  ),
];

const result: ScanResult = {
  schemaVersion: '1',
  target: 'app',
  generatedAt: at,
  inventory: { assets: 1, components: 6, edges: 2, directComponents: 1, byEcosystem: {}, byScope: {}, withInstallScripts: 0 },
  findings: [],
  licenses: buildLicenseReport(inventory, facts),
};

describe('CycloneDX 1.6 export', () => {
  const text = renderCycloneDx(result, inventory);
  const bom = JSON.parse(text);

  it('validates against the official CycloneDX 1.6 JSON schema', async () => {
    const errors = await new CDX.Validation.JsonStrictValidator(CDX.Spec.Version.v1dot6).validate(text);
    expect(errors).toBeNull();
  });

  it('carries declared licences, categories, sources and changes', () => {
    const byPurl = new Map<string, any>(bom.components.map((c: any) => [c.purl, c]));
    expect(byPurl.get('pkg:npm/express@4.21.2').licenses).toEqual([{ license: { id: 'MIT', acknowledgement: 'declared' } }]);
    expect(byPurl.get('pkg:npm/%40scope/dual@1.0.0').licenses).toEqual([{ expression: 'MIT OR Apache-2.0', acknowledgement: 'declared' }]);
    expect(byPurl.get('pkg:npm/%40scope/dual@1.0.0').group).toBe('@scope');
    const es = byPurl.get('pkg:maven/org.elasticsearch/elasticsearch@7.11.0');
    expect(es.licenses.map((l: any) => l.license.id).sort()).toEqual(['Elastic-2.0', 'SSPL-1.0']);
    expect(es.properties).toEqual(
      expect.arrayContaining([
        { name: 'blastradius:license:category', value: 'source_available' },
        { name: 'blastradius:license:source', value: 'depsdev' },
        { name: 'blastradius:license:change', value: '7.10.2 → 7.11.0: Apache-2.0 → Elastic-2.0 · SSPL-1.0 (2021-02-10)' },
      ]),
    );
    expect(byPurl.get('pkg:pypi/sentry@20.10.1').licenses).toEqual([{ license: { name: 'BSL-1.1', acknowledgement: 'declared' } }]);
    expect(byPurl.get('pkg:npm/nolicense@1.0.0').licenses).toBeUndefined();
    expect(bom.dependencies).toEqual(expect.arrayContaining([{ ref: 'root', dependsOn: ['pkg:npm/express@4.21.2'] }]));
  });

  it('round-trips through the SBOM import: same components, same licences', () => {
    const back = parseCycloneDx(bom);
    expect(back.components.map((c) => c.purl).sort()).toEqual(inventory.components.map((c) => c.purl).sort());
    const lic = new Map(back.components.map((c) => [c.purl, c.declaredLicenses?.values ?? []]));
    for (const row of result.licenses!.components) {
      const want = row.expressions.length ? row.expressions : (row.sources[0]?.raw ?? []);
      expect([...lic.get(row.purl)!].sort(), row.purl).toEqual([...want].sort());
    }
    expect(back.dependencies.get('pkg:npm/express@4.21.2')).toEqual(['pkg:npm/%40scope/dual@1.0.0']);
  });

  it('is deterministic', () => {
    expect(renderCycloneDx(result, inventory)).toBe(text);
  });
});

describe('SPDX 2.3 export', () => {
  const doc = toSpdx(result, inventory);

  it('validates against the published SPDX 2.3 JSON schema', () => {
    const schema = JSON.parse(readFileSync(join(FIXTURES, 'spdx-2.3.schema.json'), 'utf8'));
    const ajv = new Ajv({ strict: false, allErrors: true });
    // ajv-formats is CommonJS: its default export arrives as the module object under NodeNext.
    const addFormats = ((addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ?? addFormatsModule) as unknown as (a: Ajv) => void;
    addFormats(ajv);
    const validate = ajv.compile(schema);
    expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
  });

  it('declares licences, never concludes them, and defines every LicenseRef', () => {
    const byName = new Map(doc.packages.map((p) => [p.name, p]));
    expect(byName.get('express')).toMatchObject({ licenseDeclared: 'MIT', licenseConcluded: 'NOASSERTION' });
    expect(byName.get('@scope/dual')!.licenseDeclared).toBe('MIT OR Apache-2.0');
    expect(byName.get('org.elasticsearch:elasticsearch')!.licenseDeclared).toBe('Elastic-2.0 AND SSPL-1.0');
    expect(byName.get('org.elasticsearch:elasticsearch')!.licenseComments).toMatch(/without stating how they combine/);
    expect(byName.get('nolicense')!.licenseDeclared).toBe('NOASSERTION');
    const sentry = byName.get('sentry')!.licenseDeclared;
    expect(sentry).toMatch(/^LicenseRef-blastradius-[0-9a-f]{12}$/);
    expect(doc.hasExtractedLicensingInfos).toEqual(expect.arrayContaining([{ licenseId: sentry, extractedText: 'BSL-1.1', name: 'BSL-1.1' }]));
    expect(doc.relationships).toEqual(expect.arrayContaining([{ spdxElementId: 'SPDXRef-Root', relationshipType: 'DEPENDS_ON', relatedSpdxElement: byName.get('express')!.SPDXID }]));
    expect(renderSpdx(result, inventory)).toBe(renderReport(result, 'spdx', { inventory }));
  });
});

describe('HTML report Licences section', () => {
  it('lists components that need review with the deciding rule and the licence changes', () => {
    const html = renderReport(result, 'html');
    expect(html).toContain('<h2>Licences</h2>');
    expect(html).toContain('not legal advice');
    expect(html).toContain('category Source-available (Elastic-2.0)');
    expect(html).toContain('7.10.2 → 7.11.0');
    expect(html).not.toMatch(/<script/i);
  });
});
