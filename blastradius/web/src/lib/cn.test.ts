import { describe, expect, it } from 'vitest';
import { cn, fmtBlast, fmtNum } from './cn';

describe('formatting', () => {
  it('formats blast scores with two decimals instead of rounding them away', () => {
    expect(fmtBlast(0.167)).toBe('0.17');
    expect(fmtBlast(0.088)).toBe('0.09');
    expect(fmtBlast(0.356)).toBe('0.36');
    expect(fmtBlast(0.004)).toBe('<0.01');
    expect(fmtBlast(0)).toBe('0.00');
    expect(fmtBlast(1234.5)).toBe('1,234.50');
    expect(fmtBlast(null)).toBe('—');
    expect(fmtBlast(Number.NaN)).toBe('—');
  });

  it('formats counts with grouping', () => {
    expect(fmtNum(12345)).toBe('12,345');
    expect(fmtNum(undefined)).toBe('—');
  });

  it('keeps a text colour next to a type-scale size (text-label is a size, not a colour)', () => {
    expect(cn('text-primary-foreground', 'text-label')).toBe('text-primary-foreground text-label');
    expect(cn('text-sm', 'text-label')).toBe('text-label');
    expect(cn('text-red-500', 'text-foreground')).toBe('text-foreground');
  });
});
