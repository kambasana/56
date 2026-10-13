/**
 * Severity and reach vocabulary (docs/UX.md §5). Severity is always a shape plus a word, never
 * colour alone; reach is a separate dimension and never a hue.
 */
import type { RiskLevel } from '@server/api-types';

export type Severity = RiskLevel;

/** Most severe first. */
export const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low'];

export const SEVERITY_LABEL: Readonly<Record<Severity, string>> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };

/** ◆ Critical, ▲ High, ● Medium, ○ Low. */
export const SEVERITY_GLYPH: Readonly<Record<Severity, string>> = { critical: '◆', high: '▲', medium: '●', low: '○' };

export function isSeverity(v: unknown): v is Severity {
  return typeof v === 'string' && (SEVERITIES as readonly string[]).includes(v);
}

/** "◆ Critical" as plain text (for titles, exports and aria-labels). */
export function severityText(level: Severity): string {
  return `${SEVERITY_GLYPH[level]} ${SEVERITY_LABEL[level]}`;
}

export type Reach = 'production' | 'dev' | 'unknown';

export const REACH_LABEL: Readonly<Record<Reach, string>> = { production: 'Production', dev: 'Dev and test', unknown: 'Unknown' };
/** Short forms for counts: "1 prod", "3 dev". */
export const REACH_SHORT: Readonly<Record<Reach, string>> = { production: 'prod', dev: 'dev', unknown: 'unknown' };

/** Map the API's `production: boolean | null` to a reach. */
export function reachOf(production: boolean | null | undefined): Reach {
  return production === true ? 'production' : production === false ? 'dev' : 'unknown';
}
