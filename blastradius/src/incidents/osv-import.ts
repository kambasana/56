/**
 * Incident helpers that bridge facts and the KB:
 *  - `incidentsFromMalwareFacts`: OSV `MAL-*` advisories (from `malware` facts) → in-memory
 *    `malware_publish` incidents (PLAN §3.4 "every OSV MAL-* entry imported automatically").
 *  - `incidentAffects` / `incidentsForPurl`: match incidents to component versions.
 *  - `malwareFactsFromIncidents`: KB incidents → `malware` facts (source 'kb', origin 'incident')
 *    for components whose exact version is listed as affected.
 *
 * Imported incidents keep the OSV id (e.g. "MAL-2024-1234") as their `id`; they are never written
 * to the YAML KB and are not subject to the INC-YYYY-NNNN id rule.
 */
import {
  isFactOf,
  makeFact,
  parsePurl,
  unversionedPurl,
  type Component,
  type Fact,
  type Incident,
  type IncidentStatus,
  type IncidentType,
  type PurlString,
  type TypedFact,
} from '../core/types.js';

const MAL_ID_RE = /^MAL-\d{4}-\d+$/;

function osvUrl(id: string): string {
  return `https://osv.dev/vulnerability/${encodeURIComponent(id)}`;
}

function safeUnversioned(purl: string): { base: string; version?: string } | undefined {
  try {
    const p = parsePurl(purl);
    const out: { base: string; version?: string } = { base: unversionedPurl(purl) };
    if (p.version) out.version = p.version;
    return out;
  } catch {
    return undefined;
  }
}

/**
 * Turn `malware` facts whose id is an OSV `MAL-*` advisory into `malware_publish` incidents.
 * Facts with the same advisory id are merged; affected versions come from the fact subjects.
 */
export function incidentsFromMalwareFacts(facts: readonly Fact[]): Incident[] {
  const byId = new Map<string, { facts: TypedFact<'malware'>[] }>();
  for (const f of facts.filter(isFactOf('malware'))) {
    const id = f.value.id;
    if (typeof id !== 'string' || !MAL_ID_RE.test(id)) continue;
    let entry = byId.get(id);
    if (!entry) byId.set(id, (entry = { facts: [] }));
    entry.facts.push(f);
  }

  const out: Incident[] = [];
  for (const [id, { facts: group }] of byId) {
    const affected = new Map<string, Set<string>>();
    const evidence = new Set<string>();
    let date: string | undefined;
    for (const f of group) {
      const parsed = safeUnversioned(f.subject);
      if (!parsed) continue;
      let versions = affected.get(parsed.base);
      if (!versions) affected.set(parsed.base, (versions = new Set()));
      versions.add(parsed.version ?? '*');
      if (f.value.url && /^https:\/\//.test(f.value.url)) evidence.add(f.value.url);
      for (const u of f.evidence ?? []) if (/^https:\/\//.test(u)) evidence.add(u);
      const d = f.fetchedAt.slice(0, 10);
      if (!date || d < date) date = d;
    }
    if (affected.size === 0) continue;
    evidence.add(osvUrl(id));
    const names = [...affected.keys()].map(displayName);
    out.push({
      id,
      title: `${names.join(', ')} listed in OSV advisory ${id}`,
      type: 'malware_publish',
      status: 'confirmed',
      date: date ?? '1970-01-01',
      severity: 'critical',
      affected: [...affected].map(([purl, versions]) => ({
        purl,
        versions: versions.has('*') ? ['*'] : [...versions].sort(),
      })),
      entities: [],
      evidence: [...evidence],
    });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function displayName(purl: string): string {
  try {
    const p = parsePurl(purl);
    return p.namespace ? `${p.namespace}/${p.name}` : p.name;
  } catch {
    return purl;
  }
}

/**
 * Does `incident` list the component `purl` as affected?
 * With a versioned purl the version must be listed (or the entry is "*");
 * with an unversioned purl any entry for the package matches.
 */
export function incidentAffects(incident: Incident, purl: PurlString, opts: { wildcard?: boolean } = {}): boolean {
  const parsed = safeUnversioned(purl);
  if (!parsed) return false;
  const wildcard = opts.wildcard ?? true;
  return incident.affected.some((a) => {
    if (a.purl !== parsed.base) return false;
    if (parsed.version === undefined) return true;
    if (a.versions.includes('*')) return wildcard;
    return a.versions.includes(parsed.version);
  });
}

/** Incidents affecting `purl` (see `incidentAffects`). */
export function incidentsForPurl(
  incidents: readonly Incident[],
  purl: PurlString,
  opts: { wildcard?: boolean } = {},
): Incident[] {
  return incidents.filter((i) => incidentAffects(i, purl, opts));
}

/** Incident types where the affected versions shipped code the maintainers did not intend users to run. */
export const CODE_INCIDENT_TYPES: readonly IncidentType[] = [
  'malware_publish',
  'account_takeover',
  'maintainer_sabotage',
  'maintainer_infiltration',
  'malicious_handover',
  'ci_compromise',
  'typosquat',
  'domain_or_name_takeover',
];

export interface MalwareFactsOptions {
  fetchedAt: string | Date;
  /** Statuses that produce facts. Default: confirmed only. */
  statuses?: IncidentStatus[];
  /** Also match `versions: ['*']` entries. Default false (exact versions only, avoids flagging fixed releases). */
  wildcard?: boolean;
}

/**
 * KB incidents → `malware` facts (source 'kb', origin 'incident') for each component whose exact
 * version is listed as affected. Imported OSV incidents (MAL-*) are skipped: the OSV enricher
 * already emitted facts for those.
 */
export function malwareFactsFromIncidents(
  incidents: readonly Incident[],
  components: readonly Pick<Component, 'purl'>[],
  opts: MalwareFactsOptions,
): TypedFact<'malware'>[] {
  const statuses = new Set<IncidentStatus>(opts.statuses ?? ['confirmed']);
  const relevant = incidents.filter(
    (i) => statuses.has(i.status) && CODE_INCIDENT_TYPES.includes(i.type) && !MAL_ID_RE.test(i.id),
  );
  const out: TypedFact<'malware'>[] = [];
  for (const c of components) {
    for (const inc of relevant) {
      if (!incidentAffects(inc, c.purl, { wildcard: opts.wildcard ?? false })) continue;
      const value: TypedFact<'malware'>['value'] = {
        id: inc.id,
        summary: `Version listed as affected in ${inc.id} (${inc.status}): ${inc.title}`,
        origin: 'incident',
      };
      if (inc.evidence[0]) value.url = inc.evidence[0];
      out.push(makeFact('malware', c.purl, value, { source: 'kb', fetchedAt: opts.fetchedAt, evidence: inc.evidence }));
    }
  }
  return out;
}
