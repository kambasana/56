/**
 * CVSS helpers for OSV records.
 *
 * Computes the CVSS v3.0/v3.1 base score from a vector string (FIRST spec
 * §7.1 / Appendix A rounding). CVSS v2 and v4 vectors are recognised but not
 * scored here; callers fall back to the advisory's own severity label.
 */
import type { Severity } from '../../core/types.js';

const AV: Record<string, number> = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 };
const AC: Record<string, number> = { L: 0.77, H: 0.44 };
const PR_U: Record<string, number> = { N: 0.85, L: 0.62, H: 0.27 };
const PR_C: Record<string, number> = { N: 0.85, L: 0.68, H: 0.5 };
const UI: Record<string, number> = { N: 0.85, R: 0.62 };
const CIA: Record<string, number> = { H: 0.56, L: 0.22, N: 0 };

/** CVSS v3.1 Roundup: smallest number with one decimal >= input (float-safe). */
export function roundUp1(x: number): number {
  const i = Math.round(x * 100000);
  return i % 10000 === 0 ? i / 100000 : (Math.floor(i / 10000) + 1) / 10;
}

/**
 * Base score for a CVSS v3.x vector ("CVSS:3.1/AV:N/AC:L/..."), or undefined
 * when the vector is not v3 or is missing a base metric.
 */
export function cvss3BaseScore(vector: string): number | undefined {
  if (typeof vector !== 'string' || vector.length > 300) return undefined;
  const parts = vector.trim().split('/');
  if (!/^CVSS:3\.[01]$/.test(parts[0] ?? '')) return undefined;
  const m = new Map<string, string>();
  for (const p of parts.slice(1)) {
    const [k, v] = p.split(':');
    if (k && v && !m.has(k)) m.set(k, v);
  }
  const s = m.get('S');
  if (s !== 'U' && s !== 'C') return undefined;
  const av = AV[m.get('AV') ?? ''];
  const ac = AC[m.get('AC') ?? ''];
  const pr = (s === 'C' ? PR_C : PR_U)[m.get('PR') ?? ''];
  const ui = UI[m.get('UI') ?? ''];
  const c = CIA[m.get('C') ?? ''];
  const i = CIA[m.get('I') ?? ''];
  const a = CIA[m.get('A') ?? ''];
  if ([av, ac, pr, ui, c, i, a].some((x) => x === undefined)) return undefined;

  const iss = 1 - (1 - c!) * (1 - i!) * (1 - a!);
  const impact = s === 'U' ? 6.42 * iss : 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15);
  const exploitability = 8.22 * av! * ac! * pr! * ui!;
  if (impact <= 0) return 0;
  return s === 'U' ? roundUp1(Math.min(impact + exploitability, 10)) : roundUp1(Math.min(1.08 * (impact + exploitability), 10));
}

/** Qualitative severity for a CVSS base score (v3 bands). */
export function severityForCvss(score: number): Severity {
  if (!Number.isFinite(score) || score < 0) return 'unknown';
  if (score >= 9) return 'critical';
  if (score >= 7) return 'high';
  if (score >= 4) return 'medium';
  return 'low';
}

/** Map an advisory severity label (GitHub: CRITICAL/HIGH/MODERATE/LOW) to our Severity. */
export function severityFromLabel(label: unknown): Severity {
  if (typeof label !== 'string') return 'unknown';
  switch (label.trim().toUpperCase()) {
    case 'CRITICAL':
      return 'critical';
    case 'HIGH':
      return 'high';
    case 'MODERATE':
    case 'MEDIUM':
      return 'medium';
    case 'LOW':
      return 'low';
    default:
      return 'unknown';
  }
}
