/**
 * S3 maintenance status, S5a observations and the stability label of one package
 * (docs/WHO-BEHIND-PLAN.md §4), from repo-level inputs only (signals.ts).
 *
 * Label rules (any one fires; Fragile is checked first):
 *   Fragile  CAF = 1 and S3 inactive · CAF = 1 and F3 funding stopped (P4: not assessed) ·
 *            S3 ended (high confidence: archived, or the latest npm release deprecated) in production
 *   Watch    CAF = 1 · S3 quiet · S3 inactive with CAF > 1 · S3 ended outside production or declared
 *            only · S5a release continuity · L2 licence category change · C2 signed share fell ·
 *            C1 contributor base changed together with another signal ·
 *            F2 concentrated with F3 declining (P4: not assessed)
 *   Steady   none of the above, with S2 (CAF) and S3 known from the git history
 *   Unknown  none of the above and no git history (says what is missing)
 * A label from low-confidence facts only is capped at Watch (the declared-README rule is low and
 * never reaches Fragile). C1 alone is context: it fired on healthy express in P2.
 * Wording is factual and names no person.
 */
import type { ContinuityEvent, MaintenanceState, StabilityConfidence, StabilityEntry, StabilityLabel, StabilityReason, StabilityRuleHit } from '../core/types.js';
import { addMonths } from '../history/aggregate.js';
import { LABEL_RULES, STABILITY_RULES, type LabelRuleId } from './rules.js';
import type { RepoEvent, StabilityInputs } from './signals.js';

const R = STABILITY_RULES;
const day = (iso: string) => iso.slice(0, 10);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** Registry text shown in a label: e-mail addresses removed (data minimisation, plan §5). */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;
const clean = (s: string, max = 160) => {
  const t = s.replace(EMAIL_RE, '<e-mail address removed>');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const npmPage = (name: string, version?: string) => `https://www.npmjs.com/package/${name}${version ? `/v/${encodeURIComponent(version)}` : ''}`;

export interface S3Result {
  state: MaintenanceState;
  confidence: StabilityConfidence;
  /** High-confidence end: archived or the latest release deprecated. */
  endedHigh: boolean;
  /** Declared (README) end or maintenance mode with a second fact. */
  endedDeclared: boolean;
  quietDeclared: boolean;
  inactive: boolean;
  quiet: boolean;
  lastCommit?: string;
  lastRelease?: string;
  facts: StabilityReason[];
  /** Facts shown for context (e.g. a declared status without a second fact). */
  context: StabilityReason[];
}

function before(asOf: Date, months: number): string {
  return addMonths(asOf, -months).toISOString().slice(0, 10);
}

/**
 * Whether the Scorecard run can describe the scan time: runs dated more than a month after it (a
 * replay of an earlier date with today's Scorecard) are not used, so a later archival is not read
 * back into the past.
 */
export function scorecardAsOf(x: StabilityInputs, asOf: Date): boolean {
  const d = x.maintained?.value.date;
  return d === undefined || Date.parse(d) <= asOf.getTime() + 31 * 86_400_000;
}

/** S3: maintenance status. */
export function maintenanceState(x: StabilityInputs, name: string, asOf: Date, cadenceIrregular: boolean): S3Result {
  const facts: StabilityReason[] = [];
  const context: StabilityReason[] = [];
  let endedHigh = false;
  // GitHub's archived flag has no date: a repository pushed to after the scan time (a replay of an
  // earlier date) may have been archived later, so it is not read back into the past.
  const archivedAsOf = x.archived?.value.archived === true && (x.archived.value.lastPushAt === undefined || Date.parse(x.archived.value.lastPushAt) <= asOf.getTime());
  if (archivedAsOf && x.archived) {
    endedHigh = true;
    facts.push({ signal: 'S3', text: 'The repository is archived on GitHub.', source: x.archived.source, confidence: 'high', ...(x.archived.evidence ? { evidence: x.archived.evidence } : {}) });
  } else if (x.maintained && scorecardAsOf(x, asOf) && x.maintained.value.reason === 'project is archived') {
    endedHigh = true;
    const m = x.maintained.value;
    facts.push({ signal: 'S3', text: `OpenSSF Scorecard's Maintained check reports "project is archived" for ${m.repo}${m.date ? ` (run of ${day(m.date)})` : ''}.`, source: 'scorecard', confidence: 'high', ...(x.maintained.evidence ? { evidence: x.maintained.evidence } : {}), ...(m.date ? { date: day(m.date) } : {}) });
  }
  const npm = x.npm?.value;
  if (npm?.latestDeprecated) {
    endedHigh = true;
    facts.push({
      signal: 'S3',
      text: `npm marks the latest release${npm.latestVersion ? ` (${npm.latestVersion})` : ''} deprecated: "${clean(npm.latestDeprecated)}".`,
      source: 'npm',
      confidence: 'high',
      evidence: [npmPage(name, npm.latestVersion)],
      ...(npm.latestPublishedAt ? { date: day(npm.latestPublishedAt) } : {}),
    });
  }
  for (const u of npm?.inUse ?? []) {
    if (u.deprecated && u.version !== npm?.latestVersion) context.push({ signal: 'S3', text: `The version in use (${u.version}) is deprecated on npm: "${clean(u.deprecated)}". Later releases are not.`, source: 'npm', confidence: 'high', evidence: [npmPage(name, u.version)] });
  }

  const lastRelease = x.cadence?.value.lastRelease?.date ?? (npm?.latestPublishedAt ? day(npm.latestPublishedAt) : undefined);
  const h = x.history?.value;
  const cutInactive = before(asOf, R.inactiveMonths);
  const cutQuiet = before(asOf, R.quietCommitMonths);
  const noRelease18 = lastRelease !== undefined ? lastRelease < cutInactive : undefined;
  let inactive = false;
  let quiet = false;
  if (h) {
    const noCommit18 = h.lastCommit < cutInactive;
    const noCommit6 = h.lastCommit < cutQuiet;
    inactive = noCommit18 && noRelease18 === true;
    quiet = !inactive && noCommit6;
    const lastBits = `last commit ${h.lastCommit}${lastRelease ? `, last release ${lastRelease}` : ''}`;
    if (inactive) facts.push({ signal: 'S3', text: `No commit and no release in ${R.inactiveMonths} months (${lastBits}).`, source: 'git+npm', confidence: 'medium', evidence: [h.repo, npmPage(name)], date: h.lastCommit > (lastRelease ?? '') ? h.lastCommit : lastRelease! });
    else if (quiet) facts.push({ signal: 'S3', text: `No commit in ${R.quietCommitMonths} months (${lastBits}).`, source: 'git', confidence: 'medium', evidence: [h.repo], date: h.lastCommit });
    else context.push({ signal: 'S3', text: `Commits within ${R.quietCommitMonths} months (${lastBits}).`, source: 'git', confidence: 'medium', evidence: [h.repo], date: h.lastCommit });
  }

  // Declared status (low confidence): only counts together with a second fact.
  let endedDeclared = false;
  let quietDeclared = false;
  const d = x.declared?.value;
  if (d) {
    const second: string[] = [];
    if (noRelease18) second.push(`no release in ${R.inactiveMonths} months`);
    if (h && h.lastCommit < cutQuiet) second.push(`no commit in ${R.quietCommitMonths} months`);
    if (cadenceIrregular && x.cadence) second.push(`irregular releases (latest gap ${Math.round(x.cadence.value.latestGapDays)} days, median ${Math.round(x.cadence.value.medianDays)})`);
    const what = d.status === 'maintenance_mode' ? 'maintenance mode' : d.status === 'unmaintained' ? 'that it is no longer maintained' : 'deprecation';
    const reason: StabilityReason = { signal: 'S3', text: `The README declares ${what}: "${clean(d.phrase, 200)}"${second.length ? `; and ${second.join(', ')}` : ''}.`, source: 'npm.readme', confidence: 'low', evidence: [npmPage(name)] };
    if (second.length && !endedHigh) {
      if (d.status === 'maintenance_mode') quietDeclared = true;
      else endedDeclared = true;
      facts.push(reason);
    } else context.push(reason);
  }

  let state: MaintenanceState;
  let confidence: StabilityConfidence;
  if (endedHigh) [state, confidence] = ['ended', 'high'];
  else if (endedDeclared) [state, confidence] = ['ended', 'low'];
  else if (h && inactive) [state, confidence] = ['inactive', 'medium'];
  else if (h && quiet) [state, confidence] = ['quiet', 'medium'];
  else if (quietDeclared) [state, confidence] = ['quiet', 'low'];
  else if (h) [state, confidence] = ['active', 'medium'];
  else [state, confidence] = ['unknown', 'low'];
  const out: S3Result = { state, confidence, endedHigh, endedDeclared, quietDeclared, inactive, quiet, facts, context };
  if (h) out.lastCommit = h.lastCommit;
  if (lastRelease) out.lastRelease = lastRelease;
  return out;
}

/** S2 used by the rules: the 24-month CAF, or the CAF of the 24 months up to the last commit. */
export function cafFor(x: StabilityInputs): { value: number; commits: number; from: string; to: string; lastActive: boolean } | undefined {
  const c = x.caf24?.value;
  if (c && c.commits >= R.cafMinCommits) return { ...c, lastActive: false };
  const l = x.history?.value.cafAtLastCommit;
  if (l && l.commits >= R.cafMinCommits) return { value: l.absenceFactor, commits: l.commits, from: l.from, to: l.to, lastActive: true };
  return undefined;
}

const S5A_KINDS = new Set<RepoEvent['kind']>(['release_by_new_person', 'npm_release_by_new_account', 'release_takeover']);

export function isRecent(date: string, asOf: Date, months = R.recentMonths): boolean {
  // Strictly after the cut: a 12-month window comparison dated exactly 12 months ago is the previous window.
  return date > before(asOf, months) && date <= asOf.toISOString().slice(0, 10);
}

/** S5a observations (all dates), as Changes-page events. */
export function continuityEvents(x: StabilityInputs, name: string): ContinuityEvent[] {
  const h = x.history;
  if (!h) return [];
  return h.value.events
    .filter((e) => S5A_KINDS.has(e.kind))
    .map((e) => {
      const ev: ContinuityEvent = {
        package: x.package,
        name,
        kind: e.kind as ContinuityEvent['kind'],
        date: e.date,
        text: e.text,
        source: e.kind === 'npm_release_by_new_account' ? 'npm+git' : 'git',
        confidence: 'medium',
        evidence: e.kind === 'npm_release_by_new_account' && e.release ? [npmPage(name, e.release), h.value.repo] : [h.value.repo],
      };
      if (e.release !== undefined) ev.release = e.release;
      if (e.daysSinceFirstSeen !== undefined) ev.daysSinceFirstSeen = e.daysSinceFirstSeen;
      return ev;
    })
    .sort((a, b) => b.date.localeCompare(a.date) || a.kind.localeCompare(b.kind));
}

function hit(rule: LabelRuleId, facts: StabilityReason[]): StabilityRuleHit {
  return { rule, name: LABEL_RULES[rule], facts };
}

/** Short factual sentence per rule (the label summary joins the first two). */
function shortText(h: StabilityRuleHit, s3: S3Result, caf?: { value: number }): string {
  switch (h.rule as LabelRuleId) {
    case 'fragile_single_contributor_inactive':
      return `Single active contributor and no commit or release in ${R.inactiveMonths} months`;
    case 'fragile_ended_production':
      return `${endedWords(s3)}, used in production`;
    case 'watch_ended':
      return s3.endedHigh ? `${endedWords(s3)}, not a production dependency here` : 'README declares the project ended, with a second fact';
    case 'watch_single_contributor':
      return `Single active contributor (CAF ${caf?.value ?? 1})`;
    case 'watch_quiet':
      return s3.quiet ? `No commit in ${R.quietCommitMonths} months` : 'README declares maintenance mode, with a second fact';
    case 'watch_inactive':
      return `No commit and no release in ${R.inactiveMonths} months`;
    case 'watch_release_continuity':
      return 'Recent release by an account new to the repository';
    case 'watch_license_category_change':
      return 'Licence category changed';
    case 'watch_signed_share_fell':
      return 'Share of signed commits fell';
    case 'watch_contributor_base_changed_with_other':
      return 'Contributor base changed, with another signal';
    default:
      return h.name;
  }
}

function endedWords(s3: S3Result): string {
  const t = s3.facts.map((f) => f.text).join(' ');
  if (/deprecated/.test(t) && /archived/.test(t)) return 'Deprecated on npm and repository archived';
  if (/deprecated/.test(t)) return 'Deprecated on npm';
  return 'Repository archived';
}

export function labelPackage(x: StabilityInputs, info: { name: string; versions: string[]; production: boolean }, asOf: Date): StabilityEntry {
  const name = info.name;
  const context: StabilityReason[] = [];
  const missing: string[] = [];
  const cadence = x.cadence?.value;
  const s3 = maintenanceState(x, name, asOf, cadence?.irregular === true);
  context.push(...s3.context);
  const caf = cafFor(x);
  const h = x.history?.value;
  const repoUrl = h?.repo ?? x.repo?.value.url;

  // S1 (context only): registry maintainers, the count.
  if (x.maintainerCount) context.push({ signal: 'S1', text: `npm lists ${plural(x.maintainerCount.value, 'maintainer')} with publish rights.`, source: 'npm', confidence: 'high', evidence: [npmPage(name)] });

  // S2.
  let cafFact: StabilityReason | undefined;
  if (caf) {
    const window = caf.lastActive ? `the 24 months up to the last commit (${caf.from} to ${caf.to})` : `the 24 months to ${caf.to}`;
    cafFact = {
      signal: 'S2',
      // Contributors are counted by identity (e-mail address or GitHub login, P2): one person with
      // two addresses counts twice, so a CAF above 1 can overstate the number of people, never 1.
      text:
        caf.value === 1
          ? `One contributor identity made at least half of the ${plural(caf.commits, 'commit')} in ${window} (CAF 1).`
          : `CAF ${caf.value}: ${caf.value} contributor identities (e-mail addresses or GitHub logins; one person may use several) together made half of the ${plural(caf.commits, 'commit')} in ${window}.`,
      source: 'git',
      confidence: 'medium',
      ...(repoUrl ? { evidence: [repoUrl] } : {}),
      date: caf.to,
    };
  } else if (h) missing.push(`Fewer than ${R.cafMinCommits} commits in the last active 24 months: no CAF.`);

  // S4 (context; a second fact for a declared status).
  if (cadence) {
    context.push({
      signal: 'S4',
      text: `${cadence.irregular ? 'Irregular releases' : 'Releases'}: median ${Math.round(cadence.medianDays)} days between the last ${cadence.releases} releases, CV ${cadence.cv}, latest gap ${Math.round(cadence.latestGapDays)} days.`,
      source: 'npm',
      confidence: 'high',
      evidence: [npmPage(name)],
    });
  }

  // Scorecard Maintained (context, unless it says archived: then it is an S3 fact above).
  if (x.maintained && scorecardAsOf(x, asOf) && x.maintained.value.reason !== 'project is archived') {
    const m = x.maintained.value;
    context.push({ signal: 'S3', text: `OpenSSF Scorecard Maintained ${m.score}/10${m.reason ? `: ${m.reason}` : ''}${m.date ? ` (run of ${day(m.date)})` : ''}.`, source: 'scorecard', confidence: 'high', ...(x.maintained.evidence ? { evidence: x.maintained.evidence } : {}) });
  }

  // Repo-level observations (S5a, C1, C2) within the recent window.
  const events = h?.events ?? [];
  const recent = events.filter((e) => isRecent(e.date, asOf));
  const evFact = (e: RepoEvent, signal: string, confidence: StabilityConfidence = 'medium'): StabilityReason => ({
    signal,
    text: e.text,
    source: e.kind === 'npm_release_by_new_account' ? 'npm+git' : 'git',
    confidence,
    ...(repoUrl ? { evidence: [repoUrl] } : {}),
    date: e.date,
  });
  const s5a = recent.filter((e) => S5A_KINDS.has(e.kind));
  const signedFell = recent.filter((e) => e.kind === 'signed_share_changed' && e.after !== undefined && e.before !== undefined && e.after < e.before);
  const c1 = recent.filter((e) => e.kind === 'contributor_base_changed');
  const topNew = recent.filter((e) => e.kind === 'top_committer_new');
  for (const e of recent) if (e.kind === 'release_handover' || (e.kind === 'signed_share_changed' && !signedFell.includes(e))) context.push(evFact(e, e.kind === 'release_handover' ? 'S5a' : 'C2'));
  for (const e of topNew) context.push(evFact(e, 'C1'));

  // L2: licence category changes dated within the recent window.
  const l2 = x.licenseChanges.filter((c) => c.value.fromCategory !== c.value.toCategory && c.value.fromCategory !== 'unknown' && c.value.toCategory !== 'unknown' && c.value.date !== undefined && isRecent(day(c.value.date), asOf));

  // Rules.
  const rules: StabilityRuleHit[] = [];
  const cafIs1 = caf?.value === 1;
  if (cafIs1 && s3.inactive) rules.push(hit('fragile_single_contributor_inactive', [cafFact!, ...s3.facts.filter((f) => /No commit and no release/.test(f.text))]));
  if (s3.endedHigh && info.production) rules.push(hit('fragile_ended_production', [...s3.facts.filter((f) => f.confidence === 'high'), { signal: 'S3', text: 'Reached through a runtime (non-dev) dependency path in this scan.', source: 'inventory', confidence: 'high' }]));
  const fragile = rules.length > 0;
  if (!fragile) {
    if (cafIs1) rules.push(hit('watch_single_contributor', [cafFact!]));
    if (s3.quiet || s3.quietDeclared) rules.push(hit('watch_quiet', s3.facts.filter((f) => /No commit in|maintenance mode/.test(f.text))));
    if (s3.inactive && !cafIs1) rules.push(hit('watch_inactive', [...s3.facts.filter((f) => /No commit and no release/.test(f.text)), ...(cafFact ? [cafFact] : [])]));
    if (s3.endedHigh || s3.endedDeclared) rules.push(hit('watch_ended', s3.facts.filter((f) => !/No commit/.test(f.text))));
    if (s5a.length) rules.push(hit('watch_release_continuity', s5a.map((e) => evFact(e, 'S5a'))));
    if (l2.length) rules.push(hit('watch_license_category_change', l2.map((c) => ({ signal: 'L2', text: `Declared licence category changed from ${c.value.fromCategory.replace('_', ' ')} to ${c.value.toCategory.replace('_', ' ')} at version ${c.value.version}.`, source: c.source, confidence: 'high' as const, ...(c.evidence ? { evidence: c.evidence } : {}), ...(c.value.date ? { date: day(c.value.date) } : {}) }))));
    if (signedFell.length) rules.push(hit('watch_signed_share_fell', signedFell.map((e) => evFact(e, 'C2'))));
  }
  // C1 counts only together with another signal (P2: it fires on healthy express by itself).
  if (c1.length) {
    const others: StabilityReason[] = [];
    if (cafIs1 && cafFact) others.push(cafFact);
    if (s3.quiet || s3.quietDeclared || s3.inactive) others.push(...s3.facts.filter((f) => /No commit/.test(f.text)));
    if (cadence?.irregular) others.push({ signal: 'S4', text: `Irregular releases: latest gap ${Math.round(cadence.latestGapDays)} days, median ${Math.round(cadence.medianDays)} days, CV ${cadence.cv}.`, source: 'npm', confidence: 'high', evidence: [npmPage(name)] });
    for (const e of [...topNew, ...s5a, ...signedFell]) others.push(evFact(e, e.kind === 'top_committer_new' ? 'C1' : e.kind === 'signed_share_changed' ? 'C2' : 'S5a'));
    if (others.length && !fragile) rules.push(hit('watch_contributor_base_changed_with_other', [...c1.map((e) => evFact(e, 'C1')), ...others]));
    else context.push(...c1.map((e) => evFact(e, 'C1')));
  }
  if (cafFact && !rules.some((r) => r.facts.includes(cafFact!))) context.push(cafFact);
  // How contributors are told apart (P2): without GitHub's login mapping, by commit e-mail address.
  if (h && h.hashedIdentities > 0 && !h.loginsMapped && (caf || s5a.length || c1.length || topNew.length)) {
    context.push({
      signal: 'S2',
      text: 'Contributors are told apart by commit e-mail address (or GitHub no-reply login); GitHub login mapping was not available. One person with two addresses counts twice, and a contributor using a new address shows as newly seen.',
      source: 'git',
      confidence: 'medium',
      ...(repoUrl ? { evidence: [repoUrl] } : {}),
    });
  }

  // A label from low-confidence facts only is capped at Watch (already true: Fragile needs high/medium).
  let label: StabilityLabel;
  if (fragile) label = 'fragile';
  else if (rules.length) label = 'watch';
  else if (caf && s3.state !== 'unknown' && s3.confidence !== 'low') label = 'steady';
  else label = 'unknown';

  // What is missing.
  if (!h) {
    if (!x.repo) missing.push('No source repository is declared on npm.');
    else missing.push(`The git history of ${x.repo.value.url} was not read in this scan (history collection off, offline, or the repository could not be cloned).`);
  }
  else if (x.repo?.value.directory) context.push({ signal: 'S2', text: `Git facts cover the whole repository ${h.repo}; this package is in its subdirectory ${x.repo.value.directory}.`, source: 'git', confidence: 'medium', evidence: [h.repo] });
  if (!x.npm && !x.cadence) missing.push('No npm registry data.');

  const summary =
    label === 'steady'
      ? `No stability rule fired: ${s3.state === 'active' ? 'commits within 6 months' : s3.state}${caf ? `, CAF ${caf.value}` : ''}.`
      : label === 'unknown'
        ? `Not enough data: ${!h ? (!x.repo ? 'no source repository declared' : 'git history not read') : `fewer than ${R.cafMinCommits} commits in the last active 24 months`}.`
        : `${rules
            .slice(0, 2)
            .map((r) => shortText(r, s3, caf))
            .join('; ')}.`;

  const entry: StabilityEntry = {
    package: x.package,
    name,
    versions: info.versions,
    production: info.production,
    label,
    summary,
    rules,
    context,
    missing,
    s3: { state: s3.state, confidence: s3.confidence, ...(s3.lastCommit ? { lastCommit: s3.lastCommit } : {}), ...(s3.lastRelease ? { lastRelease: s3.lastRelease } : {}), ...(x.declared ? { declared: x.declared.value.status } : {}) },
    s5a: continuityEvents(x, name),
    funding: 'not_assessed',
  };
  if (caf) entry.caf = { value: caf.value, commits: caf.commits, from: caf.from, to: caf.to };
  if (cadence) entry.s4 = cadence;
  return entry;
}

