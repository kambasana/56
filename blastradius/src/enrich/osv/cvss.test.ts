import { describe, expect, it } from 'vitest';
import { cvss3BaseScore, roundUp1, severityForCvss, severityFromLabel } from './cvss.js';

describe('cvss3BaseScore', () => {
  it.each([
    ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', 9.8],
    ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H', 10],
    ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H', 7.5],
    ['CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:H/A:H', 8.1],
    ['CVSS:3.0/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N', 5.5],
    ['CVSS:3.1/AV:N/AC:L/PR:L/UI:R/S:C/C:L/I:L/A:N', 5.4],
    ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N', 0],
  ])('%s → %d', (vector, score) => {
    expect(cvss3BaseScore(vector)).toBe(score);
  });

  it('rejects non-v3 and incomplete vectors', () => {
    expect(cvss3BaseScore('AV:N/AC:L/Au:N/C:P/I:P/A:P')).toBeUndefined();
    expect(cvss3BaseScore('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N')).toBeUndefined();
    expect(cvss3BaseScore('CVSS:3.1/AV:N/AC:L')).toBeUndefined();
    expect(cvss3BaseScore('CVSS:3.1/AV:X/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H')).toBeUndefined();
  });

  it('rounds up per spec without float noise', () => {
    expect(roundUp1(4.02)).toBe(4.1);
    expect(roundUp1(4.0)).toBe(4);
    expect(roundUp1(4.000001)).toBe(4);
  });
});

describe('severity mapping', () => {
  it('bands scores', () => {
    expect(severityForCvss(9)).toBe('critical');
    expect(severityForCvss(7)).toBe('high');
    expect(severityForCvss(4)).toBe('medium');
    expect(severityForCvss(0.1)).toBe('low');
    expect(severityForCvss(NaN)).toBe('unknown');
  });
  it('maps labels', () => {
    expect(severityFromLabel('MODERATE')).toBe('medium');
    expect(severityFromLabel('critical')).toBe('critical');
    expect(severityFromLabel(undefined)).toBe('unknown');
  });
});
