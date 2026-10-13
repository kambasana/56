/**
 * One row model for the Findings table, whether a row is one finding (By project) or one
 * package version with its findings in several projects (By package).
 */
import type { FindingStatus, IntroducedBy, OrgFindingRow, PackageFindingGroup, PersonRef, RiskLevel } from '@server/api-types';

export interface RowFinding {
  id: string;
  projectId: string;
  projectName: string;
  production: boolean;
  status: FindingStatus;
  owner: PersonRef | null;
}

export interface ListRow {
  /** Finding id (By project) or purl (By package): the peek and selection key. */
  key: string;
  kind: 'finding' | 'package';
  level: RiskLevel;
  name: string;
  version: string;
  purl: string;
  /** Second line under the package: project and reason, or the reason. */
  sub: string;
  reason: string | null;
  /** Reach in words ("Brought in by … · used by api (production)"); finding rows only. */
  reachText?: string;
  projects: number;
  prodProjects: number;
  introducedBy: IntroducedBy;
  firstSeenAt: string;
  findings: RowFinding[];
  /** The first finding (production first): the "Open full page" target. */
  primary: RowFinding;
}

export function findingHref(f: Pick<RowFinding, 'id' | 'projectId'>): string {
  return `/projects/${encodeURIComponent(f.projectId)}/findings/${encodeURIComponent(f.id)}`;
}

export function rowsFromFindings(items: readonly OrgFindingRow[]): ListRow[] {
  return items.map((r) => {
    const f: RowFinding = { id: r.id, projectId: r.projectId, projectName: r.projectName, production: r.reach.prodAssets > 0, status: r.status, owner: r.owner };
    const reason = r.mainReason?.detail ?? null;
    return {
      key: r.id,
      kind: 'finding',
      level: r.level,
      name: r.name,
      version: r.version,
      purl: r.purl,
      sub: reason ? `${r.projectName} · ${reason}` : r.projectName,
      reason,
      reachText: r.reachText,
      projects: r.spread.projects,
      prodProjects: r.spread.prodProjects,
      introducedBy: r.introducedBy,
      firstSeenAt: r.firstSeenAt,
      findings: [f],
      primary: f,
    };
  });
}

export function rowsFromGroups(items: readonly PackageFindingGroup[]): ListRow[] {
  return items
    .filter((g) => g.findings.length > 0)
    .map((g) => ({
      key: g.purl,
      kind: 'package',
      level: g.level,
      name: g.name,
      version: g.version,
      purl: g.purl,
      sub: g.mainReason?.detail ?? '',
      reason: g.mainReason?.detail ?? null,
      projects: g.projects,
      prodProjects: g.prodProjects,
      introducedBy: g.introducedBy,
      firstSeenAt: g.firstSeenAt,
      findings: g.findings,
      primary: g.findings[0]!,
    }));
}

/** The one status of the row's findings, or null when they differ. */
export function commonStatus(r: Pick<ListRow, 'findings'>): FindingStatus | null {
  const s = new Set(r.findings.map((f) => f.status));
  return s.size === 1 ? r.findings[0]!.status : null;
}

/** The one owner id ('' = unassigned), or null when they differ. */
export function commonOwner(r: Pick<ListRow, 'findings'>): string | null {
  const s = new Set(r.findings.map((f) => f.owner?.id ?? ''));
  return s.size === 1 ? (r.findings[0]!.owner?.id ?? '') : null;
}
