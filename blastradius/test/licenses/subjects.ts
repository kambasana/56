/**
 * Validation subjects for licence changes (docs/WHO-BEHIND-PLAN.md §8 rows 8–10, adapted to what
 * deps.dev actually returns; see the P1 gate result in that document). Each is a real package at a
 * real version; fixtures are recorded once by record.ts and replayed offline by licenses.test.ts.
 */
export interface LicenseSubject {
  purl: string;
  /** Why it is here. */
  role: 'relicensed' | 'control' | 'plan-row';
  note: string;
}

export const LICENSE_SUBJECTS: readonly LicenseSubject[] = [
  // Relicensing events deps.dev records in package metadata.
  { purl: 'pkg:maven/org.elasticsearch/elasticsearch@7.10.2', role: 'relicensed', note: 'Apache-2.0 → SSPL-1.0/Elastic-2.0 at 7.11.0 (2021); AGPL-3.0 added at 8.16.0 (2024)' },
  { purl: 'pkg:npm/react@15.6.1', role: 'relicensed', note: 'BSD-3-Clause (+ patents grant) → MIT at 15.6.2 (2017-09-26)' },
  { purl: 'pkg:npm/immutable@3.8.2', role: 'relicensed', note: 'BSD-3-Clause → MIT at 3.8.2 (2017-10)' },
  { purl: 'pkg:pypi/sentry@9.1.2', role: 'relicensed', note: '"BSD" → "BSL-1.1" at 10.0.0 (2020-01-07, PyPI info.license); deps.dev has no licence data for 10.0.0–20.8.0' },
  // Plan row 8: deps.dev reads Go licences with licensecheck, which does not report BUSL-1.1.
  { purl: 'pkg:golang/github.com/hashicorp/terraform@v1.5.7', role: 'plan-row', note: 'MPL-2.0 → BUSL-1.1 at v1.6.0 upstream; deps.dev shows MPL-2.0 for every release' },
  // Controls: no relicensing known; licence history must stay quiet.
  { purl: 'pkg:npm/express@4.21.2', role: 'control', note: 'MIT throughout' },
  { purl: 'pkg:npm/lodash@4.17.21', role: 'control', note: 'MIT throughout' },
  { purl: 'pkg:npm/%40babel/core@7.24.0', role: 'control', note: 'MIT throughout' },
  { purl: 'pkg:npm/webpack@5.94.0', role: 'control', note: 'MIT throughout' },
  { purl: 'pkg:npm/chalk@5.3.0', role: 'control', note: 'MIT throughout' },
];
