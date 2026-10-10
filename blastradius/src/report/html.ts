/**
 * Single-file HTML report: no scripts, no external assets, a restrictive CSP, and every
 * value HTML-escaped. Summary, top findings, why (reasons), paths, entity chain and evidence.
 */
import type { Finding, OutboundFinding, Reason, RiskLevel, ScanResult } from '../core/types.js';
import { escapeHtml as h, safeHttpUrl } from './escape.js';
import { findingReach, nameAndVersion } from './json.js';

export interface HtmlOptions {
  title?: string;
  /** Number of findings detailed. Default 20 (PLAN §3.7). */
  topN?: number;
  /** Paths shown per asset. Default 3. */
  maxPathsPerAsset?: number;
  /** Assets shown per finding. Default 10. */
  maxAssets?: number;
}

const LEVELS: RiskLevel[] = ['critical', 'high', 'medium', 'low'];

const CSS = `
:root{--bg:#fff;--fg:#1d2330;--muted:#5d6678;--line:#e2e5ec;--card:#f7f8fb;--critical:#b42318;--high:#c4320a;--medium:#a15c07;--low:#3e6b48;--link:#1d4ed8}
@media (prefers-color-scheme:dark){:root{--bg:#14171d;--fg:#e6e8ee;--muted:#9aa3b5;--line:#2b303a;--card:#1b1f27;--critical:#f97066;--high:#fb8c4a;--medium:#fdb022;--low:#75c58a;--link:#8ab4ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px 64px}h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:32px 0 8px}h3{font-size:15px;margin:0}
.muted{color:var(--muted)}.tiles{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}.tile{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 14px;min-width:110px}
.tile strong{display:block;font-size:20px}table{border-collapse:collapse;width:100%;margin:8px 0}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-weight:600;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.03em}td.num{text-align:right;font-variant-numeric:tabular-nums}
.lvl{display:inline-block;border-radius:4px;padding:0 6px;font-size:12px;font-weight:600;color:#fff}.lvl-critical{background:var(--critical)}.lvl-high{background:var(--high)}.lvl-medium{background:var(--medium)}.lvl-low{background:var(--low)}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin:12px 0;overflow-wrap:anywhere}
code{font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}.path{margin:2px 0}a{color:var(--link)}ul{margin:4px 0;padding-left:20px}
.scroll{overflow-x:auto}`;

function levelBadge(level: RiskLevel): string {
  return `<span class="lvl lvl-${h(level)}">${h(level)}</span>`;
}

function evidenceList(urls: readonly string[]): string {
  const items = [...new Set(urls)].sort().slice(0, 20);
  if (items.length === 0) return '<span class="muted">none recorded</span>';
  return `<ul>${items
    .map((u) => {
      const safe = safeHttpUrl(u);
      return safe ? `<li><a href="${h(safe)}" rel="noopener noreferrer nofollow">${h(u)}</a></li>` : `<li><code>${h(u)}</code></li>`;
    })
    .join('')}</ul>`;
}

function reasonsTable(reasons: readonly Reason[]): string {
  if (reasons.length === 0) return '<p class="muted">No contributing factors.</p>';
  return `<div class="scroll"><table><thead><tr><th>Factor</th><th>Value</th><th>Weight</th><th>Contribution</th><th>Detail</th></tr></thead><tbody>${reasons
    .map(
      (r) =>
        `<tr><td><code>${h(r.factor)}</code></td><td class="num">${h(r.value)}</td><td class="num">${h(r.weight)}</td><td class="num">${h(r.contribution)}</td><td>${h(r.detail)}</td></tr>`,
    )
    .join('')}</tbody></table></div>`;
}

function findingCard(f: Finding, idx: number, opts: Required<Omit<HtmlOptions, 'title' | 'topN'>>): string {
  const { name, version } = nameAndVersion(f.purl);
  const reach = findingReach(f);
  const assets = f.blastRadius.assets.slice(0, opts.maxAssets);
  const pathsHtml = assets.length
    ? `<ul>${assets
        .map(
          (a) =>
            `<li><code>${h(a.assetId)}</code> <span class="muted">exposure ${h(a.exposure)}</span>${a.paths
              .slice(0, opts.maxPathsPerAsset)
              .map((p) => `<div class="path"><code>${p.map((n) => h(n)).join(' → ')}</code></div>`)
              .join('')}${a.paths.length > opts.maxPathsPerAsset ? `<div class="muted">… ${h(a.paths.length - opts.maxPathsPerAsset)} more path(s)</div>` : ''}</li>`,
        )
        .join('')}</ul>${f.blastRadius.assets.length > assets.length ? `<p class="muted">… ${h(f.blastRadius.assets.length - assets.length)} more asset(s)</p>` : ''}`
    : '<p class="muted">Not reachable from any inventory asset.</p>';
  const chain = f.entityChain.length
    ? `<p><strong>Entity chain:</strong> <code>${h(f.purl)}</code>${f.entityChain
        .map((c) => ` → <code>${h(c.entityId)}</code> <span class="muted">(${h(c.relation)}, confidence ${h(c.confidence)})</span>`)
        .join('')}</p>`
    : '';
  return `<section class="card" id="f${idx}">
<h3>${h(idx + 1)}. ${h(name)}${version ? `@${h(version)}` : ''} ${levelBadge(f.level)}</h3>
<p class="muted"><code>${h(f.purl)}</code> · risk ${h(f.score)}/100 · blast radius ${h(f.blastRadius.score)} · ${h(reach.assets)} asset(s), ${h(reach.directAssets)} direct, ${h(reach.paths)} path(s) shown</p>
<h4>Why</h4>${reasonsTable(f.reasons)}
${chain}
<h4>Dependency paths</h4>${pathsHtml}
<h4>Evidence</h4>${evidenceList(f.reasons.flatMap((r) => r.evidence))}
</section>`;
}

function outboundSection(outbound: readonly OutboundFinding[]): string {
  if (outbound.length === 0) return '';
  return `<h2>Outbound blast radius (workflows)</h2><div class="scroll"><table><thead><tr><th>Asset</th><th>Score</th><th>Dependents</th><th>Why</th></tr></thead><tbody>${outbound
    .map(
      (o) =>
        `<tr><td><code>${h(o.assetId)}</code></td><td class="num">${h(o.score)}</td><td class="num">${o.dependents !== undefined ? h(o.dependents) : '<span class="muted">unknown</span>'}</td><td><ul>${o.reasons
          .map((r) => `<li>${h(r.detail)}</li>`)
          .join('')}</ul></td></tr>`,
    )
    .join('')}</tbody></table></div>`;
}

export function renderHtml(result: ScanResult, opts: HtmlOptions = {}): string {
  const topN = Math.max(0, opts.topN ?? 20);
  const cardOpts = { maxPathsPerAsset: opts.maxPathsPerAsset ?? 3, maxAssets: opts.maxAssets ?? 10 };
  const title = opts.title ?? `Blastradius report: ${result.target}`;
  const counts: Record<RiskLevel, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of result.findings) counts[f.level] += 1;
  const top = result.findings.slice(0, topN);
  const inv = result.inventory;

  const summaryTable = top.length
    ? `<div class="scroll"><table><thead><tr><th>#</th><th>Component</th><th>Level</th><th>Risk</th><th>Blast radius</th><th>Assets</th><th>Top reason</th></tr></thead><tbody>${top
        .map((f, i) => {
          const r = f.reasons[0];
          return `<tr><td class="num"><a href="#f${i}">${i + 1}</a></td><td><code>${h(f.purl)}</code></td><td>${levelBadge(f.level)}</td><td class="num">${h(f.score)}</td><td class="num">${h(f.blastRadius.score)}</td><td class="num">${h(f.blastRadius.assets.length)}</td><td>${r ? h(r.detail) : ''}</td></tr>`;
        })
        .join('')}</tbody></table></div>`
    : '<p class="muted">No findings.</p>';

  const warnings = result.warnings?.length
    ? `<h2>Warnings</h2><ul>${result.warnings.slice(0, 100).map((w) => `<li>${h(w)}</li>`).join('')}</ul>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer">
<title>${h(title)}</title>
<style>${CSS}</style>
</head>
<body><main>
<h1>${h(title)}</h1>
<p class="muted">Target <code>${h(result.target)}</code> · generated ${h(result.generatedAt)} · schema v${h(result.schemaVersion)}</p>
<div class="tiles">
${LEVELS.map((l) => `<div class="tile">${levelBadge(l)}<strong>${h(counts[l])}</strong></div>`).join('\n')}
<div class="tile"><span class="muted">Components</span><strong>${h(inv.components)}</strong></div>
<div class="tile"><span class="muted">Assets</span><strong>${h(inv.assets)}</strong></div>
<div class="tile"><span class="muted">Direct deps</span><strong>${h(inv.directComponents)}</strong></div>
<div class="tile"><span class="muted">Install scripts</span><strong>${h(inv.withInstallScripts)}</strong></div>
</div>
<p class="muted">Scores combine intrinsic signals and recorded incidents linked through reviewed public evidence. They describe risk signals, not judgements about any person or organisation.</p>
<h2>Top ${h(top.length)} of ${h(result.findings.length)} findings</h2>
${result.health?.length ? `<p class="muted">${h(result.health.length)} more component(s) have upkeep signals only (no provenance, single maintainer, weak posture, unmaintained). They are listed in the JSON report under <code>health</code>, not counted as findings.</p>` : ''}
${summaryTable}
${top.map((f, i) => findingCard(f, i, cardOpts)).join('\n')}
${outboundSection(result.outbound ?? [])}
${warnings}
</main></body>
</html>
`;
}
