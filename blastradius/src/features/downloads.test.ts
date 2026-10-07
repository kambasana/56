import { describe, expect, it } from 'vitest';
import { DOWNLOADS_LAG_DAYS, downloadsAsOf } from './downloads.js';

const DAY = 86_400_000;
const from = '2024-01-01';
const at = (i: number) => Date.parse(`${from}T00:00:00Z`) + i * DAY;

describe('downloadsAsOf', () => {
  it('uses the week ending two days before the release day, and the 12 weeks before it for the trend', () => {
    // 100 days of 10/day, then a spike that must not be seen by an earlier release.
    const counts = [...Array(100).fill(10), ...Array(20).fill(1000)];
    const s = { from, counts };
    // Release on day 102 at 23:00: last day used is 100 (first spike day)
    const r = downloadsAsOf(s, at(102) + 23 * 3600_000);
    expect(r.weekly).toBe(6 * 10 + 1000);
    expect(r.trend).toBeCloseTo((60 + 1000) / 70);
    // Release on day 101: last day used is 99, no spike yet.
    expect(downloadsAsOf(s, at(101) + 3600_000)).toEqual({ weekly: 70, trend: 1 });
    expect(DOWNLOADS_LAG_DAYS).toBe(2);
  });

  it('is empty when the window is not fully known, never zero-filled', () => {
    const counts: (number | null)[] = Array(100).fill(5);
    counts[95] = null;
    expect(downloadsAsOf({ from, counts }, at(98))).toEqual({});
    expect(downloadsAsOf({ from, counts }, at(3))).toEqual({});
    expect(downloadsAsOf(undefined, at(50))).toEqual({});
    // Week known, trailing weeks not: weekly only.
    expect(downloadsAsOf({ from, counts: Array(20).fill(3) }, at(15))).toEqual({ weekly: 21 });
  });

  it('a zero trailing mean gives no trend', () => {
    const counts = [...Array(92).fill(0), ...Array(8).fill(4)];
    expect(downloadsAsOf({ from, counts }, at(100))).toEqual({ weekly: 28 });
  });
});
