/** Helpers for matching incident KB entries to inventory components. */
import { normalizePurl, unversionedPurl, type Component, type Incident } from '../core/types.js';

function safeUnversioned(purl: string): string | undefined {
  try {
    return unversionedPurl(normalizePurl(purl));
  } catch {
    return undefined;
  }
}

/**
 * How an incident names this component: 'exact' when its affected list contains the exact
 * version (or commit SHA), 'wildcard' when it only says "*" (all versions), else undefined.
 * Only exact matches may trigger the malware override: "*" also covers releases published
 * after the incident was fixed.
 */
export function incidentMatch(component: Pick<Component, 'purl' | 'version'>, inc: Incident): 'exact' | 'wildcard' | undefined {
  const base = safeUnversioned(component.purl);
  if (!base) return undefined;
  let wildcard = false;
  for (const a of inc.affected) {
    if (safeUnversioned(a.purl) !== base) continue;
    if (a.versions.includes(component.version)) return 'exact';
    if (a.versions.includes('*')) wildcard = true;
  }
  return wildcard ? 'wildcard' : undefined;
}

/** Incidents whose `affected` list names this component's package and exact version (or '*'). */
export function incidentsAffecting(component: Pick<Component, 'purl' | 'version'>, incidents: readonly Incident[]): Incident[] {
  return incidents.filter((inc) => incidentMatch(component, inc) !== undefined);
}

/** Incidents that name this component's exact version (no wildcard entries). */
export function incidentsAffectingExactly(component: Pick<Component, 'purl' | 'version'>, incidents: readonly Incident[]): Incident[] {
  return incidents.filter((inc) => incidentMatch(component, inc) === 'exact');
}
