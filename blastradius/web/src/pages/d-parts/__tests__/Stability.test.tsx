/**
 * Stability labels (docs/WHO-BEHIND-PLAN.md §4, P3): the Maintenance-tab table with its detail
 * panel, the label's facts with source and confidence, "funding not yet assessed", and the
 * Changes-page S5a section. Wording is factual; nothing reads as a security verdict.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { ProjectStabilityResponse, StabilityEntry, UpkeepEventsResponse } from '@server/api-types';
import { StabilityBadge, StabilityDetails, StabilitySection, UpkeepEventsSection } from '../Stability';

const DISCLAIMER = 'Stability describes upkeep from public records (registry, repository, Scorecard). It is not a security verdict and not a finding of wrongdoing.';

const request: StabilityEntry = {
  package: 'pkg:npm/request',
  name: 'request',
  versions: ['2.88.2'],
  production: true,
  label: 'fragile',
  summary: 'Deprecated on npm, used in production.',
  rules: [
    {
      rule: 'fragile_ended_production',
      name: 'Fragile: S3 ended (high confidence) while a production dependency',
      facts: [
        { signal: 'S3', text: 'npm marks the latest release (2.88.2) deprecated: "request has been deprecated, see https://github.com/request/request/issues/3142".', source: 'npm', confidence: 'high', evidence: ['https://www.npmjs.com/package/request/v/2.88.2'] },
        { signal: 'S3', text: 'Reached through a runtime (non-dev) dependency path in this scan.', source: 'inventory', confidence: 'high' },
      ],
    },
  ],
  context: [{ signal: 'S1', text: 'npm lists 4 maintainers with publish rights.', source: 'npm', confidence: 'high' }],
  missing: [],
  s3: { state: 'ended', confidence: 'high', lastCommit: '2020-02-11', lastRelease: '2020-02-11' },
  caf: { value: 2, commits: 70, from: '2018-02-12', to: '2020-02-11' },
  s5a: [],
  funding: 'not_assessed',
};

const ms: StabilityEntry = {
  ...request,
  package: 'pkg:npm/ms',
  name: 'ms',
  versions: ['2.1.1'],
  label: 'unknown',
  summary: 'Not enough data: git history not read.',
  rules: [],
  context: [],
  missing: ['The git history of https://github.com/zeit/ms was not read in this scan.'],
  s3: { state: 'unknown', confidence: 'low' },
};

const data: ProjectStabilityResponse = { scanId: 's1', asOf: '2026-10-11T00:00:00Z', entries: [ms, request], counts: { fragile: 1, watch: 0, steady: 0, unknown: 1 }, disclaimer: DISCLAIMER, funding: 'not_assessed' };

describe('stability labels', () => {
  it('badges: Fragile, Watch with a dot, Steady plain, Unknown grey', () => {
    render(
      <>
        <StabilityBadge label="fragile" />
        <StabilityBadge label="watch" />
        <StabilityBadge label="steady" />
        <StabilityBadge label="unknown" />
      </>,
    );
    expect(screen.getByText('Fragile')).toHaveAttribute('data-stability', 'fragile');
    expect(screen.getByText('Watch').querySelector('span[aria-hidden="true"]')).not.toBeNull();
    expect(screen.getByText('Unknown')).toHaveAttribute('data-stability', 'unknown');
  });

  it('details list the rule, each fact with its source and confidence, context, and that funding is not assessed', () => {
    render(<StabilityDetails entry={request} disclaimer={DISCLAIMER} />);
    expect(screen.getByRole('heading', { name: 'Fragile: S3 ended (high confidence) while a production dependency' })).toBeVisible();
    const rules = screen.getByRole('region', { name: 'Rules that fired' });
    expect(within(rules).getByText(/request has been deprecated/)).toBeVisible();
    expect(within(rules).getAllByText(/S3 · npm registry · high confidence/)).toHaveLength(1);
    expect(within(rules).getByRole('link', { name: 'npmjs.com/package/request/v/2.88.2' })).toHaveAttribute('href', 'https://www.npmjs.com/package/request/v/2.88.2');
    expect(screen.getByRole('region', { name: 'Context' })).toHaveTextContent('npm lists 4 maintainers');
    expect(screen.getByText(/Funding not yet assessed/)).toBeVisible();
    expect(screen.getByText(/not a security verdict/)).toBeVisible();
  });

  it('the Maintenance-tab table sorts Fragile first and opens the facts in a side panel', async () => {
    render(
      <MemoryRouter>
        <StabilitySection data={data} loading={false} />
      </MemoryRouter>,
    );
    expect(screen.getByText('Fragile 1 · Watch 0 · Steady 0 · Unknown 1')).toBeVisible();
    const table = screen.getByRole('table', { name: 'Stability labels' });
    const rows = within(table).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('request');
    expect(rows[2]).toHaveTextContent('ms');
    await userEvent.click(within(rows[1]!).getByText('request'));
    const panel = await screen.findByRole('complementary', { name: 'Stability details' });
    expect(within(panel).getByText(/request has been deprecated/)).toBeVisible();
    expect(within(panel).getByText(/2 over 70 commits/)).toBeVisible();
  });

  it('a small, finished package: Watch with its rule and facts, and the finished test in the side panel', async () => {
    const utils: StabilityEntry = {
      ...request,
      package: 'pkg:npm/utils-merge',
      name: 'utils-merge',
      versions: ['1.0.1'],
      label: 'watch',
      summary: 'Small, finished package: single maintainer, no recent activity.',
      rules: [
        {
          rule: 'watch_finished_single_contributor_inactive',
          name: 'Watch: small, finished package: single maintainer, no recent activity',
          facts: [{ signal: 'S3', text: 'Small package: 1.0.1 is 3.6 kB unpacked in 5 files, with 0 dependencies of its own (read from the published tarball).', source: 'npm', confidence: 'high' }],
        },
      ],
      s3: { state: 'inactive', confidence: 'medium', lastCommit: '2017-07-08', lastRelease: '2017-07-08' },
      finished: { state: 'yes', notMet: [], size: { unpackedSize: 3720, fileCount: 5, dependencies: 0 } },
    };
    render(
      <MemoryRouter>
        <StabilitySection data={{ ...data, entries: [utils], counts: { fragile: 0, watch: 1, steady: 0, unknown: 0 } }} loading={false} />
      </MemoryRouter>,
    );
    const table = screen.getByRole('table', { name: 'Stability labels' });
    await userEvent.click(within(table).getByText('utils-merge'));
    const panel = await screen.findByRole('complementary', { name: 'Stability details' });
    expect(within(panel).getByRole('heading', { name: 'Watch: small, finished package: single maintainer, no recent activity' })).toBeVisible();
    expect(within(panel).getByText('Small, finished package')).toBeVisible();
    expect(within(panel).getByText('Yes · 3.6 kB, 5 files, 0 dependencies')).toBeVisible();
  });

  it('says so when the newest scan predates labels', () => {
    render(
      <MemoryRouter>
        <StabilitySection data={{ ...data, entries: null, counts: null }} loading={false} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/made before stability labels existed/)).toBeVisible();
  });

  it('Tier 0: the coverage line, a pending background history, family decisions and the moved action', async () => {
    const agent: StabilityEntry = {
      ...request,
      package: 'pkg:npm/agent-base',
      name: 'agent-base',
      versions: ['6.0.2'],
      label: 'watch',
      summary: 'Moved to another repository and still released.',
      rules: [{ rule: 'watch_moved', name: 'Watch: moved to another repository and still released (upgrade)', facts: [{ signal: 'S3', text: 'The latest release 9.0.0 (2026-04-01) declares the repository github.com/TooTallNate/proxy-agents.', source: 'npm', confidence: 'high' }] }],
      action: 'Moved: upgrade to 9.x (repo github.com/TooTallNate/proxy-agents, packages/agent-base)',
      repo: { current: 'https://github.com/TooTallNate/proxy-agents', directory: 'packages/agent-base', previous: ['https://github.com/TooTallNate/node-agent-base'] },
      basis: 'npm',
      s3: { state: 'unknown', confidence: 'low', lastRelease: '2026-04-01' },
    };
    render(
      <MemoryRouter>
        <StabilitySection
          data={{
            ...data,
            entries: [agent],
            counts: { fragile: 0, watch: 1, steady: 0, unknown: 0 },
            coverage: { packages: 1, assessed: 1, byBasis: { git: 0, 'scorecard+npm': 0, npm: 1 }, direct: { total: 1, assessed: 1 }, runtimeTransitive: { total: 0, assessed: 0 }, production: { total: 1, unknown: 0 }, skipped: [], line: 'Upkeep assessed for 1 of 1 (Scorecard / npm fallback 1): all 1 direct, all 0 runtime transitive; skipped: none.' },
            historyStatus: 'pending',
            decisions: [{ direct: 'ldapjs', label: 'fragile', packages: ['ldapjs', '@ldapjs/asn1'], rules: ['fragile_ended_production'], action: 'Replace or upgrade ldapjs (direct dependency): it and 1 package of the same family it brings in are Fragile (deprecated on npm, used in production).' }],
          }}
          loading={false}
        />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('stability-coverage')).toHaveTextContent(/^Upkeep assessed for 1 of 1/);
    expect(screen.getByRole('status')).toHaveTextContent(/Git history is being read in the background/);
    expect(screen.getByRole('list', { name: 'Upkeep decisions' })).toHaveTextContent(/Replace or upgrade ldapjs \(direct dependency\)/);
    await userEvent.click(within(screen.getByRole('table', { name: 'Stability labels' })).getByText('agent-base'));
    const panel = await screen.findByRole('complementary', { name: 'Stability details' });
    expect(within(panel).getByTestId('stability-action')).toHaveTextContent('Moved: upgrade to 9.x');
    expect(within(panel).getByText(/github.com\/TooTallNate\/proxy-agents \(packages\/agent-base\) · earlier: github.com\/TooTallNate\/node-agent-base/)).toBeVisible();
    expect(within(panel).getByText('The npm release record; git history not read')).toBeVisible();
  });

  it('the Changes section lists upkeep events (crossings between two scans), or says the first scan is the baseline', () => {
    const upkeep: UpkeepEventsResponse = {
      baseline: false,
      since: '2018-08-29',
      events: [{ id: 'x', kind: 'release_continuity', date: '2018-09-05', packages: ['event-stream'], rules: ['npm_release_by_new_account'], release: '3.3.5', text: 'Release 3.3.5 was published on npm by an account first seen in this repository 1 days earlier.', evidence: [] }],
      omitted: { older: 2, notProduction: 1, overLimit: 0 },
    };
    const { unmount } = render(<UpkeepEventsSection upkeep={upkeep} />);
    const list = screen.getByRole('list', { name: 'Upkeep events' });
    expect(list).toHaveTextContent('Release by a new account');
    expect(list).toHaveTextContent('2018-09-05');
    expect(screen.getByText(/2 older or further crossings not listed; 1 in dev-only dependencies left out/)).toBeVisible();
    unmount();
    render(<UpkeepEventsSection upkeep={{ ...upkeep, baseline: true, events: [] }} />);
    expect(screen.getByText(/first scan of the project: it is the baseline/)).toBeVisible();
  });
});
