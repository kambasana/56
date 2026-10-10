/**
 * WCAG contrast of the Blastradius Design System tokens in index.css, light and dark.
 * Text pairs must reach 4.5:1 and marks (control borders, focus ring, graph outlines) 3:1, as
 * the design system specifies (tokens.json "usage" notes).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

type Rgb = [number, number, number];

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = ([r, g, b]: Rgb) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (x: Rgb, y: Rgb) => {
  const hi = Math.max(lum(x), lum(y));
  const lo = Math.min(lum(x), lum(y));
  return (hi + 0.05) / (lo + 0.05);
};

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`\n${selector} {`);
  const body = css.slice(start, css.indexOf('\n}', start + 1)).replace(/\/\*[\s\S]*?\*\//g, '');
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}
// jsdom rewrites import.meta.url's scheme, so take the path only.
const css = readFileSync(join(dirname(new URL(import.meta.url).pathname), 'index.css'), 'utf8');
const light = block(':root');
const themes: Record<string, Record<string, string>> = { light, dark: { ...light, ...block('.dark') } };

function color(t: Record<string, string>, name: string): Rgb {
  let v = t[name];
  for (let i = 0; v?.startsWith('var(') && i < 5; i++) v = t[v.slice(6, -1)];
  const m = v?.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) throw new Error(`--${name} is not an opaque #rrggbb colour: ${v}`);
  return [parseInt(m[1]!, 16) / 255, parseInt(m[2]!, 16) / 255, parseInt(m[3]!, 16) / 255];
}

const SURFACES = ['background', 'card', 'popover', 'muted', 'secondary', 'accent', 'sidebar', 'sidebar-accent'];

/** [text, surfaces it is drawn on] at 4.5:1. */
const TEXT_PAIRS: [string, string[]][] = [
  ['foreground', SURFACES],
  ['text-secondary', ['background', 'card', 'muted', 'sidebar']],
  ['muted-foreground', ['background', 'card', 'muted', 'secondary', 'sidebar']],
  ['sidebar-foreground', ['sidebar', 'sidebar-accent']],
  ['primary-foreground', ['primary']],
  ['destructive', ['background', 'card', 'destructive-soft']],
  ['destructive-foreground', ['destructive']],
  ['selection', ['background', 'card', 'selection-soft']],
  ['success', ['background', 'success-soft']],
  ['warning', ['background', 'warning-soft']],
  ['sev-critical', ['background', 'card', 'sev-critical-soft']],
  ['sev-high', ['background', 'card', 'sev-high-soft']],
  ['sev-medium', ['background', 'card', 'sev-medium-soft']],
  ['sev-low', ['background', 'card', 'sev-low-soft']],
  ['reach-prod', ['background', 'card']],
  ['reach-dev', ['background', 'card']],
  ['foreground', ['sev-critical-soft', 'sev-high-soft', 'sev-medium-soft', 'success-soft', 'destructive-soft', 'warning-soft', 'selection-soft']],
];

/** Marks (borders of controls, focus ring, graph strokes) at 3:1 on the page. */
const MARKS = ['input', 'ring', 'node-border', 'edge-runtime', 'edge-dev', 'focus-path'];

describe.each(Object.keys(themes))('theme contrast (%s)', (name) => {
  const t = themes[name]!;

  it.each(TEXT_PAIRS)('--%s reaches 4.5:1 on its surfaces', (fg, surfaces) => {
    for (const s of surfaces) expect.soft(ratio(color(t, fg), color(t, s)), `${fg} on ${s}`).toBeGreaterThanOrEqual(4.5);
  });

  it.each(MARKS)('--%s reaches 3:1 on background and card', (mark) => {
    for (const s of ['background', 'card']) expect.soft(ratio(color(t, mark), color(t, s)), `${mark} on ${s}`).toBeGreaterThanOrEqual(3);
  });

  it('keeps the legacy --level-* aliases on the severity tokens', () => {
    expect(t['level-critical']).toBe('var(--sev-critical)');
    expect(t['level-low']).toBe('var(--sev-low)');
  });
});
