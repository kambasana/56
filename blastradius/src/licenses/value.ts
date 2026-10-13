/** Build `license` fact values from what each source returns. */
import type { LicenseStatus, LicenseValue } from '../core/types.js';
import { categoryOfSet } from './classify.js';
import { normalizeLicense, parseSpdx, weakestStatus, type NormalizedLicense } from './spdx.js';

/** One declared entry: the author's string and, when the source mapped it, its SPDX form. */
export interface DeclaredEntry {
  raw: string;
  /** deps.dev licenseDetails[].spdx ("non-standard" when it could not map). */
  spdx?: string;
}

function readEntry(e: DeclaredEntry): NormalizedLicense {
  // A source's own valid SPDX mapping is used as is; otherwise read the author's string.
  if (e.spdx && e.spdx.toLowerCase() !== 'non-standard') {
    const ast = parseSpdx(e.spdx);
    if (ast) return { ...normalizeLicense(e.spdx), raw: e.raw || e.spdx };
  }
  return normalizeLicense(e.raw || e.spdx || '');
}

/** LicenseValue for one version from declared entries (empty list = the source has none). */
export function licenseValue(entries: readonly DeclaredEntry[], version: string): LicenseValue {
  const read = entries.filter((e) => (e.raw || e.spdx || '').trim() !== '').slice(0, 20).map(readEntry);
  const expressions = [...new Set(read.map((r) => r.expression).filter((x): x is string => !!x))].sort();
  const statuses: LicenseStatus[] = read.map((r) => r.status);
  const status = weakestStatus(statuses);
  const value: LicenseValue = {
    raw: [...new Set(read.map((r) => r.raw))],
    expressions,
    status,
    category: status === 'unlicensed' ? 'proprietary' : status === 'spdx' || status === 'corrected' ? categoryOfSet(expressions) : 'unknown',
    version,
  };
  const corrected = read.filter((r) => r.status === 'corrected' && r.expression).map((r) => ({ from: r.raw, to: r.expression! }));
  if (corrected.length > 0) value.corrected = corrected;
  return value;
}

/** Same value from plain strings (package.json `license`, SBOM, deps.dev v3 `licenses`). */
export function licenseValueFromStrings(values: readonly string[], version: string): LicenseValue {
  return licenseValue(
    values.map((raw) => ({ raw })),
    version,
  );
}

/** Two values declare the same licences (normalised sets, or both unknown). */
export function sameLicenses(a: Pick<LicenseValue, 'expressions' | 'status'>, b: Pick<LicenseValue, 'expressions' | 'status'>): boolean {
  const ka = a.expressions.join('\u0000');
  const kb = b.expressions.join('\u0000');
  if (ka === '' && kb === '') return a.status === b.status || (a.status !== 'unlicensed' && b.status !== 'unlicensed');
  return ka === kb;
}
