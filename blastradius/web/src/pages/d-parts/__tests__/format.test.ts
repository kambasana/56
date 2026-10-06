import { describe, expect, it, vi } from 'vitest';
import type { ListFindingsResponse } from '@server/api-types';
import { countByLevel, factorLabel, fmtDuration, loadAllFindings, parseLevels, purlLabel, safeHref } from '../format';
import { allowedStatuses, collectEvidence } from '../FindingSections';
import { findingDetail, findingRow } from './kit';

describe('format helpers', () => {
  it('formats purls', () => {
    expect(purlLabel('pkg:npm/%40scope/name@1.0.0?arch=x#sub')).toBe('@scope/name@1.0.0');
    expect(purlLabel('pkg:pypi/requests@2.0')).toBe('requests@2.0');
    expect(purlLabel('repo:payments-api')).toBe('repo:payments-api');
  });

  it('only links http(s) URLs', () => {
    expect(safeHref('https://example.org/a')).toBe('https://example.org/a');
    expect(safeHref('http://example.org/a')).toBeNull();
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('data:text/html,x')).toBeNull();
    expect(safeHref('/relative')).toBeNull();
  });

  it('labels factors and parses levels', () => {
    expect(factorLabel('maintainer_change')).toBe('Maintainer change');
    expect(factorLabel('some_new_factor')).toBe('Some new factor');
    expect(parseLevels('high,bogus,critical,high')).toEqual(['high', 'critical']);
    expect(parseLevels(null)).toEqual([]);
    expect(countByLevel([findingRow(0), findingRow(4), findingRow(1)])).toEqual({ critical: 2, high: 1, medium: 0, low: 0 });
  });

  it('formats durations', () => {
    expect(fmtDuration('2018-01-01T00:00:00Z', '2018-01-01T00:00:42Z')).toBe('42s');
    expect(fmtDuration('2018-01-01T00:00:00Z', '2018-01-01T01:02:00Z')).toBe('1h 2m');
    expect(fmtDuration(null, '2018-01-01T00:00:00Z')).toBe('—');
  });

  it('follows the cursor to load every finding', async () => {
    const rows = Array.from({ length: 1200 }, (_, i) => findingRow(i));
    const fetchPage = vi.fn(async (q: { cursor?: string; limit?: number }): Promise<ListFindingsResponse> => {
      const off = Number(q.cursor ?? 0);
      const items = rows.slice(off, off + (q.limit ?? 50));
      return { items, total: rows.length, nextCursor: off + items.length < rows.length ? String(off + items.length) : null, scan: null };
    });
    const out = await loadAllFindings('p1', new AbortController().signal, fetchPage as never);
    expect(out.items).toHaveLength(1200);
    expect(out.capped).toBe(false);
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(fetchPage.mock.calls[0]![0]).toMatchObject({ project: 'p1', limit: 500, sort: '-score' });
  });

  it('pins later pages to the first page\'s scan', async () => {
    const rows = Array.from({ length: 700 }, (_, i) => findingRow(i));
    const scan = { id: 'scan_1', finishedAt: '2018-11-27T00:00:00Z' };
    const fetchPage = vi.fn(async (q: { cursor?: string; limit?: number }): Promise<ListFindingsResponse> => {
      const off = Number(q.cursor ?? 0);
      const items = rows.slice(off, off + (q.limit ?? 50));
      return { items, total: rows.length, nextCursor: off + items.length < rows.length ? String(off + items.length) : null, scan } as unknown as ListFindingsResponse;
    });
    await loadAllFindings('p1', new AbortController().signal, fetchPage as never);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(fetchPage.mock.calls[0]![0]).not.toHaveProperty('scan');
    expect(fetchPage.mock.calls[1]![0]).toMatchObject({ scan: 'scan_1', cursor: '500' });
  });

  it('collects evidence once and maps statuses to permissions', () => {
    const d = findingDetail(findingRow(1));
    expect(collectEvidence(d).map((e) => e.url)).toEqual(['https://example.org/advisory/1', 'javascript:alert(1)', 'https://example.org/incident']);
    expect(allowedStatuses(() => false)).toEqual([]);
    expect(allowedStatuses((p) => p === 'accept_risk')).toEqual(['accepted_risk']);
    expect(allowedStatuses(() => true)).toEqual(['new', 'reviewed', 'accepted_risk']);
    // Review alone cannot move a finding out of accepted_risk.
    expect(allowedStatuses((p) => p === 'review', 'accepted_risk')).toEqual([]);
    expect(allowedStatuses((p) => p === 'review', 'new')).toEqual(['new', 'reviewed']);
  });
});
