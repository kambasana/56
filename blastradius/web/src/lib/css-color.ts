/**
 * CSS colour helpers for canvas renderers (Cytoscape) that cannot parse the theme's oklch() tokens.
 */
let probe: CanvasRenderingContext2D | null | undefined;

/**
 * Resolve a CSS colour (including oklch(), which Cytoscape cannot parse) to an opaque rgb() by
 * painting one pixel over `base` (Cytoscape ignores alpha in colours, so translucent tokens such
 * as the dark --border are composited onto the card colour). Falls back to the input when no
 * 2D canvas is available.
 */
export function toRgb(color: string, base = '#fff'): string {
  if (!color) return color;
  try {
    if (probe === undefined) {
      const c = document.createElement('canvas');
      c.width = c.height = 1;
      probe = c.getContext('2d', { willReadFrequently: true });
    }
    if (!probe) return color;
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = '#fff';
    probe.fillStyle = base;
    probe.fillRect(0, 0, 1, 1);
    probe.fillStyle = base;
    probe.fillStyle = color;
    probe.fillRect(0, 0, 1, 1);
    const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
    return `rgb(${r}, ${g}, ${b})`;
  } catch {
    return color;
  }
}

