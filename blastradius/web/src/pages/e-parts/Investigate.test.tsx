import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { GraphResponse, InvestigateNodeResponse, ListFindingsResponse } from '@server/api-types';
import Investigate from '../Investigate';
import { meFor } from '@/test/fixtures';
import { summarise } from './graph';
import { fakeApi, renderPage } from './testkit';

// Cytoscape needs a real canvas; tests use a stand-in that exposes nodes as buttons.
vi.mock('@/components/ScopedGraph', () => ({
  ScopedGraph: ({ graph, onNodeClick, label }: { graph: GraphResponse; onNodeClick?: (id: string) => void; label?: string }) => (
    <div role="img" aria-label={label}>
      {graph.nodes.map((n) => (
        <button key={n.id} type="button" onClick={() => onNodeClick?.(n.id)}>
          node:{n.label}
        </button>
      ))}
    </div>
  ),
}));

const PURL = 'pkg:npm/flatmap-stream@0.1.1';

const graph: GraphResponse = {
  centre: PURL,
  nodes: [
    { id: PURL, kind: 'component', label: 'flatmap-stream@0.1.1', level: 'critical' },
    { id: 'pkg:npm/event-stream@3.3.6', kind: 'component', label: 'event-stream@3.3.6', level: 'critical' },
    { id: 'asset:web', kind: 'asset', label: 'web-app' },
    { id: 'person:right9ctrl', kind: 'entity', label: 'person:right9ctrl', entityType: 'person' },
    { id: 'group:component', kind: 'group', label: '+12 more components', size: 12 },
  ],
  edges: [
    { from: 'asset:web', to: 'pkg:npm/event-stream@3.3.6', relation: 'runtime' },
    { from: 'pkg:npm/event-stream@3.3.6', to: PURL, relation: 'runtime' },
    { from: PURL, to: 'person:right9ctrl', relation: 'maintains', confidence: 0.6, reviewed: false, evidence: ['https://example.org/advisory', 'javascript:alert(1)'] },
  ],
  cap: 5,
  truncated: true,
};

const nodeInfo: InvestigateNodeResponse = {
  id: PURL,
  kind: 'component',
  label: 'flatmap-stream',
  appearances: [{ projectId: 'p1', projectName: 'payments-platform', findingId: 'f1', purl: PURL, via: 'component', assets: 2, level: 'critical', score: 100 }],
  links: [{ from: 'pkg:npm/flatmap-stream', entityId: 'person:right9ctrl', relation: 'maintains', confidence: 0.6, reviewed: false, evidence: ['https://example.org/a'] }],
};

const findings = {
  items: [{ id: 'f1', name: 'flatmap-stream', version: '0.1.1', level: 'critical', score: 100, reach: { assets: 2, prodAssets: 1, paths: 3 } }],
  total: 1,
  nextCursor: null,
  scan: null,
} as unknown as ListFindingsResponse;

const path = '/projects/:id/investigate';

function api() {
  return fakeApi({
    'GET /api/findings': () => findings,
    'GET /api/graph': () => graph,
    'GET /api/investigate/node': () => nodeInfo,
    'GET /api/investigate/search': (c) =>
      c.url.searchParams.get('q') === 'right'
        ? { items: [{ kind: 'entity', id: 'person:right9ctrl', label: 'person:right9ctrl', meta: 'entity · 1 finding' }] }
        : { items: [] },
  });
}

describe('graph summary', () => {
  it('counts what the cap dropped', () => {
    expect(summarise(graph)).toMatchObject({ shown: 4, dropped: 12, total: 16, byKind: { component: 2, asset: 1, entity: 1 } });
  });
});

describe('<Investigate>', () => {
  it('draws nothing until something is picked, then scopes the graph to one finding', async () => {
    const { calls } = api();
    renderPage(<Investigate />, { path, at: '/projects/p1/investigate', me: meFor('org_admin') });
    expect(await screen.findByText('Pick something to investigate')).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/api/graph')).toBe(false);

    await userEvent.click(await screen.findByRole('button', { name: /flatmap-stream@0.1.1/ }));
    expect(screen.getByTestId('where')).toHaveTextContent('/projects/p1/investigate?finding=f1');
    // Dossier header (the centre's node-details panel repeats the label).
    expect((await screen.findAllByRole('heading', { level: 2, name: /flatmap-stream@0.1.1/ }))[0]).toHaveTextContent('Critical');
    const graphCall = calls.find((c) => c.path === '/api/graph')!;
    expect(graphCall.url.searchParams.get('finding')).toBe('f1');
    // Cap note says what was dropped.
    expect(screen.getByRole('note')).toHaveTextContent('Capped at 5 nodes');
    expect(screen.getByRole('note')).toHaveTextContent('12 nodes dropped into groups (12 more components)');
    // Node details for the centre are open by default.
    const panel = screen.getByRole('complementary', { name: 'Node details' });
    expect(within(panel).getByText('maintains')).toBeInTheDocument();
    // Only http(s) evidence becomes a link.
    expect(within(panel).getByRole('link', { name: 'source 1' })).toHaveAttribute('href', 'https://example.org/advisory');
    expect(within(panel).queryByRole('link', { name: 'source 2' })).toBeNull();
    expect(within(panel).getByText('javascript:alert(1)')).toBeInTheDocument();
  });

  it('opens node details from the graph and re-centres on a node', async () => {
    api();
    renderPage(<Investigate />, { path, at: '/projects/p1/investigate?finding=f1', me: meFor('org_admin') });
    await userEvent.click(await screen.findByRole('button', { name: 'node:person:right9ctrl' }));
    const panel = screen.getByRole('complementary', { name: 'Node details' });
    expect(within(panel).getByRole('heading', { name: 'person:right9ctrl' })).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: 'Centre graph here' }));
    expect(screen.getByTestId('where')).toHaveTextContent('node=person%3Aright9ctrl');
  });

  it('searches and lists results by kind', async () => {
    const { calls } = api();
    renderPage(<Investigate />, { path, at: '/projects/p1/investigate', me: meFor('org_admin') });
    await userEvent.type(screen.getByLabelText(/Search packages/), 'right');
    const group = await screen.findByRole('group', { name: 'People, orgs and funders' });
    await userEvent.click(within(group).getByRole('button', { name: /person:right9ctrl/ }));
    await waitFor(() => expect(calls.some((c) => c.path === '/api/graph' && c.url.searchParams.get('node') === 'person:right9ctrl')).toBe(true));
  });

  it('has keyboard-accessible Nodes, appearances and links tabs', async () => {
    api();
    renderPage(<Investigate />, { path, at: '/projects/p1/investigate?finding=f1', me: meFor('org_admin') });
    const graphTab = await screen.findByRole('tab', { name: 'Graph' });
    graphTab.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: /Nodes/ })).toHaveAttribute('aria-selected', 'true');
    const table = screen.getByRole('table', { name: 'Graph nodes' });
    expect(within(table).getAllByRole('row')).toHaveLength(6);
    await userEvent.click(within(table).getByText('web-app'));
    expect(screen.getByRole('complementary', { name: 'Node details' })).toHaveTextContent('Asset');

    await userEvent.click(screen.getByRole('tab', { name: /Where it appears/ }));
    expect(await screen.findByRole('link', { name: PURL })).toHaveAttribute('href', '/projects/p1/findings/f1');
    await userEvent.click(screen.getByRole('tab', { name: /Links and sources/ }));
    expect(screen.getByText('pkg:npm/flatmap-stream → person:right9ctrl')).toBeInTheDocument();
    expect(screen.getByText('unreviewed')).toBeInTheDocument();
  });

  it('does not load finding suggestions without the findings permission', async () => {
    const { calls } = api();
    renderPage(<Investigate />, { path, at: '/projects/p1/investigate', me: meFor('auditor', { permissions: ['investigate'] }) });
    expect(await screen.findByText('Pick something to investigate')).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/api/findings')).toBe(false);
  });

  it('shows a not-found state for a node outside the latest scan', async () => {
    fakeApi({ 'GET /api/findings': () => findings });
    renderPage(<Investigate />, { path, at: '/projects/p1/investigate?node=pkg%3Anpm%2Fnope', me: meFor('org_admin') });
    expect(await screen.findByText('Not in the latest scan')).toBeInTheDocument();
  });
});
