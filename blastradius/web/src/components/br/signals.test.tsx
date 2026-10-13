import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ReachTag } from './ReachTag';
import { SeverityBadge } from './SeverityBadge';
import { ACCEPTED_RISK, FINDING_STEPS, INCIDENT_STEPS, StatusTrack } from './StatusTrack';
import { reachOf, severityText } from './severity';

describe('<SeverityBadge>', () => {
  it('always shows the shape and the word, with severity tokens', () => {
    render(
      <>
        <SeverityBadge level="critical" />
        <SeverityBadge level="high" variant="plain" />
        <SeverityBadge level="medium" size="md" />
        <SeverityBadge level="low" />
      </>,
    );
    const crit = screen.getByText('Critical');
    expect(crit).toHaveTextContent('◆Critical');
    expect(crit).toHaveAttribute('data-level', 'critical');
    expect(crit.className).toContain('bg-sev-critical-soft');
    expect(crit.className).toContain('text-sev-critical');
    expect(crit.querySelector('[aria-hidden=true]')).toHaveTextContent('◆');
    const high = screen.getByText('High');
    expect(high).toHaveTextContent('▲High');
    expect(high.className).not.toContain('bg-sev-high-soft');
    expect(screen.getByText('Medium')).toHaveTextContent('●Medium');
    expect(screen.getByText('Low')).toHaveTextContent('○Low');
  });

  it('falls back to Low for an unknown level', () => {
    render(<SeverityBadge level={'bogus' as 'low'} />);
    expect(screen.getByText('Low')).toHaveAttribute('data-level', 'low');
    expect(severityText('critical')).toBe('◆ Critical');
  });
});

describe('<ReachTag>', () => {
  it('tells production from dev by weight and outline, not hue', () => {
    render(
      <>
        <ReachTag reach="production" />
        <ReachTag reach="dev" />
        <ReachTag reach="unknown" />
      </>,
    );
    const prod = screen.getByText('Production');
    expect(prod.className).toContain('font-semibold');
    expect(prod.className).toContain('border-solid');
    expect(screen.getByText('Dev and test').className).toContain('border-dashed');
    expect(screen.getByText('Unknown')).toHaveAttribute('data-reach', 'unknown');
  });

  it('shows a short count with the full label for screen readers', () => {
    render(<ReachTag reach="production" count={1} />);
    const tag = screen.getByText(/1 prod/);
    expect(tag).toHaveTextContent('Production: 1 prod');
    expect(tag).toHaveAttribute('title', 'Production');
    expect(reachOf(true)).toBe('production');
    expect(reachOf(false)).toBe('dev');
    expect(reachOf(null)).toBe('unknown');
  });
});

describe('<StatusTrack>', () => {
  it('marks the current step', () => {
    render(<StatusTrack steps={FINDING_STEPS} current="Triaged" label="Finding status" />);
    const list = screen.getByRole('list', { name: 'Finding status' });
    const items = Array.from(list.querySelectorAll('li'));
    expect(items.map((li) => li.textContent)).toEqual(['Open', '› Triaged', '› Fixing', '› Resolved']);
    expect(items[1]).toHaveAttribute('aria-current', 'step');
    expect(items[0]).not.toHaveAttribute('aria-current');
  });

  it('shows Accepted risk as a separate end state', () => {
    render(<StatusTrack steps={FINDING_STEPS} current={ACCEPTED_RISK} />);
    expect(screen.getByText('Accepted risk')).toHaveAttribute('aria-current', 'step');
    expect(document.querySelectorAll('li[aria-current]')).toHaveLength(0);
  });

  it('has the incident steps', () => {
    render(<StatusTrack steps={INCIDENT_STEPS} current="Monitoring" />);
    expect(screen.getByText(/Monitoring/)).toHaveAttribute('aria-current', 'step');
  });
});
