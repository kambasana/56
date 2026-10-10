/**
 * Reach in plain words (docs/DATA-ML.md §3): where a finding's component sits in this project,
 * e.g. "Brought in by event-stream · used by payments-api (production)". Built only from the
 * finding's own dependency paths, so it is the same in the CLI, the reports and the web app.
 */
import { parsePurl, type Environment, type Finding } from '../core/types.js';

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
  const paths = exposures.flatMap((a) => a.paths ?? []);
  const direct = paths.some((p) => p.length === 2);
  // Who brings it in: the direct dependency at the start of each transitive path, shortest first.
  const introducers = [...new Set([...paths].filter((p) => p.length > 2).sort((a, b) => a.length - b.length).map((p) => pkgName(p[1]!)))];
  const parts: string[] = [];
  if (direct && introducers.length === 0) parts.push('Direct dependency');
  else if (direct) parts.push(`Direct dependency, also brought in by ${list(introducers)}`);
  else parts.push(`Brought in by ${list(introducers)}`);

  const assets = exposures.map((e) => ({ ...(assetOf(e.assetId) ?? fallbackAsset(e.assetId)), exposure: e.exposure }));
  const names = [...new Set(assets.map((a) => a.name))];
  const prod = assets.filter((a) => a.environment === 'prod').length;
  const devOnly = assets.every((a) => a.exposure < DEV_EXPOSURE);
  const where = names.length === 1 ? names[0]! : `${names.length} parts of this project (${list(names)})`;
  let qualifier = '';
  if (devOnly) qualifier = ' (dev/test dependencies only)';
  else if (prod > 0) qualifier = prod === assets.length ? ' (production)' : ` (${prod} in production)`;
  parts.push(`used by ${where}${qualifier}`);
  return parts.join(' · ');
}
