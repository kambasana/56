import { describe, expect, it } from 'vitest';
import type { GraphResponse } from '@server/api-types';
import { displayLabel, labelWidth, layeredPositions, layoutOptions, separateBoxes, toElements, type Box } from './GraphCanvas';

const overlap = (a: Box, b: Box) => Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1) > 0 && Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1) > 0;
const moved = (b: Box, o: { dx: number; dy: number }): Box => ({ x1: b.x1 + o.dx, x2: b.x2 + o.dx, y1: b.y1 + o.dy, y2: b.y2 + o.dy });

describe('GraphCanvas helpers', () => {
  it('decodes URL escapes in labels for display', () => {
    expect(displayLabel('%40vue/cli-service@4.5.15')).toBe('@vue/cli-service@4.5.15');
    expect(displayLabel('plain@1.0.0')).toBe('plain@1.0.0');
    expect(displayLabel('broken%E0%A4%A')).toBe('broken%E0%A4%A');
    const graph = { centre: 'a', nodes: [{ id: 'pkg:npm/%40vue/cli@1', kind: 'component', label: '%40vue/cli@1' }], edges: [], truncated: false } as unknown as GraphResponse;
    expect(toElements(graph)[0]!.data.label).toBe('@vue/cli@1');
    expect(toElements(graph)[0]!.data.id).toBe('pkg:npm/%40vue/cli@1');
  });

  it('separates overlapping node + label boxes so no two overlap', () => {
    // A row of 30 wide labels stacked at nearly the same spot, like siblings in a busy layer.
    const boxes: Box[] = Array.from({ length: 30 }, (_, i) => ({ x1: i * 3, x2: i * 3 + 140, y1: (i % 3) * 2, y2: (i % 3) * 2 + 30 }));
    const out = separateBoxes(boxes, { iterations: 400 }).map((o, i) => moved(boxes[i]!, o));
    for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) expect(overlap(out[i]!, out[j]!), `${i}/${j}`).toBe(false);
  });

  it('leaves boxes that already fit where they are', () => {
    const boxes: Box[] = [
      { x1: 0, x2: 50, y1: 0, y2: 20 },
      { x1: 100, x2: 150, y1: 0, y2: 20 },
    ];
    expect(separateBoxes(boxes)).toEqual([
      { dx: 0, dy: 0 },
      { dx: 0, dy: 0 },
    ]);
  });

  it('layered layout wraps a wide layer into rows that fit the canvas, centre on top', () => {
    const kids = Array.from({ length: 30 }, (_, i) => `dependent-package-${i}@1.0.0`);
    const ids = ['c', ...kids, 'asset'];
    const edges = [...kids.map((k) => [k, 'c'] as const), ['asset', kids[0]!] as const];
    const pos = layeredPositions(ids, edges, 'c', { width: 860, nodeWidth: (id) => Math.max(28, labelWidth(id)) });
    expect(pos.c).toEqual({ x: 0, y: 0 });
    const rows = new Map<number, string[]>();
    for (const k of kids) rows.set(pos[k]!.y, [...(rows.get(pos[k]!.y) ?? []), k]);
    expect(rows.size).toBeGreaterThan(1); // wrapped, not one 30-label strip
    for (const [, row] of rows) {
      const xs = row.map((k) => pos[k]!.x);
      expect(Math.max(...xs) - Math.min(...xs) + labelWidth(row[0]!)).toBeLessThanOrEqual(860);
    }
    expect(pos.asset!.y).toBeGreaterThan(Math.max(...kids.map((k) => pos[k]!.y)));
    // Same-row label boxes never overlap.
    const boxes: Box[] = ids.map((id) => ({ x1: pos[id]!.x - labelWidth(id) / 2, x2: pos[id]!.x + labelWidth(id) / 2, y1: pos[id]!.y, y2: pos[id]!.y + 30 }));
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i]!, boxes[j]!), `${ids[i]}/${ids[j]}`).toBe(false);
  });

  it('puts nodes not connected to the centre in a last layer and copes with a missing centre', () => {
    const pos = layeredPositions(['a', 'b', 'lonely'], [['a', 'b']], 'a', { width: 800, nodeWidth: () => 40 });
    expect(pos.lonely!.y).toBeGreaterThan(pos.b!.y);
    expect(Object.keys(layeredPositions(['x', 'y'], [], 'missing', { width: 800, nodeWidth: () => 40 }))).toEqual(['x', 'y']);
  });

  it('uses the layered preset for "breadthfirst" and no animation anywhere', () => {
    expect(layoutOptions('breadthfirst', 'c')).toMatchObject({ name: 'preset', fit: true });
    for (const l of ['breadthfirst', 'cose', 'concentric'] as const) expect(layoutOptions(l, 'c')).toMatchObject({ animate: false });
  });
});
