/**
 * Source coverage in words (Tier 0): which data sources answered. Shared by the CLI summary, the
 * HTML report, SARIF and the web, so a failed source is never read as a clean result.
 */
import type { ScanResult, SourceCoverage } from '../core/types.js';

/** Sources that did not fully answer. */
export function degradedSources(result: Pick<ScanResult, 'coverage'>): SourceCoverage[] {
  return (result.coverage?.sources ?? []).filter((s) => s.status !== 'ok');
}

/** Security sources (OSV, the knowledge pack) that failed or answered only in part. */
export function securitySourcesDegraded(result: Pick<ScanResult, 'coverage'>): SourceCoverage[] {
  return degradedSources(result).filter((s) => s.security);
}

/** "osv ok · depsdev partial · github failed" */
export function coverageLine(sources: readonly SourceCoverage[]): string {
  return sources.map((s) => `${s.source} ${s.status}`).join(' · ');
}

/** Loud line for degraded sources: "SOURCES INCOMPLETE: osv failed (…); github partial (…)". */
export function degradedLine(sources: readonly SourceCoverage[]): string {
  if (sources.length === 0) return '';
  const security = sources.some((s) => s.security);
  return `${security ? 'SECURITY SOURCE INCOMPLETE' : 'SOURCES INCOMPLETE'}: ${sources.map((s) => `${s.source} ${s.status}${s.reason ? ` (${s.reason.slice(0, 160)})` : ''}`).join('; ')}`;
}
