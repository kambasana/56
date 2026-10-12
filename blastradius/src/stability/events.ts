/**
 * Upkeep events between two stored scans (Tier 0, teardown problem 4).
 *
 * Before: every 12-month window comparison was an "event" dated at the window end, so 43–55 of them
 * landed on "today" every week, and a first scan showed hundreds as new. Now an event is a threshold
 * crossing between the previous stored scan and this one, dated to the commit or release that caused
 * it:
 *   - a production package's label got worse (Steady → Watch, Steady or Watch → Fragile); Unknown →
 *     anything is new data, not a crossing; rising stability is never an event;
 *   - a release-continuity (S5a) observation that the previous scan did not have.
 * Shown: caused within the last 90 days, production only, at most 20 per scan, one row per account
 * event (one release seen across a monorepo's packages is one row listing them). A first scan is the
 * baseline and has no events.
 */
import type { StabilityEntry, StabilityLabel, StabilityReport } from '../core/types.js';

export const EVENT_RULES = { days: 90, max: 20 } as const;

export interface StabilityEvent {
  /** Deterministic id. */
  id: string;
  kind: 'label_worsened' | 'release_continuity';
  /** Date of the causing commit or release (YYYY-MM-DD); the scan date only when no fact has one (`dateIsScan`). */
  date: string;
  dateIsScan?: boolean;
  /** Packages (names) this one event covers. */
  packages: string[];
  from?: StabilityLabel;
  to?: StabilityLabel;
  /** Rules that crossed (label_worsened) or the S5a kind. */
  rules: string[];
  release?: string;
  /** One factual sentence. */
  text: string;
  evidence: string[];
}

export interface StabilityEventsResult {
  /** True when there is no earlier scan: this scan is the baseline. */
  baseline: boolean;
  events: StabilityEvent[];
  /** Crossings left out by the 90-day, production or 20-row limits. */
  omitted: { older: number; notProduction: number; overLimit: number };
}

const RANK: Record<StabilityLabel, number> = { unknown: -1, steady: 0, watch: 1, fragile: 2 };

function s5aId(e: StabilityEntry['s5a'][number]): string {
  return `${e.kind}:${e.package}:${e.date}:${e.release ?? ''}`;
}

function datedFacts(e: StabilityEntry, rules: readonly string[]): { date: string; evidence: string[] }[] {
  return e.rules.filter((r) => rules.includes(r.rule)).flatMap((r) => r.facts.filter((f) => f.date).map((f) => ({ date: f.date!, evidence: f.evidence ?? [] })));
}

export function stabilityEvents(prev: StabilityReport | null, cur: StabilityReport, opts: { days?: number; max?: number } = {}): StabilityEventsResult {
  const days = opts.days ?? EVENT_RULES.days;
  const max = opts.max ?? EVENT_RULES.max;
  const omitted = { older: 0, notProduction: 0, overLimit: 0 };
  if (!prev) return { baseline: true, events: [], omitted };
  const cut = new Date(new Date(cur.asOf).getTime() - days * 86_400_000).toISOString().slice(0, 10);
  const before = new Map(prev.packages.map((p) => [p.package, p]));
  const raw: (StabilityEvent & { group: string })[] = [];
  for (const e of cur.packages) {
    const p = before.get(e.package);
    if (!p) continue; // a package new to the project is not a crossing
    const candidates: (StabilityEvent & { group: string })[] = [];
    if (RANK[p.label] >= 0 && RANK[e.label] > RANK[p.label]) {
      const had = new Set(p.rules.map((r) => r.rule));
      const crossed = e.rules.map((r) => r.rule).filter((r) => !had.has(r));
      const dated = datedFacts(e, crossed).sort((a, b) => b.date.localeCompare(a.date));
      const date = dated[0]?.date ?? cur.asOf.slice(0, 10);
      candidates.push({
        id: `label:${e.package}:${p.label}:${e.label}:${date}`,
        kind: 'label_worsened',
        date,
        ...(dated.length ? {} : { dateIsScan: true }),
        packages: [e.name],
        from: p.label,
        to: e.label,
        rules: crossed,
        text: `${e.name}: ${p.label} → ${e.label}. ${e.summary}`,
        evidence: [...new Set(dated.flatMap((d) => d.evidence))],
        group: `label:${e.repo?.current ?? e.package}:${p.label}:${e.label}:${crossed.join(',')}:${date}`,
      });
    }
    const seen = new Set(p.s5a.map(s5aId));
    for (const o of e.s5a) {
      if (seen.has(s5aId(o))) continue;
      candidates.push({
        id: `s5a:${s5aId(o)}`,
        kind: 'release_continuity',
        date: o.date,
        packages: [e.name],
        rules: [o.kind],
        ...(o.release ? { release: o.release } : {}),
        text: o.text,
        evidence: o.evidence ?? [],
        group: `s5a:${o.kind}:${o.evidence?.find((u) => !u.includes('npmjs.com')) ?? e.repo?.current ?? e.package}:${o.date}:${o.release ?? ''}`,
      });
    }
    for (const c of candidates) {
      if (!e.production) omitted.notProduction++;
      else if (c.date < cut) omitted.older++;
      else raw.push(c);
    }
  }
  // One row per account event: the same release seen across several packages of one repository.
  const grouped = new Map<string, StabilityEvent & { group: string }>();
  for (const r of raw) {
    const g = grouped.get(r.group);
    if (!g) grouped.set(r.group, { ...r, packages: [...r.packages] });
    else {
      g.packages.push(...r.packages);
      g.evidence = [...new Set([...g.evidence, ...r.evidence])];
    }
  }
  const all = [...grouped.values()]
    .map(({ group: _g, ...e }) => (e.packages.length > 1 ? { ...e, packages: e.packages.sort(), text: `${e.text} (${e.packages.length} packages from the same repository: ${e.packages.slice(0, 5).join(', ')}${e.packages.length > 5 ? ', …' : ''}.)` } : e))
    .sort((a, b) => b.date.localeCompare(a.date) || (a.kind === b.kind ? 0 : a.kind === 'label_worsened' ? -1 : 1) || a.packages[0]!.localeCompare(b.packages[0]!));
  omitted.overLimit = Math.max(0, all.length - max);
  return { baseline: false, events: all.slice(0, max), omitted };
}

/** The first day inside the window (for the UI copy). */
export function eventsCut(asOf: string, days: number = EVENT_RULES.days): string {
  return new Date(new Date(asOf).getTime() - days * 86_400_000).toISOString().slice(0, 10);
}
