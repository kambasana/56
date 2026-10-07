import { describe, expect, it } from 'vitest';
import type { GraphResponse } from '@server/api-types';
import { displayLabel, layoutOptions, separateBoxes, toElements, type Box } from './GraphCanvas';

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

  it('spaces every layout by label size', () => {
    for (const l of ['breadthfirst', 'cose', 'concentric'] as const) expect(layoutOptions(l, 'c')).toMatchObject({ nodeDimensionsIncludeLabels: true });
  });
});
