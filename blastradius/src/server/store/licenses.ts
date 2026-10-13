/**
 * Licences for the web app (docs/WHO-BEHIND-PLAN.md L1, L2, L4): the org's licence policy, and
 * the licence rows of each project's latest succeeded scan with that policy applied. Policies are
 * applied at read time, so editing the policy changes every view at once without a rescan.
 */
import { LICENSE_POLICY_DECISIONS, type LicensePolicy, type LicensePolicyDecision, type ScanResult } from '../../core/types.js';
import { DEFAULT_LICENSE_POLICY, evaluatePolicy, parseLicensePolicy } from '../../licenses/policy.js';
import { emptyCategoryCounts } from '../../licenses/report.js';
import { CLASSIFICATION_SOURCES, NOT_LEGAL_ADVICE } from '../../licenses/classify.js';
import type { LicenseChangeRow, LicensePolicyResponse, LicenseRow, LicensesResponse, ProjectRef } from '../api-types.js';
import { writeAudit } from './audit.js';
import { get, nowIso, parseJson, run, tx, type Store } from './db.js';
import { latestSucceededScan } from './findings.js';
import { listProjects } from './projects.js';

const MAX_ROWS = 5000;

interface PolicyRow {
  policy_json: string;
  updated_at: string;
  updated_by: string;
}

/** The org's policy (the default template when none is stored or the stored one no longer validates). */
export function getLicensePolicy(s: Store, orgId: string): LicensePolicyResponse {
  const r = get<PolicyRow>(s, 'SELECT policy_json, updated_at, updated_by FROM license_policy WHERE org_id = ?', orgId);
  let policy: LicensePolicy | null = null;
  if (r) {
    try {
      policy = parseLicensePolicy(parseJson<unknown>(r.policy_json, null));
    } catch {
      policy = null;
    }
  }
  return {
    policy: policy ?? DEFAULT_LICENSE_POLICY,
    isDefault: policy === null,
    updatedAt: policy ? r!.updated_at : null,
    updatedBy: policy ? r!.updated_by : null,
    defaultPolicy: DEFAULT_LICENSE_POLICY,
  };
}

/** Store a validated policy (null resets to the default), audited. */
export function setLicensePolicy(s: Store, orgId: string, policy: LicensePolicy | null, actor: { id: string; name: string }): LicensePolicyResponse {
  return tx(s, () => {
    if (policy === null) {
      run(s, 'DELETE FROM license_policy WHERE org_id = ?', orgId);
      writeAudit(s, { orgId, actor: actor.id, action: 'license_policy.reset', target: orgId });
    } else {
      const valid = parseLicensePolicy(policy);
      run(
        s,
        `INSERT INTO license_policy (org_id, policy_json, updated_at, updated_by) VALUES (?, ?, ?, ?)
         ON CONFLICT (org_id) DO UPDATE SET policy_json = excluded.policy_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        orgId,
        JSON.stringify(valid),
        nowIso(s),
        actor.name,
      );
      writeAudit(s, { orgId, actor: actor.id, action: 'license_policy.update', target: orgId, detail: { categories: valid.categories, ids: valid.ids.length } });
    }
    return getLicensePolicy(s, orgId);
  });
}

function emptyDecisions(): Record<LicensePolicyDecision, number> {
  return Object.fromEntries(LICENSE_POLICY_DECISIONS.map((d) => [d, 0])) as Record<LicensePolicyDecision, number>;
}

/**
 * Licence rows from the latest succeeded scan of each project (one project, or every project in
 * `projectIds`; null = all). The same component version in several projects is one row.
 */
export function licensesView(s: Store, orgId: string, opts: { projectId?: string; projectIds?: readonly string[] | null }): LicensesResponse {
  const { policy, isDefault } = getLicensePolicy(s, orgId);
  const projects = opts.projectId !== undefined ? listProjects(s, orgId, [opts.projectId]) : listProjects(s, orgId, opts.projectIds ?? null);
  const scans: LicensesResponse['scans'] = [];
  const rows = new Map<string, LicenseRow>();
  const changes = new Map<string, LicenseChangeRow>();
  let without = 0;
  let truncated = false;
  for (const p of projects) {
    const scan = latestSucceededScan(s, p.id);
    if (!scan) continue;
    const r = get<{ result_json: string | null }>(s, `SELECT result_json FROM scan WHERE id = ? AND org_id = ?`, scan.id, orgId);
    const result = parseJson<ScanResult | null>(r?.result_json, null);
    const ref: ProjectRef = { id: p.id, name: p.name };
    scans.push({ scanId: scan.id, project: ref, createdAt: scan.createdAt });
    const report = result?.licenses;
    if (!report) {
      without++;
      continue;
    }
    for (const c of report.components) {
      const existing = rows.get(c.purl);
      if (existing) {
        if (!existing.projects.some((x) => x.id === ref.id)) existing.projects.push(ref);
        continue;
      }
      if (rows.size >= MAX_ROWS) {
        truncated = true;
        continue;
      }
      const d = evaluatePolicy(c.expressions, c.status, policy);
      rows.set(c.purl, { ...c, decision: d.decision, rule: d.rule, projects: [ref] });
    }
    for (const ch of report.changes) {
      const key = `${ch.purl}\u0000${ch.version}`;
      const existing = changes.get(key);
      if (existing) {
        if (!existing.projects.some((x) => x.id === ref.id)) existing.projects.push(ref);
        existing.inUse = [...new Set([...existing.inUse, ...ch.inUse])].sort();
        if (existing.relation !== ch.relation) existing.relation = 'mixed';
        continue;
      }
      changes.set(key, { ...ch, projects: [ref] });
    }
  }
  const list = [...rows.values()];
  const byCategory = emptyCategoryCounts();
  const byDecision = emptyDecisions();
  for (const r of list) {
    byCategory[r.category]++;
    byDecision[r.decision]++;
  }
  const changeList = [...changes.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : (b.date ?? '').localeCompare(a.date ?? '')));
  return {
    scope: opts.projectId !== undefined ? 'project' : 'org',
    scans,
    scansWithoutLicences: without,
    policy,
    policyIsDefault: isDefault,
    counts: { components: list.length, byCategory, byDecision, changes: changeList.length, disagreements: list.filter((r) => r.disagreement).length },
    rows: list,
    changes: changeList,
    truncated,
    classification: CLASSIFICATION_SOURCES.map((c) => ({ ...c })),
    note: NOT_LEGAL_ADVICE,
  };
}
