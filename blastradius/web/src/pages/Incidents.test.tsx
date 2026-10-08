/**
 * Stage 2B screens against a fake API: Incidents list and detail, package reach, who's behind
 * it, Exposure and Alerts.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ExposureMatrixResponse } from '@server/api-types';
import type { IncidentDetail as Detail, IncidentRow, ListAlertRulesResponse, PackageBehindResponse, PackageReachResponse } from '@server/api-types-incidents';
import { meFor } from '@/test/fixtures';
import { fakeApi, renderPage } from './e-parts/testkit';
import Alerts, { ruleWhen } from './Alerts';
import BehindPage, { rootIdFor } from './Behind';
import Exposure from './Exposure';
import IncidentDetail, { fmtDuration } from './IncidentDetail';
import Incidents, { incidentFacet, incidentTitle } from './Incidents';
import PackagePage, { lifecyclePhases, shortestFix } from './Package';

const row = (over: Partial<IncidentRow> = {}): IncidentRow => ({
  id: 'GHSA-1',
  advisoryId: 'GHSA-1',
  advisoryPublished: '2018-11-26T00:00:00Z',
  summary: 'Malicious release',
  level: 'critical',
  status: 'investigating',
  packages: [{ purl: 'pkg:npm/event-stream@3.3.6', name: 'event-stream', version: '3.3.6' }],
  openedAt: '2026-10-08T10:00:00Z',
  closedAt: null,
  affected: 2,
  production: 1,
  fixed: 0,
  projects: ['payments', 'web'],
  ...over,
});

const detail = (over: Partial<Detail> = {}): Detail => ({
  ...row(),
  hits: [
    { alertId: 'a1', projectId: 'p1', projectName: 'payments', owner: 'Payments team', purl: 'pkg:npm/flatmap-stream@0.1.1', name: 'flatmap-stream', version: '0.1.1', production: true, reachText: '', broughtInBy: ['event-stream@3.3.6'], direct: false, findingId: 'f1', fixed: false, alertedAt: '2026-10-08T10:00:00Z' },
    { alertId: 'a2', projectId: 'p2', projectName: 'web', owner: null, purl: 'pkg:npm/event-stream@3.3.6', name: 'event-stream', version: '3.3.6', production: false, reachText: '', broughtInBy: [], direct: true, findingId: null, fixed: true, alertedAt: '2026-10-08T10:00:00Z' },
  ],
  timeline: [
    { at: '2026-10-08T10:00:00Z', kind: 'alert', title: 'Advisory matched 2 projects', detail: 'event-stream@3.3.6 in payments (production), web' },
    { at: '2026-10-08T10:00:01Z', kind: 'check', title: '2 projects checked', detail: 'From stored inventories' },
  ],
  checked: { projects: 2, at: '2026-10-08T10:00:01Z', source: 'advisories' },
  owners: ['Payments team'],
  actions: { recheck: { available: false, reason: 'No knowledge pack is configured (BLASTRADIUS_PACK).' }, notify: { available: false, reason: 'No Slack webhook is configured (BLASTRADIUS_ALERT_WEBHOOK).' } },
  ...over,
});

describe('Incidents list', () => {
  it('titles and facets rows', () => {
    expect(incidentTitle(row())).toBe('event-stream@3.3.6');
    expect(incidentTitle(row({ packages: [...row().packages, { purl: 'x', name: 'flatmap-stream', version: '0.1.1' }] }))).toBe('event-stream@3.3.6 and 1 more');
    expect(incidentFacet(row(), 'reach')).toBe('production');
    expect(incidentFacet(row({ fixed: 2 }), 'fix')).toBe('fixed');
    expect(incidentFacet(row({ level: null }), 'severity')).toBe('unknown');
  });

  it('links each incident and filters with chips in the URL', async () => {
    fakeApi({ 'GET /api/incidents': () => ({ items: [row(), row({ id: 'GHSA-2', advisoryId: 'GHSA-2', level: 'medium', production: 0, status: 'closed' })] }) });
    renderPage(<Incidents />, { path: '/incidents', at: '/incidents', me: meFor('appsec') });
    const table = await screen.findByRole('table', { name: 'Incidents' });
    expect(within(table).getAllByRole('link')[0]).toHaveAttribute('href', '/incidents/GHSA-1');
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    await userEvent.click(screen.getByRole('button', { name: /In production/ }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('reach=production'));
    expect(within(screen.getByRole('table', { name: 'Incidents' })).getAllByRole('row')).toHaveLength(2);
  });
});

describe('Incident page', () => {
  it('shows where it is production first, owners, honest disabled actions and the timeline', async () => {
    fakeApi({ 'GET /api/incidents/GHSA-1': () => detail() });
    renderPage(<IncidentDetail />, { path: '/incidents/:incidentId', at: '/incidents/GHSA-1', me: meFor('appsec') });
    const where = await screen.findByRole('table', { name: 'Where it is' });
    const rows = within(where).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('payments');
    expect(rows[1]).toHaveTextContent('event-stream@3.3.6');
    expect(rows[1]).toHaveTextContent('Payments team');
    expect(within(rows[1]!).getByRole('link', { name: 'Open finding in payments' })).toHaveAttribute('href', '/projects/p1/findings/f1');
    expect(rows[2]).toHaveTextContent('Gone from the latest scan');
    expect(screen.getByRole('button', { name: 'Re-check all projects' })).toBeDisabled();
    expect(screen.getByText(/Re-check: No knowledge pack/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Notify 1 owner/ })).toBeDisabled();
    expect(screen.getByRole('list', { name: 'Incident status' })).toHaveTextContent('Investigating');
    expect(screen.getByRole('list', { name: 'Timeline' })).toHaveTextContent('2 projects checked');
  });

  it('moves the status through the server', async () => {
    const api = fakeApi({ 'GET /api/incidents/GHSA-1': () => detail(), 'PATCH /api/incidents/GHSA-1': (c) => detail({ status: (c.body as { status: Detail['status'] }).status }) });
    renderPage(<IncidentDetail />, { path: '/incidents/:incidentId', at: '/incidents/GHSA-1', me: meFor('appsec') });
    await userEvent.click(await screen.findByRole('button', { name: /Set status/ }));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'Fixing' }));
    await waitFor(() => expect(screen.getByRole('list', { name: 'Incident status' }).querySelector('[aria-current="step"]')).toHaveTextContent('Fixing'));
    expect(api.calls.find((c) => c.method === 'PATCH')!.body).toEqual({ status: 'fixing' });
  });

  it('tells an auditor why status cannot change', async () => {
    fakeApi({ 'GET /api/incidents/GHSA-1': () => detail() });
    renderPage(<IncidentDetail />, { path: '/incidents/:incidentId', at: '/incidents/GHSA-1', me: meFor('auditor') });
    expect(await screen.findByRole('button', { name: /Set status/ })).toBeDisabled();
    expect(screen.getByText(/Needs the Triage permission/)).toBeInTheDocument();
  });

  it('formats how long it has been open', () => {
    expect(fmtDuration(130 * 60_000)).toBe('2 h 10 min');
    expect(fmtDuration(3 * 86_400_000 + 4 * 3_600_000)).toBe('3 d 4 h');
    expect(fmtDuration(5_000)).toBe('under a minute');
  });
});

const reach: PackageReachResponse = {
  query: { name: 'flatmap-stream', version: '0.1.1' },
  projectsSearched: 3,
  level: 'critical',
  advisories: [{ id: 'GHSA-1', published: '2018-11-26T00:00:00Z', status: 'investigating', fixedIn: '0.1.2' }],
  lifecycle: { firstWarning: '2026-10-01T00:00:00Z', advisory: { id: 'GHSA-1', at: '2018-11-26T00:00:00Z' }, fixed: { fixed: 0, of: 2 } },
  projects: [
    { projectId: 'p1', projectName: 'payments', production: true, assets: 1, paths: 1, via: ['event-stream@3.3.6'], reachText: 'r', versions: ['0.1.1'], findingId: 'f1', level: 'critical' },
    { projectId: 'p2', projectName: 'web', production: false, assets: 1, paths: 1, via: ['event-stream@3.3.6'], reachText: 'r', versions: ['0.1.1'], findingId: null, level: null },
  ],
  flows: [
    { projectId: 'p1', projectName: 'payments', via: 'event-stream@3.3.6', production: true, assets: 1, paths: 1 },
    { projectId: 'p2', projectName: 'web', via: 'event-stream@3.3.6', production: false, assets: 1, paths: 1 },
  ],
  paths: [
    { projectId: 'p1', projectName: 'payments', assetId: 'repo:pay', assetName: 'pay', environment: 'prod', production: true, nodes: [{ id: 'repo:pay', label: 'pay', kind: 'asset' }, { id: 'pkg:npm/event-stream@3.3.6', label: 'event-stream@3.3.6', kind: 'package' }, { id: 'pkg:npm/flatmap-stream@0.1.1', label: 'flatmap-stream@0.1.1', kind: 'package' }], scopes: ['runtime', 'runtime'] },
    { projectId: 'p2', projectName: 'web', assetId: 'repo:web', assetName: 'web', environment: 'dev', production: false, nodes: [{ id: 'repo:web', label: 'web', kind: 'asset' }, { id: 'pkg:npm/event-stream@3.3.6', label: 'event-stream@3.3.6', kind: 'package' }, { id: 'pkg:npm/flatmap-stream@0.1.1', label: 'flatmap-stream@0.1.1', kind: 'package' }], scopes: ['dev', 'runtime'] },
  ],
  totalPaths: 2,
};

describe('Package reach', () => {
  it('shows only the lifecycle phases the data knows, and a fix only when an advisory names one', () => {
    expect(lifecyclePhases(reach).map((p) => p.label)).toEqual(['First warning', 'Advisory', 'Fixed here']);
    expect(lifecyclePhases({ ...reach, lifecycle: { firstWarning: null, advisory: null, fixed: null } })).toEqual([]);
    expect(shortestFix(reach.paths[0]!, reach)).toMatch(/^Upgrade or replace event-stream@3\.3\.6 so payments no longer resolves flatmap-stream@0\.1\.1/);
    expect(shortestFix(reach.paths[0]!, { ...reach, advisories: [] })).toBeNull();
  });

  it('draws the Sankey with a Table toggle, production lane first, and the selected path in the rail', async () => {
    fakeApi({ 'GET /api/packages/reach': () => reach });
    renderPage(<PackagePage />, { path: '/packages', at: '/packages?name=flatmap-stream&version=0.1.1', me: meFor('appsec') });
    expect(await screen.findByRole('heading', { name: 'flatmap-stream@0.1.1', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /reaches 2 projects/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open incident' })).toHaveAttribute('href', '/incidents/GHSA-1');
    const lanes = screen.getAllByRole('heading', { level: 3 });
    expect(lanes[0]).toHaveTextContent('Production · 1 path');
    expect(screen.getByRole('list', { name: 'Selected path' })).toHaveTextContent('payments');
    expect(screen.getByText(/Shortest fix/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^web \(dev and test\): web → event-stream/ }));
    expect(screen.getByRole('list', { name: 'Selected path' })).toHaveTextContent('depends on (dev)');
    await userEvent.click(screen.getByRole('button', { name: /payments: 1 asset, production/ }));
    expect(screen.getByTestId('where')).toHaveTextContent('project=p1');
    await userEvent.click(screen.getByRole('button', { name: 'Table' }));
    const table = await screen.findByRole('table', { name: 'Projects' });
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent('payments');
    expect(within(table).getByRole('link', { name: 'Open finding' })).toHaveAttribute('href', '/projects/p1/findings/f1');
  });

  it('says plainly when nobody uses it', async () => {
    fakeApi({ 'GET /api/packages/reach': () => ({ ...reach, projects: [], flows: [], paths: [], totalPaths: 0, level: null, advisories: [] }) });
    renderPage(<PackagePage />, { path: '/packages', at: '/packages?name=left-pad&version=1.3.0', me: meFor('appsec') });
    expect(await screen.findByText('Not found in any of 3 projects')).toBeInTheDocument();
  });
});

const behind: PackageBehindResponse = {
  name: 'event-stream',
  usedIn: 1,
  links: [
    { from: 'pkg:npm/event-stream', entityId: 'account:npm/right9ctrl', relation: 'maintains', confidence: 1, evidence: ['https://www.npmjs.com/package/event-stream'], method: 'deterministic', reviewed: true },
    { from: 'pkg:npm/event-stream', entityId: 'account:github/dominictarr', relation: 'owns', confidence: 0.9, evidence: ['https://github.com/dominictarr/event-stream'], method: 'deterministic', reviewed: true },
    { from: 'account:github/dominictarr', entityId: 'funder:opencollective/x', relation: 'funds', confidence: 0.4, evidence: ['javascript:alert(1)'], method: 'probabilistic', reviewed: false },
  ],
  incidents: ['INC-2018-0001'],
  alsoLinked: {},
};

describe("Who's behind it", () => {
  it('opens one hop deep, hides unreviewed links until asked, and lists sources safely', async () => {
    fakeApi({ 'GET /api/packages/behind': () => behind });
    renderPage(<BehindPage />, { path: '/packages/behind', at: '/packages/behind?name=event-stream', me: meFor('auditor') });
    expect(await screen.findByText('Focused on event-stream')).toBeInTheDocument();
    expect(screen.getByText('Public links with sources. Not a finding of wrongdoing.')).toBeInTheDocument();
    const graph = screen.getByRole('group', { name: /event-stream: 2 linked/ });
    await userEvent.click(within(graph).getByRole('button', { name: /npm · right9ctrl: maintains, High confidence, 1 source/ }));
    expect(screen.getByRole('link', { name: 'www.npmjs.com/package/event-stream' })).toHaveAttribute('href', 'https://www.npmjs.com/package/event-stream');
    await userEvent.click(screen.getByRole('button', { name: 'Show unreviewed links (1)' }));
    expect(screen.getByTestId('where')).toHaveTextContent('unreviewed=1');
    await userEvent.click(screen.getByRole('button', { name: 'Table' }));
    const table = await screen.findByRole('table', { name: 'Links' });
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    expect(table).toHaveTextContent('Low · probable · Unreviewed');
    expect(within(table).queryByRole('link', { name: /javascript/ })).toBeNull();
  });

  it('finds the package node id', () => {
    expect(rootIdFor('event-stream', behind.links)).toBe('pkg:npm/event-stream');
    expect(rootIdFor('@a/b', [])).toBe('pkg:npm/%40a/b');
  });
});

describe('Exposure', () => {
  const m: ExposureMatrixResponse = {
    axis: 'project',
    rows: [
      { key: 'p2', label: 'web', projectId: 'p2', environment: null, criticality: null, blastScore: 1, production: false },
      { key: 'p1', label: 'payments', projectId: 'p1', environment: null, criticality: null, blastScore: 2, production: true },
    ],
    columns: [
      { findingId: 'f1', projectId: 'p1', purl: 'pkg:npm/a@1.0.0', name: 'a', version: '1.0.0', level: 'critical', score: 90, reach: 2 },
      { findingId: 'f2', projectId: 'p2', purl: 'pkg:npm/b@2.0.0', name: 'b', version: '2.0.0', level: 'medium', score: 40, reach: 1 },
    ],
    cells: [
      { row: 0, col: 0, exposure: 1, pathCount: 1, findingId: 'w1', level: 'high', production: false },
      { row: 1, col: 0, exposure: 1, pathCount: 1, findingId: 'f1', level: 'critical', production: true },
      { row: 0, col: 1, exposure: 1, pathCount: 1, findingId: 'f2', level: 'medium', production: false },
    ],
    truncated: false,
  };

  it('draws glyph-and-letter cells, production rows first, with a table view', async () => {
    const api = fakeApi({ 'GET /api/exposure': () => m });
    renderPage(<Exposure />, { path: '/exposure', at: '/exposure', me: meFor('auditor') });
    const heat = await screen.findByRole('table', { name: /Exposure heatmap/ });
    const rows = within(heat).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('payments');
    expect(rows[1]).toHaveTextContent('◆ C');
    expect(rows[1]).toHaveTextContent('b not present in payments');
    expect(within(rows[1]!).getByRole('link', { name: /payments · a@1.0.0: Critical, production/ })).toHaveAttribute('href', '/projects/p1/findings/f1');
    expect(within(heat).getByRole('link', { name: 'a@1.0.0' })).toHaveAttribute('href', '/packages?name=a&version=1.0.0');
    expect(api.calls[0]!.url.searchParams.get('minLevel')).toBe('medium');
    await userEvent.click(screen.getByRole('button', { name: 'Table' }));
    expect(screen.getByTestId('where')).toHaveTextContent('view=table');
    const table = await screen.findByRole('table', { name: 'Exposure' });
    expect(within(table).getAllByRole('row')).toHaveLength(4);
  });

  it('narrows to production with the scope bar URL', async () => {
    fakeApi({ 'GET /api/exposure': () => m });
    renderPage(<Exposure />, { path: '/exposure', at: '/exposure?env=prod', me: meFor('auditor') });
    const heat = await screen.findByRole('table', { name: /Exposure heatmap/ });
    expect(within(heat).getAllByRole('row')).toHaveLength(2);
  });
});

describe('Alerts', () => {
  const list: ListAlertRulesResponse = {
    items: [{ id: 'r1', name: 'Critical in production', minLevel: 'critical', productionOnly: true, channel: '#security', emailOwners: false, enabled: true, createdAt: 't', updatedAt: 't', lastThirtyDays: 3 }],
    usingDefault: false,
    webhook: { configured: false },
    email: { configured: false },
  };

  it('lists rules with what they would have sent', async () => {
    fakeApi({ 'GET /api/alert-rules': () => list, 'GET /api/alerts': () => ({ items: [] }) });
    renderPage(<Alerts />, { path: '/alerts', at: '/alerts', me: meFor('appsec') });
    const table = await screen.findByRole('table', { name: 'Alert rules' });
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent('Critical in production');
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent('3 alerts');
    expect(screen.getByText(/No Slack webhook is configured/)).toBeInTheDocument();
    expect(ruleWhen({ minLevel: 'high', productionOnly: false })).toBe('▲ High or worse, any project');
  });

  it('creates a rule from the sheet with a live preview, validating on blur', async () => {
    const api = fakeApi({
      'GET /api/alert-rules': () => list,
      'GET /api/alerts': () => ({ items: [] }),
      'POST /api/alert-rules/preview': (c) => ({ days: 30, count: (c.body as { minLevel: string }).minLevel === 'low' ? 41 : 2, mostRecent: null }),
      'POST /api/alert-rules': (c) => ({ ...list.items[0], ...(c.body as object), id: 'r2' }),
    });
    renderPage(<Alerts />, { path: '/alerts', at: '/alerts', me: meFor('appsec') });
    await userEvent.click(await screen.findByRole('button', { name: 'New rule' }));
    expect(screen.getByTestId('where')).toHaveTextContent('rule=new');
    expect(await screen.findByText('Would have sent 2 alerts in the last 30 days')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: /Low/ }));
    expect(await screen.findByText('Would have sent 41 alerts in the last 30 days')).toBeInTheDocument();
    expect(screen.getByText(/more than one a day/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send a test message' })).toBeDisabled();
    const channel = screen.getByRole('textbox', { name: /Slack channel/ });
    await userEvent.type(channel, 'bad channel');
    await userEvent.tab();
    expect(screen.getByText(/A Slack channel name/)).toBeInTheDocument();
    await userEvent.clear(channel);
    await userEvent.type(channel, '#appsec-feed');
    await userEvent.type(screen.getByRole('textbox', { name: /Name/ }), 'Everything');
    await userEvent.click(screen.getByRole('button', { name: 'Save rule' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path === '/api/alert-rules')).toBe(true));
    expect(api.calls.find((c) => c.method === 'POST' && c.path === '/api/alert-rules')!.body).toEqual({ name: 'Everything', minLevel: 'low', productionOnly: true, channel: '#appsec-feed' });
  });

  it('keeps New rule visible but disabled, with the reason, for an auditor', async () => {
    fakeApi({ 'GET /api/alert-rules': () => ({ ...list, usingDefault: true, items: [] }), 'GET /api/alerts': () => ({ items: [] }) });
    renderPage(<Alerts />, { path: '/alerts', at: '/alerts', me: meFor('auditor') });
    expect(await screen.findByText('Every new alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New rule' })).toBeDisabled();
  });
});
