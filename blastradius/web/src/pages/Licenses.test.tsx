/**
 * Licences page against a fake API: tiles filter the table through the URL, the category view has
 * a Table equivalent, sources and disagreements are shown, changes are placed against the version
 * in use, and the policy can be edited only with manage_projects.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { LicensePolicy, LicensePolicyResponse, LicensesResponse } from '@server/api-types';
import { meFor } from '@/test/fixtures';
import { fakeApi, renderPage } from './e-parts/testkit';
import Licenses from './Licenses';

const policy: LicensePolicy = {
  version: 1,
  categories: { permissive: 'allow', weak_copyleft: 'review', strong_copyleft: 'review', network_copyleft: 'review', source_available: 'review', proprietary: 'review', unknown: 'review' },
  ids: [],
};
const p1 = { id: 'p1', name: 'payments-platform' };

function licensesFixture(over: Partial<LicensesResponse> = {}): LicensesResponse {
  return {
    scope: 'org',
    scans: [{ scanId: 's1', project: p1, createdAt: '2026-10-11T00:00:00Z' }],
    scansWithoutLicences: 0,
    policy,
    policyIsDefault: true,
    counts: {
      components: 3,
      byCategory: { permissive: 1, weak_copyleft: 0, strong_copyleft: 0, network_copyleft: 0, source_available: 1, proprietary: 0, unknown: 1 },
      byDecision: { allow: 1, review: 2, deny: 0 },
      changes: 1,
      disagreements: 1,
    },
    rows: [
      {
        purl: 'pkg:npm/react@15.6.1',
        name: 'react',
        version: '15.6.1',
        ecosystem: 'npm',
        expressions: ['BSD-3-Clause'],
        status: 'spdx',
        category: 'permissive',
        source: 'depsdev',
        sources: [
          { source: 'depsdev', raw: ['BSD-3-Clause'], expressions: ['BSD-3-Clause'], status: 'spdx', category: 'permissive', evidence: ['https://deps.dev/npm/react/15.6.1'] },
          { source: 'clearlydefined', raw: ['BSD-3-Clause AND LicenseRef-scancode-facebook-patent-rights-2'], expressions: ['BSD-3-Clause AND LicenseRef-scancode-facebook-patent-rights-2'], status: 'spdx', category: 'unknown' },
        ],
        disagreement: true,
        decision: 'allow',
        rule: 'category Permissive (BSD-3-Clause)',
        projects: [p1],
      },
      {
        purl: 'pkg:maven/org.elasticsearch/elasticsearch@7.11.0',
        name: 'org.elasticsearch:elasticsearch',
        version: '7.11.0',
        ecosystem: 'generic',
        expressions: ['Elastic-2.0', 'SSPL-1.0'],
        status: 'spdx',
        category: 'source_available',
        source: 'depsdev',
        sources: [{ source: 'depsdev', raw: ['Elastic License 2.0', 'Server Side Public License, v 1'], expressions: ['Elastic-2.0', 'SSPL-1.0'], status: 'spdx', category: 'source_available' }],
        disagreement: false,
        decision: 'review',
        rule: 'category Source-available (Elastic-2.0)',
        projects: [p1],
      },
      {
        purl: 'pkg:pypi/sentry@20.10.1',
        name: 'sentry',
        version: '20.10.1',
        ecosystem: 'generic',
        expressions: [],
        status: 'non_standard',
        category: 'unknown',
        source: 'depsdev',
        sources: [{ source: 'depsdev', raw: ['BSL-1.1'], expressions: [], status: 'non_standard', category: 'unknown' }],
        disagreement: false,
        decision: 'review',
        rule: 'unknown: licence not in the SPDX list',
        projects: [p1],
      },
    ],
    changes: [
      {
        purl: 'pkg:npm/react',
        name: 'react',
        version: '15.6.2',
        previousVersion: '15.6.1',
        from: ['BSD-3-Clause'],
        to: ['MIT'],
        fromStatus: 'spdx',
        toStatus: 'spdx',
        fromCategory: 'permissive',
        toCategory: 'permissive',
        added: ['MIT'],
        removed: ['BSD-3-Clause'],
        date: '2017-09-26T00:10:25Z',
        inUse: ['15.6.1'],
        relation: 'after_in_use',
        categoryChange: false,
        source: 'depsdev',
        evidence: ['https://deps.dev/npm/react/15.6.2'],
        projects: [p1],
      },
    ],
    truncated: false,
    classification: [
      { name: 'Blue Oak Council license list', url: 'https://blueoakcouncil.org/list', version: '@blueoak/list 15.0.0', license: 'CC0-1.0' },
      { name: 'ScanCode LicenseDB (AboutCode)', url: 'https://scancode-licensedb.aboutcode.org/', version: 'fetched 2026-10-11', license: 'CC-BY-4.0' },
    ],
    note: 'This is not legal advice.',
    ...over,
  };
}

const policyResponse = (): LicensePolicyResponse => ({ policy, isDefault: true, updatedAt: null, updatedBy: null, defaultPolicy: policy });

describe('<Licenses>', () => {
  it('shows tiles, categories with a Table view, sources and changes', async () => {
    fakeApi({ 'GET /api/licenses': () => licensesFixture(), 'GET /api/license-policy': () => policyResponse() });
    renderPage(<Licenses />, { path: '/licenses', at: '/licenses', me: meFor('appsec') });
    const table = await screen.findByRole('table', { name: 'Component licences' });
    expect(within(table).getByText('Sources disagree:', { exact: false })).toHaveTextContent('ClearlyDefined says BSD-3-Clause AND LicenseRef-scancode-facebook-patent-rights-2');
    expect(within(table).getByRole('link', { name: 'deps.dev' })).toHaveAttribute('href', 'https://deps.dev/npm/react/15.6.1');
    expect(within(table).getByText('not an SPDX licence')).toBeInTheDocument();
    expect(screen.getByText(/not legal advice/)).toBeInTheDocument();
    // Chart by default, Table on request (the accessible view), in the URL.
    expect(screen.getByRole('figure', { name: /Components by licence category: Permissive 1/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Table' }));
    expect(screen.getByRole('table', { name: 'Components by licence category' })).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/licenses?view=table');
    const changes = screen.getByRole('table', { name: 'Licence changes' });
    expect(within(changes).getByText('Upgrading past it changes the licence')).toBeInTheDocument();
    expect(within(changes).getByText('15.6.1 → 15.6.2')).toBeInTheDocument();
  });

  it('filters the table from a tile, through the URL', async () => {
    fakeApi({ 'GET /api/licenses': () => licensesFixture(), 'GET /api/license-policy': () => policyResponse() });
    renderPage(<Licenses />, { path: '/licenses', at: '/licenses', me: meFor('appsec') });
    await screen.findByRole('table', { name: 'Component licences' });
    await userEvent.click(screen.getByRole('button', { name: 'Unknown licence: 1, nothing we could identify' }));
    expect(screen.getByTestId('where')).toHaveTextContent('category=unknown');
    const rows = within(screen.getByRole('table', { name: 'Component licences' })).getAllByRole('row');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toHaveTextContent('sentry@20.10.1');
  });

  it('keeps Edit policy visible but disabled without manage_projects', async () => {
    fakeApi({ 'GET /api/licenses': () => licensesFixture(), 'GET /api/license-policy': () => policyResponse() });
    renderPage(<Licenses />, { path: '/licenses', at: '/licenses', me: meFor('appsec') });
    const edit = await screen.findByRole('button', { name: 'Edit policy' });
    expect(edit).toBeDisabled();
    expect(screen.getByText(/Needs the Manage projects permission/)).toBeInTheDocument();
  });

  it('lets an org admin deny a category and saves the policy', async () => {
    let saved: unknown = null;
    const { calls } = fakeApi({
      'GET /api/licenses': () => licensesFixture(),
      'GET /api/license-policy': () => policyResponse(),
      'PUT /api/license-policy': (c) => {
        saved = c.body;
        return { ...policyResponse(), policy: c.body, isDefault: false };
      },
    });
    renderPage(<Licenses />, { path: '/licenses', at: '/licenses', me: meFor('org_admin') });
    const edit = await screen.findByRole('button', { name: 'Edit policy' });
    await waitFor(() => expect(edit).toBeEnabled());
    await userEvent.click(edit);
    const dialog = await screen.findByRole('dialog', { name: 'Licence policy' });
    const network = within(dialog).getByRole('group', { name: 'Network copyleft' });
    await userEvent.click(within(network).getByRole('radio', { name: 'Denied' }));
    // Unknown licences can never be allowed.
    expect(within(within(dialog).getByRole('group', { name: 'Unknown' })).queryByRole('radio', { name: 'Allowed' })).toBeNull();
    await userEvent.type(within(dialog).getByLabelText('SPDX licence id'), 'MPL-2.0');
    await userEvent.selectOptions(within(dialog).getByLabelText('Decision'), 'allow');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add rule' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save policy' }));
    await waitFor(() => expect(saved).not.toBeNull());
    expect(saved).toMatchObject({ categories: { network_copyleft: 'deny', permissive: 'allow' }, ids: [{ id: 'MPL-2.0', decision: 'allow' }] });
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET' && c.path === '/api/licenses').length).toBeGreaterThan(1));
  });

  it('says when the latest scan predates licence collection', async () => {
    const empty = licensesFixture({ rows: [], changes: [], scansWithoutLicences: 1, counts: { ...licensesFixture().counts, components: 0 } });
    fakeApi({ 'GET /api/licenses': () => empty, 'GET /api/license-policy': () => policyResponse() });
    renderPage(<Licenses />, { path: '/projects/:id/licenses', at: '/projects/p1/licenses', me: meFor('appsec') });
    expect(await screen.findByText('No licence data in the latest scan')).toBeInTheDocument();
    expect(screen.getByText(/ran before licences were collected/)).toBeInTheDocument();
  });
});
