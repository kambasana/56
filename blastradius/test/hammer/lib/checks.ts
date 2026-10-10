/**
 * Validators for real engine output: JSON ScanResult, SARIF 2.1.0 shape, HTML safety, and
 * scenario expectations. Each returns a list of problems (empty = ok) so failures are specific.
 */

export type Level = 'critical' | 'high' | 'medium' | 'low';
const LEVEL_RANK: Record<Level, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export interface JReason {
  factor: string;
  detail: string;
  evidence: string[];
}
export interface JFinding {
  purl: string;
  score: number;
  level: Level;
  reasons: JReason[];
  blastRadius: { assets: { assetId: string; exposure: number; paths: string[][] }[]; score: number };
  entityChain?: { entityId: string; relation: string }[];
}
export interface JResult {
  schemaVersion: string;
  target: string;
  generatedAt: string;
  inventory: { assets: number; components: number; edges: number; directComponents?: number; byEcosystem?: Record<string, number> };
  findings: JFinding[];
  outbound?: unknown[];
  warnings?: string[];
}

export function levelForScore(score: number): Level {
  if (score >= 80) return 'critical';
  if (score >= 60) return 'high';
  if (score >= 30) return 'medium';
  return 'low';
}

export function validateJson(r: unknown): string[] {
  const p: string[] = [];
  if (!r || typeof r !== 'object') return ['not an object'];
  const j = r as JResult;
  if (j.schemaVersion !== '1') p.push(`schemaVersion=${String(j.schemaVersion)}`);
  if (typeof j.generatedAt !== 'string' || Number.isNaN(Date.parse(j.generatedAt))) p.push('generatedAt not ISO');
  if (!j.inventory || typeof j.inventory.components !== 'number') p.push('inventory summary missing');
  if (!Array.isArray(j.findings)) return [...p, 'findings not an array'];
  const seen = new Set<string>();
  for (let i = 0; i < j.findings.length; i++) {
    const f = j.findings[i]!;
    if (typeof f.purl !== 'string' || !f.purl.startsWith('pkg:')) p.push(`findings[${i}].purl invalid`);
    if (seen.has(f.purl)) p.push(`duplicate finding ${f.purl}`);
    seen.add(f.purl);
    if (typeof f.score !== 'number' || f.score < 0 || f.score > 100 || Number.isNaN(f.score)) p.push(`${f.purl}: score ${f.score}`);
    else if (levelForScore(f.score) !== f.level) p.push(`${f.purl}: level ${f.level} != levelForScore(${f.score})`);
    if (i > 0 && j.findings[i - 1]!.score < f.score) p.push(`findings not sorted at ${i}`);
    if (!Array.isArray(f.reasons)) p.push(`${f.purl}: reasons missing`);
    else
      for (const r of f.reasons) {
        for (const u of r.evidence ?? []) if (!/^https:\/\//.test(u)) p.push(`${f.purl}: non-https evidence ${u.slice(0, 80)}`);
      }
    if (!f.blastRadius || !Array.isArray(f.blastRadius.assets)) p.push(`${f.purl}: blastRadius missing`);
  }
  return p.slice(0, 20);
}

const SARIF_LEVELS = new Set(['error', 'warning', 'note', 'none']);

export function validateSarif(s: unknown, expectPurls: string[]): string[] {
  const p: string[] = [];
  if (!s || typeof s !== 'object') return ['not an object'];
  const o = s as { $schema?: unknown; version?: unknown; runs?: unknown };
  if (typeof o.$schema !== 'string' || !/sarif/i.test(o.$schema)) p.push('$schema missing or not a SARIF schema');
  if (o.version !== '2.1.0') p.push(`version=${String(o.version)}`);
  if (!Array.isArray(o.runs) || o.runs.length !== 1) return [...p, 'runs must be a 1-element array'];
  const run = o.runs[0] as { tool?: { driver?: { name?: unknown; rules?: { id?: unknown }[] } }; results?: unknown };
  const driver = run.tool?.driver;
  if (!driver || typeof driver.name !== 'string') p.push('tool.driver.name missing');
  const rules = Array.isArray(driver?.rules) ? driver!.rules! : [];
  if (rules.length === 0) p.push('no rules');
  const ruleIds = rules.map((r) => r.id);
  if (!Array.isArray(run.results)) return [...p, 'results not an array'];
  const purlsInResults = new Set<string>();
  for (let i = 0; i < run.results.length; i++) {
    const r = run.results[i] as {
      ruleId?: unknown;
      ruleIndex?: unknown;
      level?: unknown;
      message?: { text?: unknown };
      locations?: { physicalLocation?: { artifactLocation?: { uri?: unknown } } }[];
      properties?: { purl?: unknown };
    };
    if (typeof r.ruleId !== 'string' || !ruleIds.includes(r.ruleId)) p.push(`results[${i}].ruleId ${String(r.ruleId)} not in rules`);
    else if (typeof r.ruleIndex === 'number' && ruleIds[r.ruleIndex] !== r.ruleId) p.push(`results[${i}].ruleIndex mismatch`);
    if (typeof r.level !== 'string' || !SARIF_LEVELS.has(r.level)) p.push(`results[${i}].level ${String(r.level)}`);
    if (typeof r.message?.text !== 'string' || r.message.text.length === 0) p.push(`results[${i}].message.text missing`);
    if (!Array.isArray(r.locations) || r.locations.length === 0) p.push(`results[${i}] has no locations`);
    else
      for (const l of r.locations) {
        const uri = l.physicalLocation?.artifactLocation?.uri;
        if (typeof uri !== 'string' || uri.startsWith('/') || /^[a-z]+:/i.test(uri) || uri.includes('..')) p.push(`results[${i}] bad uri ${String(uri)}`);
      }
    if (typeof r.properties?.purl === 'string') purlsInResults.add(r.properties.purl);
    if (p.length > 20) break;
  }
  for (const purl of expectPurls) if (!purlsInResults.has(purl)) p.push(`expected purl ${purl} not in SARIF results`);
  return p.slice(0, 20);
}

/** Static HTML safety: the report must not carry script, event handlers or javascript: URLs. */
export function validateHtml(html: string, expectPurls: string[], expectText: RegExp[] = []): string[] {
  const p: string[] = [];
  if (!/^<!doctype html>/i.test(html.trimStart())) p.push('missing <!doctype html>');
  if (!/<\/html>\s*$/i.test(html)) p.push('document not terminated with </html> (truncated?)');
  if (!/Content-Security-Policy[^>]*default-src 'none'/i.test(html)) p.push("no CSP meta with default-src 'none'");
  const scripts = html.match(/<script\b/gi);
  if (scripts) p.push(`${scripts.length} <script> tag(s)`);
  const handler = /<[a-z][^>]*\son[a-z]+\s*=/i.exec(html);
  if (handler) p.push(`inline event handler: ${handler[0].slice(0, 100)}`);
  const js = /(?:href|src|action)\s*=\s*["']?\s*(?:javascript|vbscript|data:text\/html)/i.exec(html);
  if (js) p.push(`dangerous URL: ${js[0].slice(0, 100)}`);
  if (/<(iframe|object|embed|form|base)\b/i.test(html)) p.push('active element (iframe/object/embed/form/base) present');
  for (const purl of expectPurls) if (!html.includes(escapeHtml(purl)) && !html.includes(purl)) p.push(`expected purl ${purl} not shown`);
  for (const re of expectText) if (!re.test(html)) p.push(`expected text ${re} not shown`);
  return p;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export interface Expectation {
  purl: string;
  level: string; // critical | >=high | present | none
  note?: string;
}

export interface ExpectVerdict {
  ok: boolean;
  detail: string;
  observedLevel: Level | null;
  score: number | null;
}

export function checkExpectation(r: JResult, e: Expectation): ExpectVerdict {
  const f = r.findings.find((x) => x.purl === e.purl);
  const observed = f ? f.level : null;
  const score = f ? f.score : null;
  const top = f?.reasons[0];
  const describe = f
    ? `${f.purl} ${f.level} ${f.score} top=${top ? `${top.factor}: ${top.detail.slice(0, 140)}` : 'none'}; evidence=${(top?.evidence ?? []).length}; assets=${f.blastRadius.assets.map((a) => a.assetId).slice(0, 4).join(',')}`
    : `${e.purl} not among ${r.findings.length} findings`;
  if (e.level === 'none') return { ok: !f || f.level === 'low', detail: f ? `unexpectedly detected (${describe}); flip the expectation if support landed` : describe, observedLevel: observed, score };
  if (e.level === 'present') return { ok: !!f, detail: describe, observedLevel: observed, score };
  const min: Level = e.level === '>=high' ? 'high' : (e.level as Level);
  if (!f) return { ok: false, detail: describe, observedLevel: null, score: null };
  const levelOk = LEVEL_RANK[f.level] >= LEVEL_RANK[min];
  const evidence = f.reasons.flatMap((x) => x.evidence ?? []);
  const evOk = evidence.length > 0 && evidence.every((u) => /^https:\/\/\S+$/.test(u));
  const problems: string[] = [];
  if (!levelOk) problems.push(`level ${f.level} < ${min}`);
  if (!evOk) problems.push('no https evidence URLs');
  return { ok: levelOk && evOk, detail: problems.length ? `${problems.join('; ')} — ${describe}` : describe, observedLevel: observed, score };
}

export function checkAbsent(r: JResult, rule: string): { ok: boolean; detail: string } {
  const [kind, value] = rule.split(':') as [string, string];
  let hits: JFinding[] = [];
  if (kind === 'level') hits = r.findings.filter((f) => f.level === value);
  else if (kind === 'reason') hits = r.findings.filter((f) => f.reasons.some((x) => x.factor === value));
  else return { ok: false, detail: `unknown rule ${rule}` };
  return {
    ok: hits.length === 0,
    detail: hits.length === 0 ? `none of ${r.findings.length} findings match ${rule}` : `${hits.length} match ${rule}: ${hits.slice(0, 5).map((f) => `${f.purl} ${f.level} ${f.score} (${f.reasons[0]?.factor}: ${f.reasons[0]?.detail.slice(0, 100)})`).join(' | ')}`,
  };
}

export function countsOf(r: JResult): Record<Level, number> {
  const c: Record<Level, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of r.findings) c[f.level]++;
  return c;
}

/** Compare two ScanResults of the same target: same purls, levels, scores (±tol) and inventory. */
export function diffResults(a: JResult, b: JResult, tol = 1): string[] {
  const p: string[] = [];
  for (const k of ['assets', 'components', 'edges'] as const) if (a.inventory[k] !== b.inventory[k]) p.push(`inventory.${k} ${a.inventory[k]} vs ${b.inventory[k]}`);
  const ma = new Map(a.findings.map((f) => [f.purl, f]));
  const mb = new Map(b.findings.map((f) => [f.purl, f]));
  const onlyA = [...ma.keys()].filter((k) => !mb.has(k));
  const onlyB = [...mb.keys()].filter((k) => !ma.has(k));
  if (onlyA.length) p.push(`${onlyA.length} purl(s) only in CLI: ${onlyA.slice(0, 5).join(', ')}`);
  if (onlyB.length) p.push(`${onlyB.length} purl(s) only in API: ${onlyB.slice(0, 5).join(', ')}`);
  const lvl: string[] = [];
  const sc: string[] = [];
  for (const [k, fa] of ma) {
    const fb = mb.get(k);
    if (!fb) continue;
    if (fa.level !== fb.level) lvl.push(`${k} ${fa.level}/${fb.level}`);
    else if (Math.abs(fa.score - fb.score) > tol) sc.push(`${k} ${fa.score}/${fb.score}`);
  }
  if (lvl.length) p.push(`${lvl.length} level mismatch(es): ${lvl.slice(0, 5).join(', ')}`);
  if (sc.length) p.push(`${sc.length} score mismatch(es) > ${tol}: ${sc.slice(0, 5).join(', ')}`);
  return p;
}

/** Warnings by enricher prefix, e.g. "osv: ..." → osv. */
export function warningsBySource(warnings: readonly string[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const w of warnings) {
    const k = /^([a-z]+):/.exec(w)?.[1] ?? 'other';
    m.set(k, [...(m.get(k) ?? []), w]);
  }
  return m;
}

/** Reason factors that differ between two results, over the purls whose level or score differ (or exist in one only). */
export function differingFactors(a: JResult, b: JResult, tol = 1): Set<string> {
  const ma = new Map(a.findings.map((f) => [f.purl, f]));
  const mb = new Map(b.findings.map((f) => [f.purl, f]));
  const out = new Set<string>();
  for (const purl of new Set([...ma.keys(), ...mb.keys()])) {
    const fa = ma.get(purl);
    const fb = mb.get(purl);
    if (fa && fb && fa.level === fb.level && Math.abs(fa.score - fb.score) <= tol) continue;
    const fsa = new Set((fa?.reasons ?? []).map((r) => r.factor));
    const fsb = new Set((fb?.reasons ?? []).map((r) => r.factor));
    for (const f of fsa) if (!fsb.has(f)) out.add(f);
    for (const f of fsb) if (!fsa.has(f)) out.add(f);
    if (!fa || !fb) out.add('(finding missing)');
  }
  return out;
}

/** Map an enricher failure warning to the source that caused it, when identifiable. */
export function failureSource(w: string): string | null {
  // The GitHub enricher's Open Collective lookups go to api.opencollective.com (no URL in the warning).
  if (/open collective/i.test(w)) return 'api.opencollective.com';
  if (/rate limit/i.test(w) && /github/i.test(w)) return 'github-rate';
  const m = /https:\/\/([a-z0-9.-]+)\//i.exec(w);
  return m ? m[1]!.toLowerCase() : null;
}
