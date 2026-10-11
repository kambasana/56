/**
 * Stability labels (docs/WHO-BEHIND-PLAN.md §4, P3): the Maintenance-tab table with its detail
 * panel, the label's facts with source and confidence, "funding not yet assessed", and the
 * Changes-page S5a section. Wording is factual; nothing reads as a security verdict.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { ContinuityRow, ProjectStabilityResponse, StabilityEntry } from '@server/api-types';
import { ContinuitySection, StabilityBadge, StabilityDetails, StabilitySection } from '../Stability';

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

  it('says so when the newest scan predates labels', () => {
    render(
      <MemoryRouter>
        <StabilitySection data={{ ...data, entries: null, counts: null }} loading={false} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/made before stability labels existed/)).toBeVisible();
  });

  it('the Changes section lists S5a observations with source and confidence, or says there are none', () => {
    const row: ContinuityRow = {
      id: 'x',
      package: 'pkg:npm/event-stream',
      name: 'event-stream',
      kind: 'npm_release_by_new_account',
      date: '2018-09-05',
      release: '3.3.5',
      daysSinceFirstSeen: 1,
      text: 'Release 3.3.5 was published on npm by an account first seen in this repository 1 days earlier.',
      source: 'npm+git',
      confidence: 'medium',
      production: true,
      isNew: true,
    };
    const { unmount } = render(<ContinuitySection rows={[row]} />);
    const list = screen.getByRole('list', { name: 'Release continuity observations' });
    expect(list).toHaveTextContent('Published by a new account (npm)');
    expect(list).toHaveTextContent('New since the previous scan');
    expect(list).toHaveTextContent('npm and git history · medium confidence');
    unmount();
    render(<ContinuitySection rows={[]} />);
    expect(screen.getByText('No release-continuity observations in the last 12 months.')).toBeVisible();
  });
});
