/**
 * Normalise scan outputs so a golden snapshot only changes when the product's answer changes:
 *   - the temporary target directory becomes `<target>` (in every string, every format);
 *   - run-specific values go: generatedAt / timestamps, durations, run ids, and the SBOM serial /
 *     namespace UUIDs (derived from target + generatedAt);
 *   - arrays whose order carries no meaning are sorted (listed in SET_PATHS). Ranked lists
 *     (findings, health, SARIF results, stability packages and decisions) keep the product's order:
 *     their order is part of the answer.
 */
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export type Format = 'json' | 'sarif' | 'cyclonedx' | 'spdx' | 'html';
export const FORMATS: readonly Format[] = ['json', 'sarif', 'cyclonedx', 'spdx', 'html'];

/** Keys dropped wherever they occur (run-specific, never part of the answer). */
const DROP_KEYS = new Set(['generatedAt', 'durationMs', 'runId', 'elapsedMs']);
/** Keys whose value is replaced by a placeholder (kept, so a missing field is still a diff). */
const PLACEHOLDER_KEYS: Record<string, string> = { timestamp: '<timestamp>', created: '<timestamp>', serialNumber: 'urn:uuid:<derived>', documentNamespace: '<derived>' };

/**
 * Arrays sorted before comparison, per format: JSON path pattern (`*` = any key or index) → sort key.
 * Sort keys are field names; `.` sorts by the canonical JSON of the element.
 */
const SET_PATHS: Record<Exclude<Format, 'html'>, [string, string][]> = {
  json: [
    ['$.warnings', '.'],
    ['$.coverage.sources', 'source'],
    ['$.notAnalysed', '.'],
  ],
  sarif: [['$.runs.*.invocations.*.toolExecutionNotifications', '.']],
  cyclonedx: [
    ['$.components', 'bom-ref'],
    ['$.dependencies', 'ref'],
    ['$.dependencies.*.dependsOn', '.'],
  ],
  spdx: [
    ['$.packages', 'SPDXID'],
    ['$.relationships', '.'],
    ['$.creationInfo.creators', '.'],
  ],
};

export function canonical(v: Json): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k]!)}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

function matches(pattern: string[], p: string[]): boolean {
  return pattern.length === p.length && pattern.every((s, i) => s === '*' || s === p[i]);
}

function replaceTarget(s: string, target: string): string {
  return target ? s.split(target).join('<target>') : s;
}

function walk(v: Json, p: string[], target: string, sets: [string[], string][]): Json {
  if (typeof v === 'string') return replaceTarget(v, target);
  if (Array.isArray(v)) {
    const out = v.map((x, i) => walk(x, [...p, String(i)], target, sets));
    const rule = sets.find(([pattern]) => matches(pattern, p));
    if (!rule) return out;
    const key = (x: Json): string => (rule[1] === '.' || x === null || typeof x !== 'object' || Array.isArray(x) ? canonical(x) : canonical(x[rule[1]] ?? null) + canonical(x));
    return out
      .map((x) => [key(x), x] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([, x]) => x);
  }
  if (v !== null && typeof v === 'object') {
    const out: Record<string, Json> = {};
    for (const [k, x] of Object.entries(v)) {
      if (DROP_KEYS.has(k)) continue;
      out[k] = k in PLACEHOLDER_KEYS && typeof x === 'string' ? PLACEHOLDER_KEYS[k]! : walk(x, [...p, k], target, sets);
    }
    return out;
  }
  return v;
}

/** Normalise one JSON output (json, sarif, cyclonedx, spdx). */
export function normaliseJson(format: Exclude<Format, 'html'>, text: string, target: string): Json {
  const sets = SET_PATHS[format].map(([pattern, key]): [string[], string] => [pattern.split('.'), key]);
  return walk(JSON.parse(text) as Json, ['$'], target, sets);
}

/** Normalise the HTML report: target path and the generation time. One tag per line for readable diffs. */
export function normaliseHtml(text: string, target: string): string {
  return replaceTarget(text, target)
    .replace(/generated \d{4}-\d{2}-\d{2}T[\d:.]+Z/g, 'generated <generatedAt>')
    .replace(/>\s*</g, '>\n<');
}
