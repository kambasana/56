/**
 * Asset environment / criticality: path heuristics, overridable by an optional
 * `.blastradius.yml` at the target root:
 *
 * ```yaml
 * assets:
 *   - path: packages/api        # package root dir, or a file such as .github/workflows/release.yml
 *     environment: prod         # prod | staging | dev | ci
 *     criticality: 5            # 1–5
 * ```
 *
 * The longest matching `path` wins. A path matches an asset whose source file
 * or directory equals it or lies beneath it. `*` matches within one path segment.
 */
import { parseDocument } from 'yaml';
import type { Asset, Criticality, Environment } from '../core/types.js';
import { cap, isRecord, own } from './fs.js';

export interface AssetOverride {
  path: string;
  environment?: Environment;
  criticality?: Criticality;
}

export interface BlastradiusConfig {
  assets: AssetOverride[];
}

const ENVIRONMENTS: readonly Environment[] = ['prod', 'staging', 'dev', 'ci'];

/** Parse `.blastradius.yml` text. Invalid entries are dropped with a warning. */
export function parseConfig(text: string): { config: BlastradiusConfig; warnings: string[] } {
  const warnings: string[] = [];
  const doc = parseDocument(text, { prettyErrors: false });
  if (doc.errors.length > 0) return { config: { assets: [] }, warnings: [`.blastradius.yml: invalid YAML: ${cap(doc.errors[0]!.message, 200)}`] };
  let raw: unknown;
  try {
    raw = doc.toJS({ maxAliasCount: 50 });
  } catch (e) {
    // e.g. an alias bomb (ReferenceError from the yaml library): ignore the file, keep scanning.
    return { config: { assets: [] }, warnings: [`.blastradius.yml: could not load: ${cap((e as Error).message ?? String(e), 200)}; ignoring it`] };
  }
  const list = own(raw, 'assets');
  const assets: AssetOverride[] = [];
  if (raw != null && !isRecord(raw)) warnings.push('.blastradius.yml: expected a mapping at the top level');
  if (list !== undefined && !Array.isArray(list)) warnings.push('.blastradius.yml: `assets` must be a list');
  if (Array.isArray(list)) {
    list.slice(0, 10_000).forEach((item, i) => {
      const p = own(item, 'path');
      if (typeof p !== 'string' || p.trim() === '') {
        warnings.push(`.blastradius.yml: assets[${i}] needs a string \`path\``);
        return;
      }
      const o: AssetOverride = { path: normalizeRel(cap(p, 1024)) };
      const env = own(item, 'environment');
      if (env !== undefined) {
        if (typeof env === 'string' && (ENVIRONMENTS as readonly string[]).includes(env)) o.environment = env as Environment;
        else warnings.push(`.blastradius.yml: assets[${i}].environment must be one of ${ENVIRONMENTS.join(', ')}`);
      }
      const crit = own(item, 'criticality');
      if (crit !== undefined) {
        if (typeof crit === 'number' && Number.isInteger(crit) && crit >= 1 && crit <= 5) o.criticality = crit as Criticality;
        else warnings.push(`.blastradius.yml: assets[${i}].criticality must be an integer 1–5`);
      }
      assets.push(o);
    });
  }
  return { config: { assets }, warnings };
}

function normalizeRel(p: string): string {
  const out = p.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
  return out === '.' ? '' : out;
}

const DEV_SEGMENTS = new Set([
  'docs', 'doc', 'documentation', 'website', 'site', 'examples', 'example', 'samples', 'sample', 'demo', 'demos',
  'tools', 'tooling', 'scripts', 'test', 'tests', '__tests__', 'e2e', 'fixtures', '__fixtures__', 'benchmark',
  'benchmarks', 'bench', 'playground', 'sandbox', 'storybook', '.storybook',
]);
const STAGING_SEGMENTS = new Set(['staging', 'stage', 'preprod', 'pre-prod', 'qa', 'uat']);

/** Infer an environment from a path (relative to the scan root) by its directory names. */
export function inferEnvironment(relPath: string, kind: Asset['kind']): Environment {
  if (kind === 'workflow') return 'ci';
  const segs = relPath.toLowerCase().split('/').filter(Boolean);
  if (segs.some((s) => DEV_SEGMENTS.has(s))) return 'dev';
  if (segs.some((s) => STAGING_SEGMENTS.has(s))) return 'staging';
  return 'prod';
}

/**
 * `*` wildcard match within one path segment. Greedy two-pointer matcher, O(|pattern|·|value|)
 * worst case and no regex: both the pattern (.blastradius.yml) and the value (directory names)
 * come from the scanned repo, so a backtracking regex would be a ReDoS vector.
 */
export function segmentMatch(pattern: string, value: string): boolean {
  if (!pattern.includes('*')) return pattern === value;
  let p = 0;
  let v = 0;
  let star = -1;
  let mark = 0;
  while (v < value.length) {
    if (p < pattern.length && pattern[p] !== '*' && pattern[p] === value[v]) {
      p++;
      v++;
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p++;
      mark = v;
    } else if (star !== -1) {
      p = star + 1;
      v = ++mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') p++;
  return p === pattern.length;
}

/** True when `pattern` equals `p` or is a path prefix of it (segment-wise). */
function pathMatches(pattern: string, p: string): boolean {
  if (pattern === '') return true;
  const ps = pattern.split('/');
  const vs = p.split('/');
  if (ps.length > vs.length) return false;
  return ps.every((seg, i) => segmentMatch(seg, vs[i]!));
}

/** Apply config overrides to an asset. `dir` is the asset's package root ('' for root) if any. */
export function applyOverrides(asset: Asset, config: BlastradiusConfig, dir?: string): Asset {
  let best: AssetOverride | undefined;
  let bestLen = -1;
  for (const o of config.assets) {
    const hit = pathMatches(o.path, asset.sourceFile) || (dir !== undefined && pathMatches(o.path, dir));
    if (!hit) continue;
    // More segments win; an exact segment beats a wildcard; later entries win ties.
    const len = o.path === '' ? 0 : o.path.split('/').length * 2 + (o.path.includes('*') ? 0 : 1);
    if (len >= bestLen) {
      best = o;
      bestLen = len;
    }
  }
  if (!best) return asset;
  return {
    ...asset,
    ...(best.environment ? { environment: best.environment } : {}),
    ...(best.criticality ? { criticality: best.criticality } : {}),
  };
}
