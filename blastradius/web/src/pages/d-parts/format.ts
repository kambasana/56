/**
 * Small pure helpers shared by the Track D screens (Org home, Findings, Finding, Changes, Scans).
 * Everything here returns plain strings; callers render them as React text (escaped).
 */
import type { ChangeType, FindingRow, FindingStatus, ListFindingsResponse, RiskLevel, ScanRef, ScanStatus } from '@server/api-types';
import { api } from '@/api';

export const LEVEL_RANK: Record<RiskLevel, number> = { critical: 4, high: 3, medium: 2, low: 1 };
export const LEVELS: readonly RiskLevel[] = ['critical', 'high', 'medium', 'low'];

export function isRiskLevel(v: string): v is RiskLevel {
  return (LEVELS as readonly string[]).includes(v);
}

const FACTOR_LABELS: Record<string, string> = {
  malware: 'Malware',
  vuln: 'Known vulnerability',
  maintainer_change: 'Maintainer change',
  install_script: 'Install script',
  weak_posture: 'Weak repo posture',
  no_provenance: 'No provenance',
  provenance_dropped: 'Provenance dropped',
  dependency_added: 'New dependency in patch',
  single_maintainer: 'Single maintainer',
  abandoned: 'Abandoned',
  entity_incident: 'Linked incident',
  typosquat: 'Possible typosquat',
  deprecated: 'Deprecated',
};

/** Human label for an engine reason factor id ("maintainer_change" -> "Maintainer change"). */
export function factorLabel(factor: string): string {
  const known = FACTOR_LABELS[factor];
  if (known) return known;
  const s = factor.replace(/[_-]+/g, ' ').trim();
  return s ? s[0]!.toUpperCase() + s.slice(1) : factor;
}

export const STATUS_LABELS: Record<FindingStatus, string> = { new: 'New', reviewed: 'Reviewed', accepted_risk: 'Accepted risk' };

export const SCAN_STATUS_LABELS: Record<ScanStatus, string> = { queued: 'Queued', running: 'Running', succeeded: 'Succeeded', failed: 'Failed' };

export const CHANGE_LABELS: Record<ChangeType, string> = {
  new_finding: 'New finding',
  risk_up: 'Risk up',
  new_reason: 'New reason',
  risk_down: 'Risk down',
  resolved: 'Resolved',
};

/**
 * Readable form of a purl: "pkg:npm/%40scope/name@1.0.0?x=y" -> "@scope/name@1.0.0".
 * Non-purl strings (asset ids, entity ids) are returned unchanged.
 */
export function purlLabel(purl: string): string {
  if (!purl.startsWith('pkg:')) return purl;
  let rest = purl.slice(4);
  const cut = rest.search(/[?#]/);
  if (cut >= 0) rest = rest.slice(0, cut);
  const slash = rest.indexOf('/');
  if (slash >= 0) rest = rest.slice(slash + 1);
  try {
    return decodeURIComponent(rest);
  } catch {
    return rest;
  }
}

export { safeHref } from '@/lib/safe-href';

/** "2026-10-06" from an ISO time, or an em dash. */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toISOString().slice(0, 10);
}

/** "3m 12s" between two ISO times, or an em dash. */
export function fmtDuration(from: string | null | undefined, to: string | null | undefined): string {
  if (!from || !to) return '—';
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Parse a comma list of levels from the URL, dropping anything unknown. */
export function parseLevels(v: string | null): RiskLevel[] {
  if (!v) return [];
  return [...new Set(v.split(',').map((s) => s.trim()).filter(isRiskLevel))];
}

export function emptyCounts(): Record<RiskLevel, number> {
  return { critical: 0, high: 0, medium: 0, low: 0 };
}

export function countByLevel(rows: readonly { level: RiskLevel }[]): Record<RiskLevel, number> {
  const c = emptyCounts();
  for (const r of rows) c[r.level] = (c[r.level] ?? 0) + 1;
  return c;
}

/** Hard ceiling on rows pulled into the browser for one scan (100 pages of 500). */
export const MAX_FINDING_ROWS = 50_000;

/**
 * Every finding of the project's latest succeeded scan, following the cursor 500 at a time.
 * Filtering by level, status and text is then instant on the client, even at 5,000+ rows.
 */
export async function loadAllFindings(
  projectId: string,
  signal: AbortSignal,
  fetchPage: typeof api.findings = api.findings,
): Promise<{ items: FindingRow[]; total: number; scan: ScanRef | null; capped: boolean }> {
  const items: FindingRow[] = [];
  let cursor: string | undefined;
  let first: ListFindingsResponse | null = null;
  for (;;) {
    // Pin later pages to the first page's scan: a scan finishing mid-load must not shift rows.
    const scanId = first?.scan?.id;
    const page = await fetchPage({ project: projectId, limit: 500, sort: '-score', ...(scanId ? { scan: scanId } : {}), ...(cursor ? { cursor } : {}) }, signal);
    first ??= page;
    items.push(...page.items);
    if (!page.nextCursor || page.items.length === 0) break;
    if (items.length >= MAX_FINDING_ROWS) return { items, total: page.total, scan: first.scan, capped: true };
    cursor = page.nextCursor;
  }
  return { items, total: first?.total ?? items.length, scan: first?.scan ?? null, capped: false };
}
