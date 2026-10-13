import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DegradedSourcesAlert, NotAnalysedAlert, notAnalysedTitle } from './NotAnalysedBanner';

// Real entries from the jitsi-meet scan at 36d4c1c7 (Tier 0).
const LIST = [
  { file: 'Gemfile.lock', ecosystem: 'gem', reason: 'Gemfile.lock is not supported yet', packages: 63 },
  { file: 'ios/Podfile.lock', ecosystem: 'cocoapods', reason: 'Podfile.lock is not supported yet', packages: 112 },
  { file: 'react-native-sdk/package.json', ecosystem: 'npm', reason: 'no package-lock.json: versions not resolved', packages: 73 },
  { file: 'android/app/build.gradle', ecosystem: 'maven', reason: 'Gradle build is not supported yet' },
];

describe('NotAnalysedAlert', () => {
  it('says loudly what was not analysed and roughly how many packages', () => {
    expect(notAnalysedTitle(LIST)).toBe('NOT ANALYSED: Gemfile.lock, ios/Podfile.lock, react-native-sdk/package.json (+1 more), ~248+ packages');
    render(<NotAnalysedAlert list={LIST} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('NOT ANALYSED: Gemfile.lock');
    expect(alert).toHaveTextContent('This is not an all-clear for them.');
    expect(alert).toHaveTextContent('android/app/build.gradle: Gradle build is not supported yet');
  });
  it('renders nothing when everything was analysed', () => {
    const { container } = render(<NotAnalysedAlert list={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('DegradedSourcesAlert', () => {
  it('names the failed security source and why', () => {
    render(<DegradedSourcesAlert sources={[{ source: 'osv', status: 'failed', security: true, facts: 0, problems: 1, reason: 'osv: querybatch for 1569 package(s): fetch failed' }]} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('SECURITY SOURCE INCOMPLETE: osv failed');
    expect(alert).toHaveTextContent('a missing finding does not mean the package is clean');
  });
});
