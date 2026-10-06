/** /api/reports, /api/reports/:scanId.{html,json,sarif}, /api/integrations */
import type { Hono } from 'hono';
import { renderReport } from '../../report/index.js';
import type { ListIntegrationsResponse, ListReportsResponse, ReportFormat } from '../api-types.js';
import { deps, requireOrg, requireOrgPerm, requireProjectPerm, visibleProjects, type AppEnv } from '../context.js';
import { notFound } from '../errors.js';
import { pageQuery, queryString } from '../request.js';
import { getScanInventory, getScanResult, listReports } from '../store/index.js';

const REPORT_FILE_RE = /^([A-Za-z0-9_-]{1,100})\.(html|json|sarif)$/;

const CONTENT_TYPES: Record<ReportFormat, string> = {
  html: 'text/html; charset=utf-8',
  json: 'application/json; charset=utf-8',
  sarif: 'application/sarif+json; charset=utf-8',
};

export const REPORT_HTML_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

export function registerReportRoutes(app: Hono<AppEnv>): void {
  app.get('/api/reports', (c) => {
    const projectId = queryString(c, 'project', 100);
    if (projectId !== undefined) {
      const { orgId } = requireProjectPerm(c, projectId, 'reports');
      return c.json<ListReportsResponse>(listReports(deps(c).store, orgId, { projectId, ...pageQuery(c) }));
    }
    const { orgId, projectIds } = visibleProjects(c, 'reports');
    return c.json<ListReportsResponse>(listReports(deps(c).store, orgId, { projectIds, ...pageQuery(c) }));
  });

  app.get('/api/reports/:file', (c) => {
    const m = REPORT_FILE_RE.exec(c.req.param('file') ?? '');
    if (!m) throw notFound('Report not found');
    const scanId = m[1]!;
    const format = m[2] as ReportFormat;
    const { orgId } = requireOrg(c);
    const { store } = deps(c);
    const stored = getScanResult(store, orgId, scanId);
    if (!stored) throw notFound('Report not found');
    requireProjectPerm(c, stored.projectId, 'reports');
    const inventory = getScanInventory(store, orgId, scanId);
    const body = renderReport(stored.result, format, inventory ? { assets: inventory.assets } : {});
    c.header('Content-Type', CONTENT_TYPES[format]);
    c.header('Content-Disposition', `attachment; filename="blastradius-${scanId}.${format}"`);
    c.header('Cache-Control', 'private, no-store');
    if (format === 'html') c.header('Content-Security-Policy', REPORT_HTML_CSP);
    return c.body(body);
  });

  app.get('/api/integrations', (c) => {
    requireOrgPerm(c, 'integrations');
    const token = process.env.GITHUB_TOKEN;
    const items: ListIntegrationsResponse['items'] = [
      {
        id: 'github',
        kind: 'github',
        name: 'GitHub',
        status: token ? 'ok' : 'not_configured',
        detail: token
          ? 'GITHUB_TOKEN is set in the server environment; used for higher GitHub API rate limits. Read-only.'
          : 'Set GITHUB_TOKEN in the server environment for higher GitHub API rate limits. The GitHub App is not available yet.',
      },
      { id: 'webhook', kind: 'webhook', name: 'Webhooks', status: 'not_configured', detail: 'Outgoing webhooks are not available yet.' },
      { id: 'api', kind: 'api', name: 'API tokens', status: 'not_configured', detail: 'Use a signed-in session; API tokens are not available yet.' },
    ];
    return c.json<ListIntegrationsResponse>({ items });
  });
}
