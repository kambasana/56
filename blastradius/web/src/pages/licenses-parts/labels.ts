/**
 * Words for the Licences view (docs/UX.md §5: a shape and a word, never colour alone; colour
 * stays reserved for severity). Categories come from the server (Blue Oak Council, ScanCode
 * LicenseDB); these are only their display names.
 */
import type { LicenseCategory, LicensePolicyDecision, LicenseRow } from '@server/api-types';

export const CATEGORIES: readonly LicenseCategory[] = ['permissive', 'weak_copyleft', 'strong_copyleft', 'network_copyleft', 'source_available', 'proprietary', 'unknown'];

export const CATEGORY_LABEL: Readonly<Record<LicenseCategory, string>> = {
  permissive: 'Permissive',
  weak_copyleft: 'Weak copyleft',
  strong_copyleft: 'Strong copyleft',
  network_copyleft: 'Network copyleft',
  source_available: 'Source-available',
  proprietary: 'Proprietary',
  unknown: 'Unknown',
};

/** One line on what each category usually asks of you (kinds of obligation, not legal advice). */
export const CATEGORY_HINT: Readonly<Record<LicenseCategory, string>> = {
  permissive: 'Keep the notice. Few other conditions.',
  weak_copyleft: 'Share changes to the licensed files themselves.',
  strong_copyleft: 'Share the source of the whole work when you distribute it.',
  network_copyleft: 'Share the source also when users reach it over a network.',
  source_available: 'Source is readable, but use is restricted (not open source).',
  proprietary: 'No rights granted beyond a separate agreement.',
  unknown: 'No licence we could identify. Check before relying on it.',
};

export const DECISIONS: readonly LicensePolicyDecision[] = ['deny', 'review', 'allow'];

export const DECISION_LABEL: Readonly<Record<LicensePolicyDecision, string>> = { allow: 'Allowed', review: 'Needs review', deny: 'Denied' };
export const DECISION_GLYPH: Readonly<Record<LicensePolicyDecision, string>> = { allow: '✓', review: '◐', deny: '✕' };

export const SOURCE_LABEL: Readonly<Record<string, string>> = {
  depsdev: 'deps.dev',
  clearlydefined: 'ClearlyDefined',
  registry: 'Package registry',
  lockfile: 'package-lock.json',
  sbom: 'SBOM',
  none: 'No source',
};

export const STATUS_NOTE: Readonly<Record<string, string>> = {
  corrected: 'spelling corrected by spdx-correct',
  non_standard: 'not an SPDX licence',
  see_file: 'terms only in a file',
  unlicensed: 'npm UNLICENSED: no rights granted',
  unknown: 'no licence declared',
};

/** What to show as the licence: SPDX expressions, else the author's strings, else "Unknown". */
export function licenseText(r: Pick<LicenseRow, 'expressions' | 'status' | 'sources' | 'source'>): string {
  if (r.status === 'unlicensed') return 'UNLICENSED';
  if (r.expressions.length > 0) return r.expressions.join(' · ');
  const raw = r.sources.find((s) => s.source === r.source)?.raw ?? [];
  return raw.length > 0 ? raw.join(' · ') : 'Unknown';
}

export const pct = (n: number, of: number) => (of > 0 ? `${Math.round((n / of) * 1000) / 10}%` : '0%');
