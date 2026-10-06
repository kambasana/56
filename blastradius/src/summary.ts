/** Short plain-text terminal summary of a ScanResult. Values are untrusted: strip control chars. */
import { levelForScore, type Finding, type RiskLevel, type ScanResult } from './core/types.js';

export const LEVELS: readonly RiskLevel[] = ['critical', 'high', 'medium', 'low'];
const RANK: Record<RiskLevel, number> = { critical: 3, high: 2, medium: 1, low: 0 };

export function countByLevel(result: ScanResult): Record<RiskLevel, number> {
  const out: Record<RiskLevel, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of result.findings) out[f.level]++;
  return out;
}

/**
 * True when some finding, or some outbound (publishing workflow) finding, is at or above
 * `threshold`. Outbound scores use the same 0–100 level bands as SARIF.
 */
export function failsThreshold(result: ScanResult, threshold: RiskLevel): boolean {
  if (result.findings.some((f) => RANK[f.level] >= RANK[threshold])) return true;
  return (result.outbound ?? []).some((o) => Number.isFinite(o.score) && RANK[levelForScore(Math.min(100, o.score))] >= RANK[threshold]);
}

function clean(s: string, max = 160): string {
  // eslint-disable-next-line no-control-regex
  const t = s.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, ' ');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function topReason(f: Finding): string {
  const r = f.reasons[0];
  return r ? `${r.factor}: ${clean(r.detail)}` : '(no reason recorded)';
}

export function formatSummary(result: ScanResult, opts: { top?: number; files?: readonly string[] } = {}): string {
  const top = opts.top ?? 5;
  const c = countByLevel(result);
  const inv = result.inventory;
  const lines: string[] = [];
  lines.push(`blastradius: ${clean(result.target)}`);
  lines.push(`  inventory: ${inv.assets} asset(s), ${inv.components} component(s), ${inv.edges} edge(s)`);
  lines.push(`  findings:  critical ${c.critical} | high ${c.high} | medium ${c.medium} | low ${c.low}`);
  if (result.findings.length > 0) {
    lines.push(`  top ${Math.min(top, result.findings.length)}:`);
    for (const f of result.findings.slice(0, top)) {
      const assets = f.blastRadius.assets.length;
      lines.push(
        `    [${f.level.toUpperCase()}] ${f.score.toFixed(1).padStart(5)}  ${clean(f.purl, 100)}  (reaches ${assets} asset${assets === 1 ? '' : 's'}, blast ${f.blastRadius.score})`,
      );
      lines.push(`           ${topReason(f)}`);
    }
  }
  if (result.outbound && result.outbound.length > 0) {
    const worst = result.outbound[0]!;
    lines.push(`  outbound: ${result.outbound.length} workflow(s); highest ${clean(worst.assetId, 100)} score ${worst.score}`);
  }
  const w = result.warnings?.length ?? 0;
  if (w > 0) lines.push(`  warnings: ${w} (see report)`);
  for (const f of opts.files ?? []) lines.push(`  wrote ${f}`);
  return lines.join('\n') + '\n';
}
