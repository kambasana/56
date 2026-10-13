/**
 * Stability labels as stored in scan results (ScanResult.stability, docs/WHO-BEHIND-PLAN.md §4, P3):
 * the Maintenance tab, the Changes page's S5a section and the Package page read them here. No
 * migration: labels live inside the stored scan result, like licences and history.
 */
import type { ProjectStabilityResponse, UpkeepEventsResponse } from '../api-types.js';
import { eventsCut, stabilityEvents } from '../../stability/events.js';
import type { StabilityEntry, StabilityReport } from '../../core/types.js';
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
  return {
    scanId,
    asOf: r?.asOf ?? null,
    entries: r?.packages ?? null,
    counts: r?.counts ?? null,
    decisions: r?.decisions ?? null,
    coverage: r?.coverage ?? null,
    historyStatus: r?.historyStatus ?? null,
    disclaimer: r?.disclaimer ?? STABILITY_DISCLAIMER,
    funding: 'not_assessed',
  };
}

/** Upkeep events between the `from` and `to` scans (Tier 0, src/stability/events.ts). */
export function upkeepEvents(s: Store, orgId: string, fromScanId: string | null, toScanId: string): UpkeepEventsResponse | undefined {
  const to = reportOf(s, orgId, toScanId);
  if (!to) return undefined;
  const r = stabilityEvents(reportOf(s, orgId, fromScanId), to);
  return { ...r, since: eventsCut(to.asOf) };
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
