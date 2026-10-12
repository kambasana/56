/**
 * Reach in plain words (docs/DATA-ML.md §3): where a finding's component sits in this project,
 * e.g. "Brought in by event-stream · used by payments-api (production)". Built only from the
 * finding's own dependency paths, so it is the same in the CLI, the reports and the web app.
 */
import { parsePurl, type Environment, type Finding } from '../core/types.js';
import { isProductionScope, scopeStrength, strongerScope, type ComponentScope } from '../core/scope.js';

export interface ReachAsset {
  name: string;
  environment: Environment;
}

/** Below this the paths only come through dev or optional dependencies (SCOPE_EXPOSURE). */
const DEV_EXPOSURE = 0.5;

function pkgName(purl: string): string {
  try {
    const p = parsePurl(purl);
    return p.namespace ? `${p.namespace}/${p.name}` : p.name;
  } catch {
    return purl;
  }
}

function fallbackAsset(id: string): ReachAsset {
  const i = id.indexOf(':');
  return { name: i > 0 ? id.slice(i + 1) : id, environment: id.startsWith('workflow:') ? 'ci' : 'dev' };
}

function list(names: string[], max = 2): string {
  const shown = names.slice(0, max).join(', ');
  return names.length > max ? `${shown} and ${names.length - max} more` : shown;
}

export function describeReach(f: Pick<Finding, 'blastRadius'>, assetOf: (id: string) => ReachAsset | undefined = () => undefined): string {
  const exposures = f.blastRadius?.assets ?? [];
  if (exposures.length === 0) return 'In the lockfile, but no dependency path from this project reaches it';
  // Paths with their scope (Tier 0: AssetExposure.pathScopes); strongest first, so the runtime
  // introducer is named before a dev tool that also pulls the package in.
  const scoped = exposures.flatMap((a) => (a.paths ?? []).map((p, i) => ({ p, scope: a.pathScopes?.[i] })));
  const hasScopes = scoped.some((x) => x.scope !== undefined);
  const ordered = [...scoped].sort(
    (a, b) => (hasScopes ? (b.scope ? scopeStrength(b.scope) : 0) - (a.scope ? scopeStrength(a.scope) : 0) : 0) || a.p.length - b.p.length,
  );
  const direct = scoped.some((x) => x.p.length === 2);
  const introducers = [...new Set(ordered.filter((x) => x.p.length > 2).map((x) => pkgName(x.p[1]!)))];
  const parts: string[] = [];
  if (direct && introducers.length === 0) parts.push('Direct dependency');
  else if (direct) parts.push(`Direct dependency, also brought in by ${list(introducers)}`);
  else parts.push(`Brought in by ${list(introducers)}`);

  const assets = exposures.map((e) => ({ ...(assetOf(e.assetId) ?? fallbackAsset(e.assetId)), exposure: e.exposure, scope: e.scope }));
  const names = [...new Set(assets.map((a) => a.name))];
  const where = names.length === 1 ? names[0]! : `${names.length} parts of this project (${list(names)})`;
  let qualifier = '';
  if (assets.every((a) => a.scope !== undefined)) {
    // One scope per (project, package): production only when a runtime path from a production asset reaches it.
    const prod = assets.filter((a) => isProductionScope(a.scope) && a.environment === 'prod').length;
    const best = assets.reduce<ComponentScope>((m, a) => strongerScope(m, a.scope!), 'unreachable');
    if (prod > 0) qualifier = prod === assets.length ? ' (production)' : ` (${prod} in production)`;
    else qualifier = ` (${SCOPE_ONLY[best]})`;
  } else {
    const prod = assets.filter((a) => a.environment === 'prod').length;
    const devOnly = assets.every((a) => a.exposure < DEV_EXPOSURE);
    if (devOnly) qualifier = ' (dev/test dependencies only)';
    else if (prod > 0) qualifier = prod === assets.length ? ' (production)' : ` (${prod} in production)`;
  }
  parts.push(`used by ${where}${qualifier}`);
  return parts.join(' · ');
}

const SCOPE_ONLY: Record<ComponentScope, string> = {
  runtime: 'runtime, not a production project',
  peer: 'peer dependency only',
  optional: 'optional dependency only',
  ci: 'CI / build only',
  dev: 'dev/test dependencies only',
  unreachable: 'not reached',
};
