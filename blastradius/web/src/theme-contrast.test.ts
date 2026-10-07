/**
 * WCAG AA contrast of the theme tokens in index.css, light and dark.
 * Text tokens must reach 4.5:1 on every surface they are drawn on (background, card,
 * muted/secondary, the table header tint muted/50, the sidebar) and on their own 10% chip tint.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

type Rgb = [number, number, number];

function oklchToRgb(L: number, C: number, H: number): Rgb {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const enc = (x: number) => {
    const v = Math.min(1, Math.max(0, x));
    return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  };
  return [enc(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), enc(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), enc(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)];
}
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = ([r, g, b]: Rgb) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (x: Rgb, y: Rgb) => {
  const hi = Math.max(lum(x), lum(y));
  const lo = Math.min(lum(x), lum(y));
  return (hi + 0.05) / (lo + 0.05);
};
const mix = (fg: Rgb, bg: Rgb, alpha: number): Rgb => [0, 1, 2].map((i) => fg[i]! * alpha + bg[i]! * (1 - alpha)) as Rgb;

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  const body = css.slice(start, css.indexOf('\n}', start)).replace(/\/\*[\s\S]*?\*\//g, '');
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}
// jsdom rewrites import.meta.url's scheme, so take the path only.
const css = readFileSync(join(dirname(new URL(import.meta.url).pathname), 'index.css'), 'utf8');
const light = block(':root');
const themes: Record<string, Record<string, string>> = { light, dark: { ...light, ...block('.dark') } };

function color(t: Record<string, string>, name: string): Rgb {
  let v = t[name];
  for (let i = 0; v?.startsWith('var(') && i < 5; i++) v = t[v.slice(6, -1)];
  const m = v?.match(/^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/);
  if (!m) throw new Error(`--${name} is not an opaque oklch() colour: ${v}`);
  return oklchToRgb(Number(m[1]), Number(m[2]), Number(m[3]));
}

const TEXT = ['foreground', 'muted-foreground', 'level-critical', 'level-high', 'level-medium', 'level-low', 'warning', 'success', 'info', 'sidebar-foreground'];

describe.each(Object.keys(themes))('theme contrast (%s)', (name) => {
  const t = themes[name]!;
  const surfaces: Record<string, Rgb> = {
    background: color(t, 'background'),
    card: color(t, 'card'),
    muted: color(t, 'muted'),
    secondary: color(t, 'secondary'),
    accent: color(t, 'accent'),
    sidebar: color(t, 'sidebar'),
    'sidebar-accent': color(t, 'sidebar-accent'),
    'muted/50 on background': mix(color(t, 'muted'), color(t, 'background'), 0.5),
    'muted/50 on card': mix(color(t, 'muted'), color(t, 'card'), 0.5),
  };

  it.each(TEXT)('--%s reaches 4.5:1 on every surface', (fg) => {
    const f = color(t, fg);
    for (const [s, bg] of Object.entries(surfaces)) expect.soft(ratio(f, bg), `${fg} on ${s}`).toBeGreaterThanOrEqual(4.5);
  });

  it.each(['level-high', 'level-medium'])('--%s reaches 4.5:1 on its own 10%% chip', (fg) => {
    const f = color(t, fg);
    for (const s of ['background', 'card'] as const) expect(ratio(f, mix(f, surfaces[s]!, 0.1))).toBeGreaterThanOrEqual(4.5);
  });

  it('white text reaches 4.5:1 on the critical badge', () => {
    const crit = color(t, 'level-critical');
    for (const s of ['background', 'card'] as const) {
      const chip = name === 'dark' ? mix(crit, surfaces[s]!, 0.6) : crit; // dark:bg-level-critical/60
      expect(ratio([1, 1, 1], chip)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
