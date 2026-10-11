/**
 * Stability labels as stored in scan results (ScanResult.stability, docs/WHO-BEHIND-PLAN.md §4, P3):
 * the Maintenance tab, the Changes page's S5a section and the Package page read them here. No
 * migration: labels live inside the stored scan result, like licences and history.
 */
import type { ContinuityRow, ProjectStabilityResponse } from '../api-types.js';
import type { StabilityEntry, StabilityReport } from '../../core/types.js';
import { addMonths } from '../../history/aggregate.js';
import { STABILITY_RULES } from '../../stability/rules.js';
import { STABILITY_DISCLAIMER } from '../../stability/report.js';
import type { Store } from './db.js';
import { getScanResult, latestSucceededScanId } from './scans.js';

function reportOf(s: Store, orgId: string, scanId: string | null): StabilityReport | null {
  if (!scanId) return null;
  return getScanResult(s, orgId, scanId)?.result.stability ?? null;
}

export function projectStability(s: Store, orgId: string, projectId: string): ProjectStabilityResponse {
  const scanId = latestSucceededScanId(s, orgId, projectId);
  const r = reportOf(s, orgId, scanId);
  return { scanId, asOf: r?.asOf ?? null, entries: r?.packages ?? null, counts: r?.counts ?? null, disclaimer: r?.disclaimer ?? STABILITY_DISCLAIMER, funding: 'not_assessed' };
}

const rowId = (e: { kind: string; package: string; date: string; release?: string }) => `${e.kind}:${e.package}:${e.date}:${e.release ?? ''}`;

/** S5a observations of the `to` scan dated within the last 12 months; new when `from` lacked them. */
export function continuityRows(s: Store, orgId: string, fromScanId: string | null, toScanId: string): ContinuityRow[] {
  const to = reportOf(s, orgId, toScanId);
  if (!to) return [];
  const from = reportOf(s, orgId, fromScanId);
  const before = new Set((from?.packages ?? []).flatMap((p) => p.s5a.map(rowId)));
  const cut = addMonths(new Date(to.asOf), -STABILITY_RULES.recentMonths).toISOString().slice(0, 10);
  const rows: ContinuityRow[] = [];
  for (const p of to.packages) {
    for (const e of p.s5a) {
      if (e.date <= cut) continue;
      rows.push({ ...e, id: rowId(e), production: p.production, isNew: from !== null && !before.has(rowId(e)) });
    }
  }
  return rows.sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name));
}

/** The label of package `name` from the newest of the given scans that has one. */
export function packageStability(
  s: Store,
  orgId: string,
  scans: readonly { projectId: string; projectName: string; scanId: string }[],
  name: string,
): { entry: StabilityEntry; projectId: string; projectName: string; scanId: string; asOf: string; disclaimer: string } | null {
  let best: { entry: StabilityEntry; projectId: string; projectName: string; scanId: string; asOf: string; disclaimer: string } | null = null;
  for (const sc of scans) {
    const r = reportOf(s, orgId, sc.scanId);
    const entry = r?.packages.find((p) => p.name === name);
    if (!r || !entry) continue;
    if (!best || r.asOf > best.asOf) best = { entry, projectId: sc.projectId, projectName: sc.projectName, scanId: sc.scanId, asOf: r.asOf, disclaimer: r.disclaimer };
  }
  return best;
}
