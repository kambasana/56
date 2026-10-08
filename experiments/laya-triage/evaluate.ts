/**
 * Applies the pre-registered threshold rule, baseline and pass rule (LAYA-PREREGISTRATION.md) offline
 * to results/states.jsonl and results/laya-scores.csv. Writes results/report.json and report.md.
 *
 *   npx tsx build-states.ts && npx tsx evaluate.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BurstState, TriagePoint } from './build-states.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const RES = join(HERE, 'results');
const H = 3600_000;
const PERIOD: [number, number] = [Date.parse('2025-06-01T00:00:00Z'), Date.parse('2025-12-31T23:59:59Z')];
const MONTHS = (PERIOD[1] - PERIOD[0]) / (30.4375 * 24 * H);
const LIMIT = 0.1;

interface Row extends TriagePoint {
  t: number;
  p: number;
  pKind: number;
  risk: number;
  tokens: number;
  ms: number;
}

const split = JSON.parse(readFileSync(join(RES, 'split.json'), 'utf8')) as { calibration: string[]; test: string[]; proofEpisodes: Record<string, number> };
const points = readFileSync(join(RES, 'states.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as TriagePoint);

function parseCsv(text: string): Record<string, string>[] {
  const [head, ...lines] = text.trim().split('\n');
  const cols = head!.split(',');
  return lines.map((l) => {
    const out: string[] = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < l.length; i++) {
      const c = l[i]!;
      if (inQ) {
        if (c === '"' && l[i + 1] === '"') (cur += '"'), i++;
        else if (c === '"') inQ = false;
        else cur += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') out.push(cur), (cur = '');
      else cur += c;
    }
    out.push(cur);
    return Object.fromEntries(cols.map((c, i) => [c, out[i] ?? '']));
  });
}
const scores = new Map(parseCsv(readFileSync(join(RES, 'laya-scores.csv'), 'utf8')).map((r) => [r.id!, r]));
const missing = points.filter((p) => !scores.has(p.id)).length;
if (missing) throw new Error(`${missing} states have no Laya score; run run-laya.ts first`);
const rows: Row[] = points.map((p) => {
  const s = scores.get(p.id)!;
  return { ...p, t: Date.parse(p.firedAt), p: Number(s.p_takeover), pKind: Number(s.p_kind_takeover), risk: Number(s.risk_score), tokens: Number(s.input_tokens), ms: Number(s.latency_ms) };
});

/** Pre-registered plain-rules baseline. */
export const baseline = (s: BurstState) => s.aggregates.publisher_new_to_package > 0 || s.aggregates.dormant_over_90d * 2 >= s.window.distinct_packages;

/** Episodes from passing alerts: alerts of one account less than 24 h apart merge (proof's rule). */
function episodes(times: number[]): number {
  let n = 0;
  let last = -Infinity;
  for (const t of [...times].sort((a, b) => a - b)) {
    if (t - last >= 24 * H) n++;
    last = t;
  }
  return n;
}

type Pass = (r: Row) => boolean;
function controlRate(accounts: string[], pass: Pass) {
  const per = Object.fromEntries(accounts.map((a) => [a, episodes(rows.filter((r) => r.account === a && r.t >= PERIOD[0] && r.t <= PERIOD[1] && pass(r)).map((r) => r.t))]));
  const total = Object.values(per).reduce((a, b) => a + b, 0);
  return { perAccount: per, episodes: total, accountMonths: Math.round(accounts.length * MONTHS * 100) / 100, rate: Math.round((total / (accounts.length * MONTHS)) * 1000) / 1000 };
}
function incidents(pass: Pass) {
  const accts = [...new Set(rows.filter((r) => r.group === 'incident').map((r) => r.account))];
  return accts.map((a) => {
    const rs = rows.filter((r) => r.account === a);
    const first = rs.filter((r) => r.qualifying && pass(r)).sort((x, y) => x.t - y.t)[0];
    const t0 = Date.parse(rs[0]!.t0!);
    return { account: a, incident: rs[0]!.incident!, qualifyingTriagePoints: rs.filter((r) => r.qualifying).length, warnedAt: first?.firedAt ?? null, leadH: first ? Math.round(((t0 - first.t) / H) * 10) / 10 : null };
  });
}
function qixOutside(pass: Pass) {
  const day = [Date.parse('2025-09-08T00:00:00Z'), Date.parse('2025-09-09T00:00:00Z')] as const;
  return episodes(rows.filter((r) => r.account === 'qix' && pass(r) && !(r.t >= day[0] && r.t < day[1])).map((r) => r.t));
}

function evaluate(name: string, pass: Pass) {
  const cal = controlRate(split.calibration, pass);
  const test = controlRate(split.test, pass);
  const inc = incidents(pass);
  const qix = inc.find((i) => i.account === 'qix')!;
  const shai = inc.filter((i) => i.incident.startsWith('shai-hulud'));
  const shaiWarned = shai.filter((i) => (i.leadH ?? -1) > 0).length;
  const a = test.rate <= LIMIT;
  const b = (qix.leadH ?? -1) > 0;
  const c = shaiWarned * 100 >= 80 * shai.length;
  return {
    name,
    calibration: cal,
    test,
    incidents: inc,
    qixLeadH: qix.leadH,
    shaiWarned,
    shaiTotal: shai.length,
    qixOutside20250908: qixOutside(pass),
    rule: { a_falseAlarmsOk: a, b_qixWarned: b, c_shai80: c, pass: a && b && c },
  };
}

// Threshold: smallest τ among calibration scores (plus 1.0 and +∞) with calibration rate ≤ 0.1.
const calScores = [...new Set(rows.filter((r) => r.group === 'calibration').map((r) => r.p)), 1.0, Infinity].sort((x, y) => x - y);
let tau = Infinity;
for (const c of calScores) if (controlRate(split.calibration, (r) => r.p >= c).rate <= LIMIT) {
  tau = c;
  break;
}

// No-triage sanity check against the account proof's episodes.
const none = evaluate('no triage', () => true);
const sanity = Object.fromEntries([...split.calibration, ...split.test].map((a) => [a, { proof: split.proofEpisodes[a], cadence: (none.calibration.perAccount[a] ?? none.test.perAccount[a])! }]));

const laya = evaluate(`Laya P(takeover) ≥ τ (τ = ${tau})`, (r) => r.p >= tau);
const base = evaluate('plain-rules baseline', (r) => baseline(r.state));

// Descriptive: AUC of the Laya score, controls (all) vs qualifying incident firings.
function auc(pos: number[], neg: number[]) {
  let s = 0;
  for (const p of pos) for (const n of neg) s += p > n ? 1 : p === n ? 0.5 : 0;
  return Math.round((s / (pos.length * neg.length)) * 1000) / 1000;
}
const ctrl = rows.filter((r) => r.group !== 'incident');
const qual = rows.filter((r) => r.qualifying);
const quant = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number) => Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]! * 1000) / 1000;
  return { n: s.length, min: at(0), p25: at(0.25), median: at(0.5), p75: at(0.75), p95: at(0.95), max: at(1) };
};
const descriptive = {
  aucTakeover: auc(qual.map((r) => r.p), ctrl.map((r) => r.p)),
  aucKindTakeover: auc(qual.map((r) => r.pKind), ctrl.map((r) => r.pKind)),
  aucRisk: auc(qual.map((r) => r.risk), ctrl.map((r) => r.risk)),
  pTakeover: { controls: quant(ctrl.map((r) => r.p)), qualifyingIncident: quant(qual.map((r) => r.p)) },
  baselineFlagShare: { controls: Math.round((ctrl.filter((r) => baseline(r.state)).length / ctrl.length) * 1000) / 1000, qualifyingIncident: Math.round((qual.filter((r) => baseline(r.state)).length / qual.length) * 1000) / 1000 },
  triagePoints: { calibration: rows.filter((r) => r.group === 'calibration').length, testControl: rows.filter((r) => r.group === 'test-control').length, incident: rows.filter((r) => r.group === 'incident').length, qualifying: qual.length },
  maxInputTokens: Math.max(...rows.map((r) => r.tokens)),
};

const worth = laya.rule.pass && (!base.rule.pass || (base.test.rate > laya.test.rate && base.shaiWarned <= laya.shaiWarned));
const report = { tau, monthsPerAccount: Math.round(MONTHS * 1000) / 1000, sanity, noTriage: none, laya, baseline: base, descriptive, verdict: { experimentPasses: laya.rule.pass, worthTheDependency: worth } };
writeFileSync(join(RES, 'report.json'), `${JSON.stringify(report, null, 1)}\n`);

const L: string[] = ['# Laya burst triage: results (generated by evaluate.ts)', ''];
L.push(`Threshold chosen on calibration controls only: τ = ${tau}.`, '');
L.push('| Method | Calibration FA / acct-month | Test FA / acct-month (≤ 0.1) | qix lead (h) | Shai-Hulud warned before T0 (≥ 20/25) | qix episodes outside 2025-09-08 | Pass |', '|---|---|---|---|---|---|---|');
for (const m of [none, base, laya]) L.push(`| ${m.name} | ${m.calibration.rate} (${m.calibration.episodes} ep.) | ${m.test.rate} (${m.test.episodes} ep. / ${m.test.accountMonths} acct-months) | ${m.qixLeadH ?? 'no warning'} | ${m.shaiWarned}/${m.shaiTotal} | ${m.qixOutside20250908} | ${m.rule.pass ? 'yes' : 'no'} |`);
L.push('', '## Episodes per control account', '', '| Account | Split | Proof | No triage (cadence) | Baseline | Laya |', '|---|---|---|---|---|---|');
for (const a of [...split.calibration, ...split.test]) {
  const g = split.calibration.includes(a) ? 'calibration' : 'test';
  const pick = (m: typeof laya) => (g === 'calibration' ? m.calibration.perAccount[a] : m.test.perAccount[a]);
  L.push(`| ${a} | ${g} | ${split.proofEpisodes[a]} | ${pick(none)} | ${pick(base)} | ${pick(laya)} |`);
}
L.push('', '## Incident accounts', '', '| Account | Incident | Qualifying triage points | Lead no triage (h) | Lead baseline (h) | Lead Laya (h) |', '|---|---|---|---|---|---|');
for (const i of none.incidents) {
  const b = base.incidents.find((x) => x.account === i.account)!;
  const l = laya.incidents.find((x) => x.account === i.account)!;
  L.push(`| ${i.account} | ${i.incident} | ${i.qualifyingTriagePoints} | ${i.leadH ?? 'no'} | ${b.leadH ?? 'no'} | ${l.leadH ?? 'no'} |`);
}
L.push('', '## Descriptive', '', '```json', JSON.stringify(descriptive, null, 1), '```', '');
L.push(`Verdict: experiment ${laya.rule.pass ? 'PASSES' : 'FAILS'} the pre-registered rule; worth the dependency: ${worth ? 'yes' : 'no'}.`, '');
writeFileSync(join(RES, 'report.md'), L.join('\n'));
console.log(L.join('\n'));
