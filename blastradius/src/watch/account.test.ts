import { describe, expect, it } from 'vitest';
import { AccountIndex, burstWarnings, type PublishEvent } from './account.js';

const H = 3600_000;
const idx = new AccountIndex([
  { name: 'a', versions: [{ v: '1.0.0', t: '2025-01-01T00:00:00Z', u: 'x', m: ['x', 'y'] }, { v: '1.0.1', t: '2025-05-01T00:00:00Z', u: 'y', m: ['y'] }] },
  { name: 'b', versions: [{ v: '1.0.0', t: '2025-01-01T00:00:00Z', u: 'x', m: ['x'] }, { v: '1.0.1', t: '2025-02-01T00:00:00Z', gone: true }] },
  { name: 'c', versions: [{ v: '1.0.0', t: '2025-01-01T00:00:00Z', u: 'x', m: ['x', 'z'] }, { v: '1.0.1', t: '2025-02-01T00:00:00Z', gone: true }] },
]);

describe('AccountIndex', () => {
  it('answers "can publish" as of a time, from the latest version at or before it', () => {
    expect(idx.packagesOf('x', Date.parse('2025-03-01T00:00:00Z'))).toEqual(['a', 'b', 'c']);
    expect(idx.packagesOf('x', Date.parse('2025-06-01T00:00:00Z'))).toEqual(['b', 'c']);
    expect(idx.packagesOf('x', Date.parse('2024-06-01T00:00:00Z'))).toEqual([]);
  });

  it('attributes a deleted version only to a sole previous maintainer', () => {
    expect(idx.publisherOf('b', '1.0.1')).toEqual({ account: 'x', attribution: 'sole-maintainer' });
    expect(idx.publisherOf('c', '1.0.1')).toBeUndefined();
    expect(idx.publishEvents(0, Date.parse('2026-01-01T00:00:00Z')).unattributed).toBe(1);
  });
});

describe('burstWarnings', () => {
  const ev = (account: string, name: string, h: number): PublishEvent => ({ account, name, version: '1', at: h * H, attribution: 'npmUser' });
  it('fires on N distinct packages within the window and merges an episode', () => {
    const events = [ev('q', 'p1', 0), ev('q', 'p2', 1), ev('q', 'p3', 2), ev('q', 'p4', 3), ev('q', 'p5', 4), ev('q', 'p6', 5), ev('q', 'p1', 5.5)];
    const eps = burstWarnings(events, { n: 5, windowMs: 6 * H });
    expect(eps).toHaveLength(1);
    expect(eps[0]!.firedAt).toBe(4 * H);
  });
  it('does not count the same package twice or events outside the window', () => {
    const events = [ev('q', 'p1', 0), ev('q', 'p1', 1), ev('q', 'p2', 2), ev('q', 'p3', 3), ev('q', 'p4', 7), ev('q', 'p5', 8)];
    expect(burstWarnings(events, { n: 5, windowMs: 6 * H })).toEqual([]);
  });
});
