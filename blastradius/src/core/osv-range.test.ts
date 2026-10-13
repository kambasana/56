import { describe, expect, it } from 'vitest';
import { coversAllVersions, inRanges, type OsvRange } from './osv-range.js';

describe('OSV ranges', () => {
  it('treats fixed as exclusive and last_affected as inclusive', () => {
    const fixed: OsvRange[] = [{ events: [{ introduced: '1.0.0' }, { fixed: '1.2.0' }] }];
    expect(['0.9.0', '1.0.0', '1.1.9', '1.2.0'].map((v) => inRanges(v, fixed))).toEqual([false, true, true, false]);
    const last: OsvRange[] = [{ events: [{ introduced: '1.0.0' }, { last_affected: '1.2.0' }] }];
    expect(['1.2.0', '1.2.1'].map((v) => inRanges(v, last))).toEqual([true, false]);
  });

  it('treats limit as an exclusive upper bound, never as an open range', () => {
    const r: OsvRange[] = [{ events: [{ introduced: '1.0.0' }, { limit: '2.0.0' }] }];
    expect(['0.9.0', '1.0.0', '1.9.9', '2.0.0', '2.0.1', '3.0.0'].map((v) => inRanges(v, r))).toEqual([false, true, true, false, false, false]);
    // A limit caps the whole range, including an interval left open after it.
    const capped: OsvRange[] = [{ events: [{ introduced: '0' }, { fixed: '1.0.0' }, { introduced: '1.5.0' }, { limit: '3.0.0' }] }];
    expect(['0.5.0', '1.2.0', '1.5.0', '2.9.9', '3.0.0'].map((v) => inRanges(v, capped))).toEqual([true, false, true, true, false]);
    // "*" means no limit.
    expect(inRanges('9.0.0', [{ events: [{ introduced: '1.0.0' }, { limit: '*' }] }])).toBe(true);
  });

  it('counts a range closed by limit as not every version', () => {
    expect(coversAllVersions([{ events: [{ introduced: '0' }] }])).toBe(true);
    expect(coversAllVersions([{ events: [{ introduced: '0' }, { limit: '2.0.0' }] }])).toBe(false);
    expect(coversAllVersions([{ events: [{ introduced: '0' }, { limit: '*' }] }])).toBe(true);
  });
});
