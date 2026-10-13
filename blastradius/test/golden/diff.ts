/**
 * Structural diff of two normalised outputs, as readable path-level entries:
 *   parse-server/json $.findings[purl=pkg:npm/proxy-addr@2.0.7].level: "critical" → "high"
 * Arrays of objects with a unique identity field (IDENTITY_KEYS) are matched by that field, so an
 * inserted element shows as one `+` entry instead of a shifted index on every later element.
 * HTML is diffed line by line (one tag per line after normalisation).
 */
import { canonical, type Json } from './normalise.js';

export interface DiffEntry {
  /** JSON path ($.a.b[0], $.list[purl=…]) or, for HTML, `$.line` with the line number. */
  path: string;
  kind: 'added' | 'removed' | 'changed';
  before?: Json;
  after?: Json;
}

const IDENTITY_KEYS = ['bom-ref', 'SPDXID', 'purl', 'package', 'ruleId', 'source', 'id', 'ref', 'name'];

function identityKey(xs: Json[]): string | undefined {
  if (xs.length === 0 || !xs.every((x) => x !== null && typeof x === 'object' && !Array.isArray(x))) return undefined;
  const objs = xs as Record<string, Json>[];
  return IDENTITY_KEYS.find((k) => {
    const vals = objs.map((o) => o[k]);
    return vals.every((v) => typeof v === 'string' || typeof v === 'number') && new Set(vals).size === vals.length;
  });
}

function seg(k: string): string {
  return /^[A-Za-z_$][\w$-]*$/.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`;
}

export function diffJson(a: Json, b: Json, path = '$', out: DiffEntry[] = []): DiffEntry[] {
  if (canonical(a) === canonical(b)) return out;
  if (Array.isArray(a) && Array.isArray(b)) {
    const key = identityKey(a) !== undefined && identityKey(a) === identityKey(b) ? identityKey(a) : undefined;
    if (key) {
      const ma = new Map((a as Record<string, Json>[]).map((x) => [String(x[key]), x]));
      const mb = new Map((b as Record<string, Json>[]).map((x) => [String(x[key]), x]));
      for (const [k, x] of ma) {
        const p = `${path}[${key}=${k}]`;
        if (!mb.has(k)) out.push({ path: p, kind: 'removed', before: x });
        else diffJson(x, mb.get(k)!, p, out);
      }
      for (const [k, x] of mb) if (!ma.has(k)) out.push({ path: `${path}[${key}=${k}]`, kind: 'added', after: x });
      const order = (m: Map<string, Json>, other: Map<string, Json>) => [...m.keys()].filter((k) => other.has(k));
      if (order(ma, mb).join('\u0000') !== order(mb, ma).join('\u0000')) out.push({ path: `${path}[*order*]`, kind: 'changed', before: order(ma, mb), after: order(mb, ma) });
      return out;
    }
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const p = `${path}[${i}]`;
      if (i >= b.length) out.push({ path: p, kind: 'removed', before: a[i]! });
      else if (i >= a.length) out.push({ path: p, kind: 'added', after: b[i]! });
      else diffJson(a[i]!, b[i]!, p, out);
    }
    return out;
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    for (const k of Object.keys(a)) {
      if (!(k in b)) out.push({ path: path + seg(k), kind: 'removed', before: a[k]! });
      else diffJson(a[k]!, b[k]!, path + seg(k), out);
    }
    for (const k of Object.keys(b)) if (!(k in a)) out.push({ path: path + seg(k), kind: 'added', after: b[k]! });
    return out;
  }
  out.push({ path, kind: 'changed', before: a, after: b });
  return out;
}

/** Line diff (LCS) of two texts; entries are `$.line[<n>]` of the old (removed) or new (added) text. */
export function diffLines(a: string, b: string): DiffEntry[] {
  if (a === b) return [];
  const x = a.split('\n');
  const y = b.split('\n');
  // Trim the common prefix and suffix: the LCS table is then only as large as the changed region.
  let start = 0;
  while (start < x.length && start < y.length && x[start] === y[start]) start++;
  let ex = x.length;
  let ey = y.length;
  while (ex > start && ey > start && x[ex - 1] === y[ey - 1]) {
    ex--;
    ey--;
  }
  const xs = x.slice(start, ex);
  const ys = y.slice(start, ey);
  const out: DiffEntry[] = [];
  if (xs.length * ys.length > 4_000_000) {
    // Too large for a table: report the changed block as a whole.
    xs.forEach((l, i) => out.push({ path: `$.line[${start + i + 1}]`, kind: 'removed', before: l }));
    ys.forEach((l, i) => out.push({ path: `$.line[${start + i + 1}]`, kind: 'added', after: l }));
    return out;
  }
  const w = ys.length + 1;
  const t = new Uint32Array((xs.length + 1) * w);
  for (let i = xs.length - 1; i >= 0; i--) for (let j = ys.length - 1; j >= 0; j--) t[i * w + j] = xs[i] === ys[j] ? t[(i + 1) * w + j + 1]! + 1 : Math.max(t[(i + 1) * w + j]!, t[i * w + j + 1]!);
  let i = 0;
  let j = 0;
  while (i < xs.length || j < ys.length) {
    if (i < xs.length && j < ys.length && xs[i] === ys[j]) {
      i++;
      j++;
    } else if (j < ys.length && (i >= xs.length || t[i * w + j + 1]! >= t[(i + 1) * w + j]!)) {
      out.push({ path: `$.line[${start + j + 1}]`, kind: 'added', after: ys[j]! });
      j++;
    } else {
      out.push({ path: `$.line[${start + i + 1}]`, kind: 'removed', before: xs[i]! });
      i++;
    }
  }
  return out;
}

function short(v: Json | undefined): string {
  const s = JSON.stringify(v);
  return s === undefined ? 'undefined' : s.length > 160 ? `${s.slice(0, 157)}…` : s;
}

export function formatEntry(prefix: string, e: DiffEntry): string {
  if (e.kind === 'added') return `+ ${prefix} ${e.path}: ${short(e.after)}`;
  if (e.kind === 'removed') return `- ${prefix} ${e.path}: ${short(e.before)}`;
  return `~ ${prefix} ${e.path}: ${short(e.before)} → ${short(e.after)}`;
}
