/**
 * Result records. Every check appends one JSON line to out/results/*.jsonl; global teardown
 * turns them into out/report.md. Status is one of:
 *   pass     every assertion held
 *   fail     at least one assertion failed (reasons say which)
 *   blocked  could not be judged because a data source host is blocked (reasons name it);
 *            never counted as a pass
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { HERE, OUT_DIR, RESULTS_DIR, RESULTS_ROOT, SERVER, type HammerState } from './env';

export type Status = 'pass' | 'fail' | 'blocked';

export interface ResultRecord {
  /** crawl | feature | rbac | scenario | perf */
  area: string;
  page: string;
  role: string;
  theme: string;
  viewport: string;
  status: Status;
  reasons: string[];
  url?: string;
  shot?: string;
  ms?: number;
  /** Extra measured facts (row counts, timings) for the report. */
  facts?: Record<string, string | number | boolean>;
  at?: string;
  /** API server name (run-all.mjs runs the suite once per scenario-runner server). */
  server?: string;
}

export function record(r: ResultRecord): void {
  const file = join(RESULTS_DIR, `${process.pid}.jsonl`);
  mkdirSync(RESULTS_DIR, { recursive: true });
  appendFileSync(file, `${JSON.stringify({ ...r, server: SERVER, at: new Date().toISOString() })}\n`);
}

export function statusOf(reasons: readonly string[], blocked: readonly string[] = []): Status {
  if (reasons.length === 0) return 'pass';
  return blocked.length > 0 ? 'blocked' : 'fail';
}

function readAll(): ResultRecord[] {
  if (!existsSync(RESULTS_ROOT)) return [];
  const out: ResultRecord[] = [];
  for (const dir of readdirSync(RESULTS_ROOT)) {
    const d = join(RESULTS_ROOT, dir);
    for (const f of readdirSync(d)) {
      if (!f.endsWith('.jsonl')) continue;
      for (const line of readFileSync(join(d, f), 'utf8').split('\n')) {
        if (line.trim()) out.push(JSON.parse(line) as ResultRecord);
      }
    }
  }
  return out;
}

function readStates(): HammerState[] {
  if (!existsSync(OUT_DIR)) return [];
  return readdirSync(OUT_DIR)
    .filter((f) => /^state-.*\.json$/.test(f))
    .map((f) => JSON.parse(readFileSync(join(OUT_DIR, f), 'utf8')) as HammerState);
}

const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** A short category for a failure reason, so the summary groups the same defect across pages. */
export function category(reason: string): string {
  const axe = /^axe (\w+) ([\w-]+):/.exec(reason);
  if (axe) return `axe ${axe[1]} ${axe[2]}`;
  const tags = [...reason.matchAll(/<(\w+)(?:#[^\s[>]*)?((?:\[data-slot=[^\]]+\])?)/g)].map((m) => `${m[1]}${m[2]}`);
  if (reason.startsWith('overlapping controls')) return `overlapping controls: ${tags.slice(0, 2).join(' & ')}`;
  if (reason.startsWith('control covered')) return `control covered: ${tags.slice(0, 2).join(' under ')}`;
  if (reason.startsWith('text ')) return `${reason.split('(')[0]!.trim()}: ${tags[0] ?? ''}`;
  if (reason.startsWith('horizontal overflow')) return 'horizontal overflow';
  if (/labels overlap/.test(reason)) return 'graph node labels overlap';
  if (/URL escapes/.test(reason)) return 'graph labels show URL escapes (e.g. %40 for @)';
  if (reason.startsWith('mobile nav sheet stays open')) return 'mobile nav sheet stays open after navigating';
  if (reason.startsWith('no project for scenario')) return 'scenario has no project on the server';
  if (/^HTTP \d+/.test(reason)) return reason.replace(/\?.*$/, '').replace(/\/[A-Za-z0-9_-]{10,}/g, '/:id');
  return reason
    .replace(/"[^"]*"/g, '"…"')
    .replace(/\d+(\.\d+)*/g, 'N')
    .slice(0, 110);
}

export function writeReport(): string {
  const rows = readAll();
  const states = readStates();
  const count = (s: Status) => rows.filter((r) => r.status === s).length;
  const multi = states.length > 1 || new Set(rows.map((r) => r.server)).size > 1;
  const lines: string[] = [];
  lines.push('# Blastradius hammer: Playwright report', '');
  lines.push(`Generated ${new Date().toISOString()}.`, '');
  lines.push(`**${rows.length} checks: ${count('pass')} pass, ${count('fail')} fail, ${count('blocked')} blocked.** Blocked is not a pass: a data source or the data itself was missing.`, '');
  for (const state of states) {
    lines.push(`## Server \`${state.server}\` (${state.baseURL}, as of ${state.asOf ?? 'server default'}, dev mode ${state.devMode}, run ${state.runId})`, '');
    lines.push('Data sources: ' + Object.entries(state.sources).map(([h, ok]) => `${h} ${ok ? 'reachable' : '**blocked**'}`).join(', '), '');
    lines.push(`Users: ${state.users.map((u) => `${u.role} via ${u.via}`).join(', ')}`, '');
    lines.push('| project | scenario | last scan | findings | critical |', '|---|---|---|---|---|');
    for (const p of state.projects) lines.push(`| ${esc(p.name)} | ${p.scenarioId ?? '—'} | ${p.lastScanStatus ?? 'none'} | ${p.findings} | ${p.critical} |`);
    const missing = Object.entries(state.scenarioProjects).filter(([, v]) => v === null);
    if (missing.length) lines.push('', `Scenarios with no project on this server: ${missing.map(([k]) => k).join(', ')}`);
    lines.push('');
  }

  // Grouped failures first: what to fix, and where.
  const groups = new Map<string, { n: number; where: Set<string>; example: string }>();
  for (const r of rows) {
    for (const reason of r.reasons) {
      const k = category(reason);
      const g = groups.get(k) ?? { n: 0, where: new Set<string>(), example: reason };
      g.n++;
      g.where.add(r.page.replace(/^forbidden\./, '').replace(/^[^/]+\//, '*/'));
      groups.set(k, g);
    }
  }
  if (groups.size) {
    lines.push('## Failures by category', '', '| count | category | pages | example |', '|---|---|---|---|');
    for (const [k, g] of [...groups.entries()].sort((a, b) => b[1].n - a[1].n)) {
      const where = [...g.where].slice(0, 8).join(', ') + (g.where.size > 8 ? ` +${g.where.size - 8}` : '');
      lines.push(`| ${g.n} | ${esc(k)} | ${esc(where)} | ${esc(g.example.slice(0, 260))} |`);
    }
    lines.push('');
  }

  const areas = [...new Set(rows.map((r) => r.area))];
  for (const area of areas) {
    const list = rows
      .filter((r) => r.area === area)
      .sort((a, b) => `${a.server}${a.page}${a.role}${a.theme}${a.viewport}`.localeCompare(`${b.server}${b.page}${b.role}${b.theme}${b.viewport}`));
    lines.push(`## ${area} (${list.filter((r) => r.status === 'pass').length}/${list.length} pass)`, '');
    lines.push(`| ${multi ? 'server | ' : ''}page | role | theme | viewport | result | reason | shot |`, `|${multi ? '---|' : ''}---|---|---|---|---|---|---|`);
    for (const r of list) {
      const reason = r.reasons.length ? esc(r.reasons.slice(0, 6).join('; ') + (r.reasons.length > 6 ? `; … +${r.reasons.length - 6} more` : '')) : '';
      const facts = r.facts && Object.keys(r.facts).length ? ` (${esc(Object.entries(r.facts).map(([k, v]) => `${k}=${v}`).join(', '))})` : '';
      const shot = r.shot ? `[png](${relative(OUT_DIR, r.shot)})` : '';
      const res = r.status === 'pass' ? 'pass' : r.status === 'fail' ? '**FAIL**' : '**BLOCKED**';
      lines.push(`| ${multi ? `${r.server} | ` : ''}${esc(r.page)} | ${r.role} | ${r.theme} | ${r.viewport} | ${res} | ${reason}${facts} | ${shot} |`);
    }
    lines.push('');
  }
  const path = join(OUT_DIR, 'report.md');
  writeFileSync(path, lines.join('\n'));
  return path;
}

export { HERE };
