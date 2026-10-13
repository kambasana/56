/**
 * Account-level proof (PREREGISTRATION.md in this folder): replays recorded real data offline.
 *   H1 compromise response: once one package of an account is known bad, name every exposure via
 *      every package that account could publish then; compare with the per-package advisories.
 *   H2 burst early warning: ≥ N distinct packages published by one account within W.
 *   H3 concentration of publishing accounts per project (descriptive).
 *   npx tsx test/replay/account/proof-account.ts → test/replay/out/account-proof.md and .json
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from '../../../src/pipeline.js';
import { AccountIndex, accountExposure, burstWarnings, type PackageTimeline, type PublishEvent } from '../../../src/watch/account.js';
import type { StoredInventory } from '../../../src/watch/match.js';
import { orgInventories } from '../org.js';
import { decodeTimelines, type EncodedTimelines } from './timelines.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, 'data');
const H = 3600_000;
const load = <T>(f: string): T => JSON.parse(readFileSync(join(DATA, f), 'utf8')) as T;

interface Adv { id: string; published: string; name: string; versions: string[]; allVersions: boolean; group: string[] }
interface Account { role: string; reason: string; packages: string[]; total: number; sampled: boolean }
interface Project { id: string; role: 'acme' | 'exposure-2025' | 'control'; inventory: StoredInventory }

const round1 = (x: number) => Math.round(x * 10) / 10;
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const iso = (t: number) => new Date(t).toISOString().replace('.000Z', 'Z');

async function projects(): Promise<Project[]> {
  const out: Project[] = (await orgInventories()).map((s) => ({ id: s.projectId, role: 'acme', inventory: s }));
  const manifest = load<{ items: { kind: string; repo?: string; role?: string }[] }>('manifest.json');
  for (const d of readdirSync(join(DATA, 'org')).sort()) {
    const repo = d.replace('__', '/');
    const role = manifest.items.find((i) => i.kind === 'repo' && i.repo === repo)?.role as Project['role'];
    const res = await scan({ target: join(DATA, 'org', d), formats: [], offline: true, cacheDir: false, enrichers: () => [] });
    out.push({ id: repo, role, inventory: { projectId: repo, projectName: repo, inventory: res.inventory } });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// H1

export interface H1Account {
  account: string;
  incident: string;
  t0: string;
  firstAdvisory: string;
  /** Bad packages of this account (advisory-named, attributed to it). */
  badPackages: { name: string; versions: string[]; firstAdvisory: string; hoursAfterT0: number; publishableAtT0: boolean }[];
  /** Packages the account could publish at T0 (in the recorded candidate universe). */
  publishableAtT0: number;
  advisoriesAtT0: number;
  /** Bad packages named at T0 by the account query vs by advisories existing at T0. */
  badNamedByAccount: number;
  badNamedByAdvisories: number;
  /** Median hours gained per bad package (no org). */
  medianGainPerPackageH: number | null;
  org: {
    named: number;
    namedBad: number;
    namedByAdvisoriesAtT0: number;
    medianGainPerExposureH: number | null;
    precision: number | null;
    versionHits: { project: string; component: string; namedAtT0: boolean; advisoryAtT0: boolean }[];
    exposures: { project: string; package: string; version: string; bad: boolean; gainH: number | null; production: boolean }[];
  };
}

function h1(index: AccountIndex, advs: Adv[], invs: StoredInventory[], account: string, incident: string, bad: Map<string, Set<string>>, groups: string[]): H1Account {
  const named = (n: string) => advs.filter((a) => a.name === n && a.group.some((g) => groups.includes(g)));
  const firstAdv = (n: string) => Math.min(...named(n).map((a) => Date.parse(a.published)));
  const t0 = Math.min(...[...bad.keys()].map(firstAdv));
  const publishable = new Set(index.packagesOf(account, t0));
  const badPackages = [...bad.entries()]
    .map(([name, versions]) => ({ name, versions: [...versions].sort(), firstAdvisory: iso(firstAdv(name)), hoursAfterT0: round1((firstAdv(name) - t0) / H), publishableAtT0: publishable.has(name) }))
    .sort((a, b) => a.hoursAfterT0 - b.hoursAfterT0 || a.name.localeCompare(b.name));
  const advisedAtT0 = new Set(badPackages.filter((b) => b.hoursAfterT0 <= 0).map((b) => b.name));
  const advisoriesAtT0 = new Set(advs.filter((a) => bad.has(a.name) && a.group.some((g) => groups.includes(g)) && Date.parse(a.published) <= t0).map((a) => a.id)).size;
  const { hits } = accountExposure(invs, index, account, t0);
  const exposures = hits.map((h) => {
    const isBad = bad.has(h.name);
    return { project: h.projectName, package: h.name, version: h.version, bad: isBad, gainH: isBad ? round1(Math.max(0, firstAdv(h.name) - t0) / H) : null, production: h.production };
  });
  // Version-level hits: locked version is a bad version (named or not by the account query).
  const versionHits: H1Account['org']['versionHits'] = [];
  for (const s of invs)
    for (const c of s.inventory.components)
      if (bad.get(c.name)?.has(c.version))
        versionHits.push({ project: s.projectName, component: `${c.name}@${c.version}`, namedAtT0: publishable.has(c.name), advisoryAtT0: named(c.name).some((a) => Date.parse(a.published) <= t0 && a.versions.includes(c.version)) });
  const exBad = exposures.filter((e) => e.bad);
  return {
    account,
    incident,
    t0: iso(t0),
    firstAdvisory: iso(t0),
    badPackages,
    publishableAtT0: publishable.size,
    advisoriesAtT0,
    badNamedByAccount: badPackages.filter((b) => b.publishableAtT0 || b.hoursAfterT0 <= 0).length,
    badNamedByAdvisories: advisedAtT0.size,
    medianGainPerPackageH: median(badPackages.map((b) => Math.max(0, b.hoursAfterT0))),
    org: {
      named: exposures.length,
      namedBad: exBad.length,
      namedByAdvisoriesAtT0: exposures.filter((e) => advisedAtT0.has(e.package)).length,
      medianGainPerExposureH: median(exBad.map((e) => e.gainH!)),
      precision: exposures.length ? round1((exBad.length / exposures.length) * 1000) / 1000 : null,
      versionHits: [...new Map(versionHits.map((v) => [`${v.project} ${v.component}`, v])).values()],
      exposures,
    },
  };
}

// ------------------------------------------------------------------------------------------------
// H2

const PERIOD: [number, number] = [Date.parse('2025-06-01T00:00:00Z'), Date.parse('2025-12-31T23:59:59Z')];
const MONTHS = (PERIOD[1] - PERIOD[0]) / (30.4375 * 24 * H);

export interface H2Rule { n: number; windowH: number }
export interface H2Result {
  rule: H2Rule;
  incidents: { account: string; incident: string; badPackages: number; attributedBadPublishes: number; t0: string; firedAt: string | null; leadH: number | null }[];
  controls: { account: string; reason: string; bot: boolean; sampled: boolean; packages: number; events: number; episodes: number; examples: string[] }[];
  qixOutsideIncident: number;
  falseAlarmsPerAccountMonth: number;
  falseAlarmsPerAccountMonthExTypes: number;
  /** Not pre-registered (descriptive): excluding every bot-labelled control. */
  falseAlarmsPerAccountMonthExBots: number;
  controlsWithAlarm: number;
}

function h2(rule: H2Rule, events: PublishEvent[], accounts: Record<string, Account>, h1s: H1Account[]): H2Result {
  const eps = burstWarnings(events, { n: rule.n, windowMs: rule.windowH * H });
  // Incident warnings: every firing on its own (no episode merging), and only a firing whose window
  // contains at least one of the account's bad packages counts (a routine burst days earlier is not
  // a warning about this incident).
  const firings = burstWarnings(events, { n: rule.n, windowMs: rule.windowH * H, episodeGapMs: 0 });
  const incidents = h1s
    .filter((a) => a.badPackages.length >= 5 || a.account === 'qix' || a.account === 'right9ctrl')
    .map((a) => {
      const t0 = Date.parse(a.t0);
      const badVersions = new Set(a.badPackages.flatMap((b) => b.versions.map((v) => `${b.name}@${v}`)));
      const mine = events.filter((e) => e.account === a.account);
      // The firing's window must contain the publish of a bad version (not just another release of the same package).
      const fired = firings.find((f) => f.account === a.account && mine.some((e) => e.at > f.firedAt - rule.windowH * H && e.at <= f.firedAt && badVersions.has(`${e.name}@${e.version}`)));
      const attributed = mine.filter((e) => badVersions.has(`${e.name}@${e.version}`)).length;
      return { account: a.account, incident: a.incident, badPackages: a.badPackages.length, attributedBadPublishes: attributed, t0: a.t0, firedAt: fired ? iso(fired.firedAt) : null, leadH: fired ? round1((t0 - fired.firedAt) / H) : null };
    });
  const controls = Object.entries(accounts)
    .filter(([, a]) => a.role === 'control')
    .map(([u, a]) => {
      const mine = eps.filter((e) => e.account === u && e.firedAt >= PERIOD[0] && e.firedAt <= PERIOD[1]);
      return {
        account: u,
        reason: a.reason,
        bot: /bot|^types$|github.actions|automation/i.test(u),
        sampled: a.sampled,
        packages: a.packages.length,
        events: events.filter((e) => e.account === u && e.at >= PERIOD[0] && e.at <= PERIOD[1]).length,
        episodes: mine.length,
        examples: mine.slice(0, 2).map((e) => `${iso(e.firedAt).slice(0, 16)} ${e.packages.length} pkgs (${e.packages.slice(0, 3).join(', ')}…)`),
      };
    })
    .sort((a, b) => a.account.localeCompare(b.account));
  const qixDay = [Date.parse('2025-09-08T00:00:00Z'), Date.parse('2025-09-09T00:00:00Z')];
  const qixOutside = eps.filter((e) => e.account === 'qix' && e.firedAt >= PERIOD[0] && e.firedAt <= PERIOD[1] && !(e.firedAt >= qixDay[0]! && e.firedAt < qixDay[1]!)).length;
  const rate = (cs: typeof controls) => (cs.length ? Math.round((cs.reduce((s, c) => s + c.episodes, 0) / (cs.length * MONTHS)) * 1000) / 1000 : 0);
  return {
    rule,
    incidents,
    controls,
    qixOutsideIncident: qixOutside,
    falseAlarmsPerAccountMonth: rate(controls),
    falseAlarmsPerAccountMonthExTypes: rate(controls.filter((c) => c.account !== 'types')),
    falseAlarmsPerAccountMonthExBots: rate(controls.filter((c) => !c.bot)),
    controlsWithAlarm: controls.filter((c) => c.episodes > 0).length,
  };
}

// ------------------------------------------------------------------------------------------------
// H3

export interface H3Row { project: string; role: string; components: number; known: number; publishers: number; topPublisher: string; topPublisherShare: number; topMaintainer: string; topMaintainerShare: number }

function h3(ps: Project[], locked: Record<string, { u?: string; m?: string[] }>): H3Row[] {
  return ps.map((p) => {
    const comps = [...new Map(p.inventory.inventory.components.filter((c) => c.ecosystem === 'npm').map((c) => [`${c.name}@${c.version}`, c])).keys()];
    const metas = comps.map((k) => locked[k]).filter((m): m is { u?: string; m?: string[] } => !!m && (!!m.u || !!m.m));
    const pub = new Map<string, number>();
    const mnt = new Map<string, number>();
    for (const m of metas) {
      if (m.u) pub.set(m.u, (pub.get(m.u) ?? 0) + 1);
      for (const a of new Set(m.m ?? [])) mnt.set(a, (mnt.get(a) ?? 0) + 1);
    }
    const top = (x: Map<string, number>) => [...x].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? ['-', 0];
    const [tp, tpn] = top(pub);
    const [tm, tmn] = top(mnt);
    const share = (n: number) => (metas.length ? Math.round((n / metas.length) * 1000) / 1000 : 0);
    return { project: p.id, role: p.role, components: comps.length, known: metas.length, publishers: pub.size, topPublisher: tp, topPublisherShare: share(tpn), topMaintainer: tm, topMaintainerShare: share(tmn) };
  });
}

// ------------------------------------------------------------------------------------------------

export interface AccountProof {
  data: { timelines: number; advisories: number; accounts: number; unattributedEventsInPeriod: number; shaiUnattributed: { wave: string; versions: number; unattributed: number }[] };
  h1: H1Account[];
  h1Shai: { wave: string; accounts: number; multiPackageAccounts: number; badPackages: number; namedEarly: number; medianGainH: number | null; publishable: number; precision: number | null; orgExposures: number }[];
  h2: H2Result[];
  h3: H3Row[];
  verdicts: { hypothesis: string; scope: string; pass: boolean; detail: string }[];
}

/** The pass/fail rules exactly as pre-registered. */
export function verdicts(p: Omit<AccountProof, 'verdicts'>): AccountProof['verdicts'] {
  const out: AccountProof['verdicts'] = [];
  for (const a of p.h1.filter((x) => x.incident === 'chalk-debug-2025' || x.incident === 'event-stream-2018')) {
    const pass = a.badNamedByAccount > a.badNamedByAdvisories && (a.medianGainPerPackageH ?? 0) > 0;
    out.push({ hypothesis: 'H1', scope: a.incident, pass, detail: `${a.badNamedByAccount} vs ${a.badNamedByAdvisories} bad packages named at T0; median gain ${a.medianGainPerPackageH} h; org exposures ${a.org.named} vs ${a.org.namedByAdvisoriesAtT0}` });
  }
  for (const s of p.h1Shai) {
    const pass = s.namedEarly > 0 && (s.medianGainH ?? 0) > 0;
    out.push({ hypothesis: 'H1', scope: s.wave, pass, detail: `${s.namedEarly} bad packages named before their own advisory (accounts with ≥2 bad packages); median gain ${s.medianGainH} h; precision ${s.precision}` });
  }
  for (const r of p.h2.filter((x) => x.rule.n === 5 && (x.rule.windowH === 6 || x.rule.windowH === 24))) {
    const qix = r.incidents.find((i) => i.account === 'qix');
    const w1 = r.incidents.filter((i) => i.incident === 'shai-hulud-1' && i.badPackages >= 5);
    const a = (qix?.leadH ?? -1) > 0;
    const b = w1.filter((i) => (i.leadH ?? -1) > 0).length * 2 >= w1.length && w1.length > 0;
    const c = r.falseAlarmsPerAccountMonth <= 0.1;
    out.push({ hypothesis: r.rule.windowH === 6 ? 'H2' : 'H2-24h', scope: `N≥${r.rule.n}, W=${r.rule.windowH}h`, pass: a && b && c, detail: `(a) qix lead ${qix?.leadH ?? 'none'} h: ${a ? 'yes' : 'no'}; (b) wave-1 accounts warned before T0 ${w1.filter((i) => (i.leadH ?? -1) > 0).length}/${w1.length}: ${b ? 'yes' : 'no'}; (c) false alarms ${r.falseAlarmsPerAccountMonth}/account-month ≤ 0.1: ${c ? 'yes' : 'no'}` });
  }
  return out;
}

export async function runAccountProof(): Promise<AccountProof> {
  const timelines: PackageTimeline[] = decodeTimelines(load<EncodedTimelines>('timelines.json'));
  const advs = load<Adv[]>('advisories.json');
  const accounts = load<Record<string, Account>>('accounts.json');
  const locked = load<Record<string, { u?: string; m?: string[] }>>('locked.json');
  const index = new AccountIndex(timelines);
  const ps = await projects();
  const exposureInvs = ps.filter((p) => p.role !== 'control').map((p) => p.inventory);

  // chalk/debug: bad set per the pre-registered rule.
  const qixAt = Date.parse('2025-09-08T12:00:00Z');
  const chalkBad = new Map<string, Set<string>>();
  for (const a of advs.filter((x) => x.group.includes('chalk-week')))
    for (const v of a.versions) {
      const t = index.timeline(a.name)?.versions.find((e) => e.v === v)?.t;
      if (t?.startsWith('2025-09-08') && index.maintainersAt(a.name, qixAt)?.includes('qix')) (chalkBad.get(a.name) ?? chalkBad.set(a.name, new Set()).get(a.name)!).add(v);
    }
  const results: H1Account[] = [h1(index, advs, exposureInvs, 'qix', 'chalk-debug-2025', chalkBad, ['chalk-week'])];
  // event-stream: right9ctrl's bad releases.
  const esBad = new Map<string, Set<string>>();
  for (const a of advs.filter((x) => x.group.includes('event-stream'))) for (const v of a.versions) (esBad.get(a.name) ?? esBad.set(a.name, new Set()).get(a.name)!).add(v);
  results.push(h1(index, advs, exposureInvs, 'right9ctrl', 'event-stream-2018', esBad, ['event-stream']));

  // Shai-Hulud: bad versions attributed per account.
  const shaiUnattributed: AccountProof['data']['shaiUnattributed'] = [];
  const h1Shai: AccountProof['h1Shai'] = [];
  for (const wave of ['shai-hulud-1', 'shai-hulud-2']) {
    const per = new Map<string, Map<string, Set<string>>>();
    let versions = 0;
    let unattributed = 0;
    for (const a of advs.filter((x) => x.group.includes(wave)))
      for (const v of a.versions) {
        versions++;
        const p = index.publisherOf(a.name, v);
        if (!p) {
          unattributed++;
          continue;
        }
        const m = per.get(p.account) ?? per.set(p.account, new Map()).get(p.account)!;
        (m.get(a.name) ?? m.set(a.name, new Set()).get(a.name)!).add(v);
      }
    shaiUnattributed.push({ wave, versions, unattributed });
    const rs = [...per.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([acct, bad]) => h1(index, advs, exposureInvs, acct, wave, bad, [wave]));
    results.push(...rs);
    const multi = rs.filter((r) => r.badPackages.length >= 2);
    const gains = multi.flatMap((r) => r.badPackages.map((b) => Math.max(0, b.hoursAfterT0)));
    const namedEarly = multi.reduce((s, r) => s + r.badPackages.filter((b) => b.publishableAtT0 && b.hoursAfterT0 > 0).length, 0);
    const publishable = multi.reduce((s, r) => s + r.publishableAtT0, 0);
    const badPub = multi.reduce((s, r) => s + r.badPackages.filter((b) => b.publishableAtT0).length, 0);
    h1Shai.push({
      wave,
      accounts: rs.length,
      multiPackageAccounts: multi.length,
      badPackages: rs.reduce((s, r) => s + r.badPackages.length, 0),
      namedEarly,
      medianGainH: median(gains),
      publishable,
      precision: publishable ? Math.round((badPub / publishable) * 1000) / 1000 : null,
      orgExposures: rs.reduce((s, r) => s + r.org.named, 0),
    });
  }

  // H2: one event stream over every recorded timeline, the control period plus the 2018 window.
  const ev2025 = index.publishEvents(PERIOD[0], PERIOD[1]);
  const ev2018 = index.publishEvents(Date.parse('2018-06-01T00:00:00Z'), Date.parse('2019-01-31T23:59:59Z'));
  const events = [...ev2018.events, ...ev2025.events];
  const rules: H2Rule[] = [
    { n: 5, windowH: 6 },
    { n: 5, windowH: 24 },
    { n: 3, windowH: 1 },
    { n: 3, windowH: 6 },
    { n: 5, windowH: 1 },
    { n: 10, windowH: 1 },
    { n: 10, windowH: 6 },
  ];
  const proof = {
    data: { timelines: timelines.length, advisories: advs.length, accounts: Object.keys(accounts).length, unattributedEventsInPeriod: ev2025.unattributed, shaiUnattributed },
    h1: results,
    h1Shai,
    h2: rules.map((r) => h2(r, events, accounts, results)),
    h3: h3(ps, locked),
  };
  return { ...proof, verdicts: verdicts(proof) };
}

// ------------------------------------------------------------------------------------------------

export function accountProofMarkdown(p: AccountProof): string {
  const L: string[] = ['# Account-level proof (recorded real events, replayed offline)', ''];
  L.push('Pre-registered in `test/replay/account/PREREGISTRATION.md` before any number below was computed.', '');
  L.push(`Data: ${p.data.timelines} package timelines, ${p.data.advisories} OSV advisory entries, ${p.data.accounts} accounts (see data/manifest.json).`, '');
  L.push('## Verdicts (pre-registered rules)', '', '| Hypothesis | Scope | Result | Detail |', '|---|---|---|---|');
  for (const v of p.verdicts) L.push(`| ${v.hypothesis} | ${v.scope} | ${v.pass ? 'pass' : '**fail**'} | ${v.detail} |`);
  L.push('', '## H1 compromise response', '');
  for (const a of p.h1.filter((x) => x.incident === 'chalk-debug-2025' || x.incident === 'event-stream-2018')) {
    L.push(`### ${a.incident} (account ${a.account})`, '');
    L.push(`- T0 (first advisory naming one of its bad packages): ${a.t0}; advisories existing at T0: ${a.advisoriesAtT0}.`);
    L.push(`- Packages ${a.account} could publish at T0 (recorded candidates): **${a.publishableAtT0}**; bad packages: ${a.badPackages.length}, of which publishable at T0 per recorded maintainers: ${a.badPackages.filter((b) => b.publishableAtT0).length}.`);
    L.push(`- Bad packages named at T0: account query **${a.badNamedByAccount}** vs advisories **${a.badNamedByAdvisories}**; median hours gained per bad package: **${a.medianGainPerPackageH ?? 'n/a'}**.`);
    L.push(`- Org exposures named at T0: **${a.org.named}** (bad packages: ${a.org.namedBad}; would be named by advisories existing at T0: ${a.org.namedByAdvisoriesAtT0}); median hours gained per bad exposure: **${a.org.medianGainPerExposureH ?? 'n/a'}**; precision (bad / named): ${a.org.precision ?? 'n/a'}.`);
    L.push(`- Version-level hits (locked version is a bad version): ${a.org.versionHits.length}; named at T0 by the account query: ${a.org.versionHits.filter((v) => v.namedAtT0).length}; covered by an advisory at T0: ${a.org.versionHits.filter((v) => v.advisoryAtT0).length}.`);
    L.push('', '| Bad package | Versions | First advisory | h after T0 | Publishable at T0 |', '|---|---|---|---|---|');
    for (const b of a.badPackages) L.push(`| ${b.name} | ${b.versions.join(', ')} | ${b.firstAdvisory} | ${b.hoursAfterT0} | ${b.publishableAtT0 ? 'yes' : 'no'} |`);
    L.push('');
  }
  L.push('### Shai-Hulud', '', '| Wave | Accounts | With ≥2 bad pkgs | Bad pkgs | Named before their own advisory | Median gain (h) | Publishable at T0 | Precision | Org exposures |', '|---|---|---|---|---|---|---|---|---|');
  for (const s of p.h1Shai) L.push(`| ${s.wave} | ${s.accounts} | ${s.multiPackageAccounts} | ${s.badPackages} | ${s.namedEarly} | ${s.medianGainH ?? 'n/a'} | ${s.publishable} | ${s.precision ?? 'n/a'} | ${s.orgExposures} |`);
  for (const u of p.data.shaiUnattributed) L.push(`- ${u.wave}: ${u.unattributed}/${u.versions} bad versions had no recoverable publisher (deleted, previous version had several maintainers) and are excluded.`);
  L.push('', '## H2 burst early warning', '');
  L.push('An incident warning counts only when the firing window contains one of the account\'s bad packages; lead = T0 − firing time.', '');
  L.push('| Rule | qix lead (h) | Wave-1 accounts (≥5 bad pkgs) warned before T0 | Wave-2 accounts warned before T0 | False alarms / control account-month | ex. `types` | ex. all bots (not pre-registered) | Controls with ≥1 alarm | qix alarms outside 2025-09-08 |', '|---|---|---|---|---|---|---|---|---|');
  for (const r of p.h2) {
    const qix = r.incidents.find((i) => i.account === 'qix');
    const warned = (w: string) => {
      const xs = r.incidents.filter((i) => i.incident === w && i.badPackages >= 5);
      return `${xs.filter((i) => (i.leadH ?? -1) > 0).length}/${xs.length}`;
    };
    L.push(`| N≥${r.rule.n}, W=${r.rule.windowH}h | ${qix?.leadH ?? 'no warning'} | ${warned('shai-hulud-1')} | ${warned('shai-hulud-2')} | ${r.falseAlarmsPerAccountMonth} | ${r.falseAlarmsPerAccountMonthExTypes} | ${r.falseAlarmsPerAccountMonthExBots} | ${r.controlsWithAlarm}/${r.controls.length} | ${r.qixOutsideIncident} |`);
  }
  const prim = p.h2[0]!;
  L.push('', `Controls under the primary rule (N≥${prim.rule.n}, W=${prim.rule.windowH}h, 2025-06-01..2025-12-31):`, '', '| Account | Why | Packages recorded | Publishes in period | Episodes | Example |', '|---|---|---|---|---|---|');
  for (const c of prim.controls) L.push(`| ${c.account}${c.bot ? ' (bot)' : ''} | ${c.reason}${c.sampled ? ', sampled' : ''} | ${c.packages} | ${c.events} | ${c.episodes} | ${c.examples[0] ?? ''} |`);
  L.push('', 'Incident accounts under the primary rule:', '', '| Account | Incident | Bad pkgs | Bad publishes with a recoverable publisher | T0 | Fired | Lead (h) |', '|---|---|---|---|---|---|---|');
  for (const i of prim.incidents) L.push(`| ${i.account} | ${i.incident} | ${i.badPackages} | ${i.attributedBadPublishes} | ${i.t0} | ${i.firedAt ?? 'no'} | ${i.leadH ?? ''} |`);
  L.push('', '## H3 concentration (descriptive)', '', '| Project | Set | npm components | with publisher data | Publishing accounts | Top publisher (share) | Top "can publish" account (share) |', '|---|---|---|---|---|---|---|');
  for (const r of p.h3) L.push(`| ${r.project} | ${r.role} | ${r.components} | ${r.known} | ${r.publishers} | ${r.topPublisher} (${r.topPublisherShare}) | ${r.topMaintainer} (${r.topMaintainerShare}) |`);
  L.push('');
  return `${L.join('\n')}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const p = await runAccountProof();
  const out = join(HERE, '..', 'out');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'account-proof.json'), `${JSON.stringify(p, null, 1)}\n`);
  writeFileSync(join(out, 'account-proof.md'), accountProofMarkdown(p));
  console.log(accountProofMarkdown(p));
}
