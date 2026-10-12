/**
 * S3 maintenance status, S5a observations and the stability label of one package
 * (docs/WHO-BEHIND-PLAN.md §4), from repo-level inputs only (signals.ts).
 *
 * Label rules (any one fires; Fragile is checked first):
 *   Fragile  CAF = 1 and S3 inactive, unless the package is small and finished (below) ·
 *            CAF = 1 and F3 funding stopped (P4: not assessed) ·
 *            S3 ended (high confidence: archived, or the latest npm release deprecated) in production ·
 *            an open OSV advisory with no fixed release on a version in use, and S3 inactive or ended
 *   Watch    CAF = 1 and S3 inactive on a small, finished package · CAF = 1 · S3 quiet ·
 *            S3 inactive with CAF > 1 · S3 ended outside production or declared
 *            only · S5a release continuity · L2 licence category change · C2 signed share fell ·
 *            C1 contributor base changed together with another signal ·
 *            F2 concentrated with F3 declining (P4: not assessed)
 *   Steady   none of the above, with S2 (CAF) and S3 known from the git history
 *   Unknown  none of the above and no git history (says what is missing)
 * Finished / low-surface (STABILITY_RULES): every version in use small (unpacked size, files) with
 * few dependencies of its own, no OSV advisory for it (the scan's OSV lookup must have run), not
 * deprecated or archived, first released long ago and no burst of releases at the end of its
 * history. Published or deterministic facts only; any unknown input means "not shown finished".
 * A label from low-confidence facts only is capped at Watch (the declared-README rule is low and
 * never reaches Fragile). C1 alone is context: it fired on healthy express in P2.
 * Wording is factual and names no person.
 */
import type { ContinuityEvent, MaintenanceState, StabilityConfidence, StabilityEntry, StabilityLabel, StabilityReason, StabilityRuleHit } from '../core/types.js';
import { addMonths } from '../history/aggregate.js';
import { LABEL_RULES, STABILITY_RULES, type LabelRuleId } from './rules.js';
import { currentView, latestReleaseDate, majorLine, resolveRepo, type RepoResolution } from './repo.js';
import type { RepoEvent, StabilityInputs } from './signals.js';
import { pypiProjectPage } from '../enrich/pypi/index.js';

const R = STABILITY_RULES;
const day = (iso: string) => iso.slice(0, 10);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** Registry text shown in a label: e-mail addresses removed (data minimisation, plan §5). */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;
const clean = (s: string, max = 160) => {
  const t = s.replace(EMAIL_RE, '<e-mail address removed>');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
/** "3 years ago", "5 months ago", "12 days ago" between a YYYY-MM-DD date and the scan time. */
export function ago(date: string, asOf: Date): string {
  const days = Math.max(0, Math.floor((asOf.getTime() - Date.parse(`${date.slice(0, 10)}T00:00:00Z`)) / 86_400_000));
  if (days >= 730) return `${Math.floor(days / 365.25)} years ago`;
  if (days >= 365) return '1 year ago';
  if (days >= 60) return `${Math.floor(days / 30.44)} months ago`;
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

/** "Last release 1.1.2 on 2022-11-21 (3 years ago)": shown before any cadence statistic (Tier 0). */
export function lastReleaseText(x: StabilityInputs, asOf: Date): string | undefined {
  const date = latestReleaseDate(x);
  if (!date) return undefined;
  const c = x.cadence?.value.lastRelease;
  const version = c && c.date === date ? c.version : x.npm?.value.latestPublishedAt && x.npm.value.latestPublishedAt.slice(0, 10) === date ? x.npm.value.latestVersion : undefined;
  return `Last release${version ? ` ${version}` : ''} on ${date} (${ago(date, asOf)})`;
}

const npmPage = (name: string, version?: string) => `https://www.npmjs.com/package/${name}${version ? `/v/${encodeURIComponent(version)}` : ''}`;

/** The package registry of a label's inputs (Tier 0.5: npm and PyPI packages are labelled alike). */
export type RegistryId = 'npm' | 'pypi';
export function registryOf(x: { package: string }): RegistryId {
  return x.package.startsWith('pkg:pypi/') ? 'pypi' : 'npm';
}
const REGISTRY_LABEL: Record<RegistryId, string> = { npm: 'npm', pypi: 'PyPI' };
const regLabel = (x: { package: string }) => REGISTRY_LABEL[registryOf(x)];
/** The registry page of a package (or one version of it). */
export function pageOf(x: { package: string }, name: string, version?: string): string {
  return registryOf(x) === 'pypi' ? pypiProjectPage(name, version) : npmPage(name, version);
}

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
  /** PyPI: the declared repository is archived but releases continue (Tier 0.5): moved, not ended. */
  archivedButReleased?: { repo: string; lastRelease: string };
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
  // Tier 0.5 (PyPI): PyPI does not say which repository the latest release comes from, so an
  // archived repository with releases in the last 12 months is a repository the project left
  // (google-auth: google-auth-library-python archived, releases from the google-cloud-python monorepo).
  const lastRel = x.cadence?.value.lastRelease?.date ?? (x.npm?.value.latestPublishedAt ? day(x.npm.value.latestPublishedAt) : undefined);
  const stillReleased = registryOf(x) === 'pypi' && lastRel !== undefined && lastRel > before(asOf, R.movedReleaseMonths);
  const scArchived = x.maintained && scorecardAsOf(x, asOf) && x.maintained.value.reason === 'project is archived';
  let archivedButReleased: S3Result['archivedButReleased'];
  if (stillReleased && ((archivedAsOf && x.archived) || scArchived)) {
    const repo = x.archived?.value.repo ?? x.maintained?.value.repo ?? x.repo?.value.url ?? 'the declared repository';
    archivedButReleased = { repo, lastRelease: lastRel! };
    context.push({ signal: 'S3', text: `The declared repository ${repo.replace(/^https?:\/\//, '')} is archived, but PyPI releases continue (last release ${lastRel}): the project has moved to another repository, so the archived one does not describe its upkeep.`, source: archivedAsOf && x.archived ? x.archived.source : 'scorecard', confidence: 'high', ...(x.archived?.evidence ?? x.maintained?.evidence ? { evidence: x.archived?.evidence ?? x.maintained!.evidence! } : {}) });
  } else if (archivedAsOf && x.archived) {
    endedHigh = true;
    facts.push({ signal: 'S3', text: 'The repository is archived on GitHub.', source: x.archived.source, confidence: 'high', ...(x.archived.evidence ? { evidence: x.archived.evidence } : {}) });
  } else if (scArchived && x.maintained) {
    endedHigh = true;
    const m = x.maintained.value;
    facts.push({ signal: 'S3', text: `OpenSSF Scorecard's Maintained check reports "project is archived" for ${m.repo}${m.date ? ` (run of ${day(m.date)})` : ''}.`, source: 'scorecard', confidence: 'high', ...(x.maintained.evidence ? { evidence: x.maintained.evidence } : {}), ...(m.date ? { date: day(m.date) } : {}) });
  }
  const npm = x.npm?.value;
  // PyPI project status (PEP 792), set by the maintainers or the index: archived and deprecated end
  // the project; quarantined is an index hold, shown as context.
  const ps = npm?.projectStatus;
  if (ps && (ps.status === 'archived' || ps.status === 'deprecated')) {
    endedHigh = true;
    facts.push({ signal: 'S3', text: `PyPI marks the project ${ps.status}${ps.reason ? `: "${clean(ps.reason)}"` : ''} (project status).`, source: 'pypi', confidence: 'high', evidence: [pageOf(x, name)] });
  } else if (ps?.status === 'quarantined') context.push({ signal: 'S3', text: `PyPI has the project quarantined${ps.reason ? `: "${clean(ps.reason)}"` : ''} (an index hold; new files cannot be installed while it lasts).`, source: 'pypi', confidence: 'high', evidence: [pageOf(x, name)] });
  if (npm?.latestDeprecated) {
    endedHigh = true;
    facts.push({
      signal: 'S3',
      text: `npm marks the latest release${npm.latestVersion ? ` (${npm.latestVersion})` : ''} deprecated: "${clean(npm.latestDeprecated)}".`,
      source: 'npm',
      confidence: 'high',
      evidence: [pageOf(x, name, npm.latestVersion)],
      ...(npm.latestPublishedAt ? { date: day(npm.latestPublishedAt) } : {}),
    });
  }
  for (const u of npm?.inUse ?? []) {
    if (u.deprecated && u.version !== npm?.latestVersion) context.push({ signal: 'S3', text: `The version in use (${u.version}) is deprecated on npm: "${clean(u.deprecated)}". Later releases are not.`, source: 'npm', confidence: 'high', evidence: [pageOf(x, name, u.version)] });
    if (u.yanked !== undefined) context.push({ signal: 'S3', text: `The version in use (${u.version}) is yanked on PyPI${u.yanked ? `: "${clean(u.yanked)}"` : ''}.`, source: 'pypi', confidence: 'high', evidence: [pageOf(x, name, u.version)] });
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
    if (inactive) facts.push({ signal: 'S3', text: `No commit and no release in ${R.inactiveMonths} months (${lastBits}).`, source: `git+${registryOf(x)}`, confidence: 'medium', evidence: [h.repo, pageOf(x, name)], date: h.lastCommit > (lastRelease ?? '') ? h.lastCommit : lastRelease! });
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
    if (cadenceIrregular && x.cadence) second.push(`irregular releases (gap between the two most recent releases ${Math.round(x.cadence.value.latestGapDays)} days, median ${Math.round(x.cadence.value.medianDays)})`);
    const what = d.status === 'maintenance_mode' ? 'maintenance mode' : d.status === 'unmaintained' ? 'that it is no longer maintained' : 'deprecation';
    const by = d.via === 'pypi.classifier' ? 'The PyPI classifiers declare' : 'The README declares';
    const reason: StabilityReason = { signal: 'S3', text: `${by} ${what}: "${clean(d.phrase, 200)}"${second.length ? `; and ${second.join(', ')}` : ''}.`, source: d.via ?? 'npm.readme', confidence: 'low', evidence: [pageOf(x, name)] };
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
  const out: S3Result = { state, confidence, endedHigh, endedDeclared, quietDeclared, inactive, quiet, facts, context, ...(archivedButReleased ? { archivedButReleased } : {}) };
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
/** S5a kinds that rest on git identities alone (the npm kind is matched through the registry account). */
const GIT_ONLY_S5A = new Set<RepoEvent['kind']>(['release_by_new_person', 'release_takeover']);

/**
 * Whether an S5a observation counts (Tier 0): git-only kinds need resolved identities (display
 * names compared or GitHub logins mapped); without them a new address reads as a new person.
 */
export function s5aCounts(e: RepoEvent, identityResolved: boolean): boolean {
  return S5A_KINDS.has(e.kind) && (identityResolved || !GIT_ONLY_S5A.has(e.kind));
}

export function isRecent(date: string, asOf: Date, months = R.recentMonths): boolean {
  // Strictly after the cut: a 12-month window comparison dated exactly 12 months ago is the previous window.
  return date > before(asOf, months) && date <= asOf.toISOString().slice(0, 10);
}

/** S5a observations (all dates), as Changes-page events. */
export function continuityEvents(x: StabilityInputs, name: string): ContinuityEvent[] {
  const h = x.history;
  if (!h) return [];
  return h.value.events
    .filter((e) => s5aCounts(e, h.value.identityResolved))
    .map((e) => {
      const ev: ContinuityEvent = {
        package: x.package,
        name,
        kind: e.kind as ContinuityEvent['kind'],
        date: e.date,
        text: e.text,
        source: e.kind === 'npm_release_by_new_account' ? 'npm+git' : 'git',
        confidence: 'medium',
        evidence: e.kind === 'npm_release_by_new_account' && e.release ? [pageOf(x, name, e.release), h.value.repo] : [h.value.repo],
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
    case 'fragile_unfixed_advisory_inactive':
      return s3.endedHigh ? 'Open advisory with no fixed release' : `Open advisory with no fixed release, and no commit or release in ${R.inactiveMonths} months`;
    case 'watch_finished_single_contributor_inactive':
      return 'Small, finished package: single maintainer, no recent activity';
    case 'watch_ended':
      return s3.endedHigh ? `${endedWords(s3)}, not a production dependency here` : 'README declares the project ended, with a second fact';
    case 'watch_single_contributor':
      return `Single active contributor (CAF ${caf?.value ?? 1})`;
    case 'watch_quiet':
      return s3.quiet ? `No commit in ${R.quietCommitMonths} months` : 'README declares maintenance mode, with a second fact';
    case 'watch_inactive':
      return `No commit and no release in ${R.inactiveMonths} months`;
    case 'watch_moved':
      return 'Moved to another repository and still released';
    case 'watch_no_recent_release':
      return `No release in ${R.inactiveMonths} months (git history not read)`;
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
  if (/PyPI marks the project (archived|deprecated)/.test(t)) return `PyPI project ${/PyPI marks the project archived/.test(t) ? 'archived' : 'deprecated'}${/repository is archived|project is archived" for/.test(t) ? ' and repository archived' : ''}`;
  if (/deprecated/.test(t) && /archived/.test(t)) return 'Deprecated on npm and repository archived';
  if (/deprecated/.test(t)) return 'Deprecated on npm';
  return 'Repository archived';
}

const kb = (n: number) => `${(n / 1024).toFixed(1)} kB`;

export interface FinishedResult {
  state: 'yes' | 'no' | 'unknown';
  /** Conditions that failed or could not be checked (plain sentences). */
  notMet: string[];
  /** Facts that make the package finished (when state is yes). */
  facts: StabilityReason[];
  /** Largest version in use. */
  size?: { unpackedSize: number; fileCount: number; dependencies: number };
}

/** Finished / low-surface test (STABILITY_RULES, rules.ts). */
export function finishedTest(x: StabilityInputs, name: string, versions: readonly string[], s3: S3Result, asOf: Date, advisoriesChecked: boolean): FinishedResult {
  const no: string[] = [];
  const unknown: string[] = [];
  const facts: StabilityReason[] = [];
  const npm = x.npm?.value;
  // Not deprecated, not archived.
  if (s3.endedHigh || s3.endedDeclared) no.push('deprecated or archived');
  const inUseDeprecated = (npm?.inUse ?? []).filter((u) => u.deprecated && versions.includes(u.version));
  if (inUseDeprecated.length) no.push(`version in use deprecated (${inUseDeprecated.map((u) => u.version).join(', ')})`);
  // Size and dependencies of every version in use.
  const sizes = versions.map((v) => x.sizes?.find((s) => s.value.version === v));
  let size: FinishedResult['size'];
  if (sizes.some((s) => !s)) unknown.push(`package size not known for ${versions.filter((_, i) => !sizes[i]).join(', ')}`);
  else {
    const all = sizes.map((s) => s!.value);
    size = { unpackedSize: Math.max(...all.map((s) => s.unpackedSize)), fileCount: Math.max(...all.map((s) => s.fileCount)), dependencies: Math.max(...all.map((s) => s.dependencies)) };
    if (size.unpackedSize > R.finishedMaxUnpackedBytes) no.push(`${kb(size.unpackedSize)} unpacked (more than ${kb(R.finishedMaxUnpackedBytes)})`);
    if (size.fileCount > R.finishedMaxFiles) no.push(`${plural(size.fileCount, 'file')} (more than ${R.finishedMaxFiles})`);
    if (size.dependencies > R.finishedMaxDependencies) no.push(`${plural(size.dependencies, 'dependency', 'dependencies')} (more than ${R.finishedMaxDependencies})`);
    const largest = all.reduce((a, b) => (b.unpackedSize > a.unpackedSize ? b : a));
    const via = sizes.some((s) => s!.value.via === 'npm.tarball') ? 'read from the published tarball' : 'npm dist.unpackedSize and dist.fileCount';
    facts.push({
      signal: 'S3',
      text: `Small package: ${all.length > 1 ? 'largest version in use ' : ''}${largest.version} is ${kb(largest.unpackedSize)} unpacked in ${plural(largest.fileCount, 'file')}, with ${plural(largest.dependencies, 'dependency', 'dependencies')} of its own (${via}).`,
      source: registryOf(x),
      confidence: 'high',
      evidence: [...new Set(sizes.flatMap((s) => s!.evidence ?? [pageOf(x, name, s!.value.version)]))],
    });
  }
  // Long stable history.
  const first = npm?.firstPublishedAt ? day(npm.firstPublishedAt) : undefined;
  const finalYear = npm?.releasesInFinalYear;
  if (!first || finalYear === undefined) unknown.push('release history not known');
  else {
    if (first > before(asOf, R.finishedMinAgeMonths)) no.push(`first release ${first}, less than ${R.finishedMinAgeMonths} months before the scan`);
    if (finalYear > R.finishedMaxReleasesInFinalYear) no.push(`${plural(finalYear, 'release')} in the final 12 months of its history (more than ${R.finishedMaxReleasesInFinalYear})`);
    facts.push({ signal: 'S4', text: `Long, settled history: first release ${first}; ${plural(finalYear, 'stable release')} in the final 12 months before the last release${s3.lastRelease ? ` (${s3.lastRelease})` : ''}.`, source: registryOf(x), confidence: 'high', evidence: [pageOf(x, name)] });
  }
  // Open advisories (OSV) for the versions in use.
  const adv = (x.advisories ?? []).filter((a) => versions.includes(a.value.version));
  if (adv.length) no.push(`open OSV advisory for the version in use (${[...new Set(adv.map((a) => a.value.advisory))].join(', ')})`);
  else if (!advisoriesChecked) unknown.push('advisories not checked in this scan (OSV lookup off or incomplete)');
  else facts.push({ signal: 'S3', text: `Not deprecated or archived, and no OSV advisory affects ${versions.length > 1 ? 'the versions' : 'the version'} in use (${versions.join(', ')}).`, source: 'osv', confidence: 'high', evidence: [`https://osv.dev/list?ecosystem=${registryOf(x) === 'pypi' ? 'PyPI' : 'npm'}&q=${encodeURIComponent(name)}`] });
  const state = no.length ? 'no' : unknown.length ? 'unknown' : 'yes';
  const out: FinishedResult = { state, notMet: [...no, ...unknown], facts: state === 'yes' ? facts : [] };
  if (size) out.size = size;
  return out;
}

export function labelPackage(input: StabilityInputs, info: { name: string; versions: string[]; production: boolean; advisoriesChecked?: boolean }, asOf: Date): StabilityEntry {
  const name = info.name;
  const context: StabilityReason[] = [];
  const missing: string[] = [];
  // Tier 0: resolve the current repository (latest release's) before any S3 rule; facts about an
  // earlier repository are context only.
  const res = resolveRepo(input, asOf);
  const { view: x, setAside } = currentView(input, res);
  for (const a of setAside) context.push({ signal: 'S3', text: a.text, source: a.source, confidence: 'high', ...(a.evidence ? { evidence: a.evidence } : {}) });
  const cadence = x.cadence?.value;
  const lastRel = lastReleaseText(x, asOf);
  const s3 = maintenanceState(x, name, asOf, cadence?.irregular === true);
  context.push(...s3.context);
  const caf = cafFor(x);
  const h = x.history?.value;
  const repoUrl = h?.repo ?? x.repo?.value.url;

  // S1 (context only): registry maintainers, the count.
  if (x.maintainerCount) {
    const bots = x.releaseBotCount ?? 0;
    context.push({ signal: 'S1', text: `npm lists ${plural(x.maintainerCount.value, 'maintainer')} with publish rights${bots ? ` (${bots === x.maintainerCount.value ? (bots === 1 ? 'an organisation release bot' : 'all organisation release bots') : `${plural(bots, 'organisation release bot')} among them`}, not a person)` : ''}.`, source: 'npm', confidence: 'high', evidence: [pageOf(x, name)] });
  }

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

  // S4 (context; a second fact for a declared status). The last release and its age come first
  // (Tier 0: a cadence statistic alone read as "active" for a package last released years ago).
  if (cadence) {
    context.push({
      signal: 'S4',
      text: `${lastRel ? `${lastRel}. ` : ''}${cadence.irregular ? 'Irregular releases' : 'Releases'} up to then: median ${Math.round(cadence.medianDays)} days between the last ${cadence.releases} releases, CV ${cadence.cv}, gap between the two most recent ${Math.round(cadence.latestGapDays)} days.`,
      source: registryOf(x),
      confidence: 'high',
      evidence: [pageOf(x, name)],
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
  const resolved = h?.identityResolved === true;
  const s5a = recent.filter((e) => s5aCounts(e, resolved));
  // Tier 0: window-based kinds (release handover, contributor base, new top committer, signed share,
  // time-zone pattern) are context only; they compare 12-month windows, not two scans.
  const c1 = recent.filter((e) => e.kind === 'contributor_base_changed');
  const topNew = recent.filter((e) => e.kind === 'top_committer_new');
  for (const e of recent) if (e.kind === 'release_handover' || e.kind === 'signed_share_changed') context.push(evFact(e, e.kind === 'release_handover' ? 'S5a' : 'C2'));
  for (const e of topNew) context.push(evFact(e, 'C1'));
  const demoted = recent.filter((e) => S5A_KINDS.has(e.kind) && !s5a.includes(e));
  for (const e of demoted) context.push(evFact(e, 'S5a', 'low'));

  // L2: licence category changes dated within the recent window.
  const l2 = x.licenseChanges.filter((c) => c.value.fromCategory !== c.value.toCategory && c.value.fromCategory !== 'unknown' && c.value.toCategory !== 'unknown' && c.value.date !== undefined && isRecent(day(c.value.date), asOf));

  // Finished / low-surface, and open advisories (OSV) on the versions in use.
  const fin = finishedTest(x, name, info.versions, s3, asOf, info.advisoriesChecked === true);
  const unfixed = (x.advisories ?? []).filter((a) => info.versions.includes(a.value.version) && !a.value.fixed);

  // Rules.
  const rules: StabilityRuleHit[] = [];
  const cafIs1 = caf?.value === 1;
  const inactiveFacts = () => s3.facts.filter((f) => /No commit and no release/.test(f.text));
  const finishedInactive = cafIs1 && s3.inactive && fin.state === 'yes';
  if (cafIs1 && s3.inactive && !finishedInactive) rules.push(hit('fragile_single_contributor_inactive', [cafFact!, ...inactiveFacts()]));
  if (s3.endedHigh && info.production) rules.push(hit('fragile_ended_production', [...s3.facts.filter((f) => f.confidence === 'high'), { signal: 'S3', text: 'Reached through a runtime (non-dev) dependency path in this scan.', source: 'inventory', confidence: 'high' }]));
  if (unfixed.length && (s3.inactive || s3.endedHigh)) {
    const advFacts: StabilityReason[] = unfixed.map((a) => ({ signal: 'S3', text: `OSV advisory ${a.value.advisory} affects version ${a.value.version}; OSV lists no fixed release.`, source: 'osv', confidence: 'high' as const, evidence: [a.value.page], ...(a.value.published ? { date: day(a.value.published) } : {}) }));
    rules.push(hit('fragile_unfixed_advisory_inactive', [...advFacts, ...(s3.endedHigh ? s3.facts.filter((f) => f.confidence === 'high') : inactiveFacts())]));
  }
  if (cafIs1 && s3.inactive && fin.state === 'no') context.push({ signal: 'S3', text: `Not a small, finished package: ${fin.notMet.join('; ')}.`, source: registryOf(x), confidence: 'high', evidence: [pageOf(x, name)] });
  if (cafIs1 && s3.inactive && fin.state === 'unknown') missing.push(`Finished / low-surface test not complete (${fin.notMet.join('; ')}): single contributor and inactive stays Fragile.`);
  const fragile = rules.length > 0;
  // Tier 0: moved to another repository and still released: Watch with an action, never Fragile
  // from the old repository's facts (those were set aside above).
  let action: string | undefined;
  if (res.moved && res.current) {
    const to = res.current.replace(/^https?:\/\//, '');
    action = `Moved: upgrade to ${majorLine(res.moved.latestVersion)} (repo ${to}${res.directory ? `, ${res.directory}` : ''})`;
    if (!fragile)
      rules.push(
        hit('watch_moved', [
          {
            signal: 'S3',
            text: `The latest release ${res.moved.latestVersion} (${res.moved.latestDate}) declares the repository ${to}${res.directory ? ` (directory ${res.directory})` : ''}; the version${res.previousVersions.length > 1 ? 's' : ''} in use (${res.previousVersions.join(', ')}) declare${res.previousVersions.length > 1 ? '' : 's'} ${res.previous.map((u) => u.replace(/^https?:\/\//, '')).join(', ')}.`,
            source: 'npm',
            confidence: 'high',
            evidence: [pageOf(x, name, res.moved.latestVersion), ...res.previousVersions.map((v) => pageOf(x, name, v))],
            date: res.moved.latestDate,
          },
        ]),
      );
  }
  if (!res.moved && s3.archivedButReleased) {
    const ab = s3.archivedButReleased;
    action = `Moved: the declared repository ${ab.repo.replace(/^https?:\/\//, '')} is archived while PyPI releases continue; find the current repository`;
    if (!fragile) rules.push(hit('watch_moved', [s3.context.find((c) => c.text.startsWith('The declared repository'))!]));
  }
  // Tier 0 fallback without git history (no clone): the npm release record and, when deps.dev has
  // it, OpenSSF Scorecard's Maintained check for the current repository.
  const fallback = !h ? fallbackUpkeep(x, name, asOf, fin.state === 'yes') : undefined;
  if (!fragile) {
    if (fallback?.noRecentRelease) rules.push(hit('watch_no_recent_release', fallback.facts));
    if (finishedInactive) rules.push(hit('watch_finished_single_contributor_inactive', [cafFact!, ...inactiveFacts(), ...fin.facts]));
    else if (cafIs1) rules.push(hit('watch_single_contributor', [cafFact!]));
    if (s3.quiet || s3.quietDeclared) rules.push(hit('watch_quiet', s3.facts.filter((f) => /No commit in|maintenance mode/.test(f.text))));
    if (s3.inactive && !cafIs1) rules.push(hit('watch_inactive', [...s3.facts.filter((f) => /No commit and no release/.test(f.text)), ...(cafFact ? [cafFact] : [])]));
    if (s3.endedHigh || s3.endedDeclared) rules.push(hit('watch_ended', s3.facts.filter((f) => !/No commit/.test(f.text))));
    if (s5a.length) rules.push(hit('watch_release_continuity', s5a.map((e) => evFact(e, 'S5a'))));
    if (l2.length)
      rules.push(hit('watch_license_category_change', l2.map((c) => ({ signal: 'L2', text: `Declared licence category changed from ${c.value.fromCategory.replace('_', ' ')} to ${c.value.toCategory.replace('_', ' ')} at version ${c.value.version}.`, source: c.source, confidence: 'high' as const, ...(c.evidence ? { evidence: c.evidence } : {}), ...(c.value.date ? { date: day(c.value.date) } : {}) }))));
  }
  // C1 is context only (Tier 0: a window comparison; P2 found it fires on healthy express by itself).
  context.push(...c1.map((e) => evFact(e, 'C1')));
  if (cafFact && !rules.some((r) => r.facts.includes(cafFact!))) context.push(cafFact);
  // How contributors are told apart (P2): without GitHub's login mapping, by commit e-mail address.
  if (h && h.hashedIdentities > 0 && !h.loginsMapped && !resolved && (caf || demoted.length || c1.length || topNew.length)) {
    context.push({
      signal: 'S2',
      text: 'Contributors are told apart by commit e-mail address (or GitHub no-reply login); display names were not compared and GitHub login mapping was not available. One person with two addresses counts twice, and a contributor using a new address shows as newly seen, so git-only release-continuity observations are context here.',
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
  else if (fallback?.steady) label = 'steady';
  else label = 'unknown';
  // The fallback's facts are already in the context (S4 last release, Scorecard Maintained) unless
  // the package has no cadence: then the last release is new information.
  if (!h && fallback && !cadence) context.push(...fallback.facts.filter((f) => f.source === registryOf(x) && !rules.some((r) => r.facts.includes(f))));
  const basis: StabilityEntry['basis'] = h ? 'git' : fallback?.basis ?? 'none';

  // What is missing.
  if (!h) {
    if (!res.current) missing.push(registryOf(x) === 'pypi' ? 'No source repository is declared on PyPI (deps.dev found none).' : 'No source repository is declared on npm.');
    else missing.push(`The git history of ${res.current} was not read in this scan (history collection off, outside the history cap or disk budget, offline, or the repository could not be cloned)${fallback && fallback.basis !== 'none' ? `; upkeep from ${fallback.basis.startsWith('scorecard+') ? `OpenSSF Scorecard (via deps.dev) and the ${regLabel(x)} release record` : `the ${regLabel(x)} release record`} instead` : ''}.`);
  }
  else if (x.repo?.value.directory) context.push({ signal: 'S2', text: `Git facts cover the whole repository ${h.repo}; this package is in its subdirectory ${x.repo.value.directory}.`, source: 'git', confidence: 'medium', evidence: [h.repo] });
  if (!x.npm && !x.cadence) missing.push(`No ${regLabel(x)} registry data.`);

  const summary =
    label === 'steady'
      ? h
        ? `No stability rule fired: ${s3.state === 'active' ? 'commits within 6 months' : s3.state}${caf ? `, CAF ${caf.value}` : ''}.`
        : `No stability rule fired: ${fallback!.steadyText} (git history not read).`
      : label === 'unknown'
        ? `Not enough data: ${!h ? (!res.current ? 'no source repository declared' : 'git history not read, and no recent release or Scorecard result to fall back on') : `fewer than ${R.cafMinCommits} commits in the last active 24 months`}.`
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
  entry.finished = { state: fin.state, notMet: fin.notMet, ...(fin.size ? { size: fin.size } : {}) };
  if (cadence) entry.s4 = cadence;
  if (action) entry.action = action;
  if (res.current) entry.repo = { current: res.current, ...(res.directory ? { directory: res.directory } : {}), ...(res.previous.length ? { previous: res.previous } : {}) };
  entry.basis = basis;
  return entry;
}

interface Fallback {
  basis: 'scorecard+npm' | 'npm' | 'scorecard+pypi' | 'pypi' | 'none';
  steady: boolean;
  steadyText: string;
  noRecentRelease: boolean;
  facts: StabilityReason[];
}

/**
 * Upkeep without git history (Tier 0, teardown problem 5): repositories outside the history cap or
 * not cloned get a label from facts that need no clone instead of Unknown. Steady needs a release
 * within 12 months or Scorecard Maintained ≥ 5; no release in 18 months is Watch (never Fragile:
 * without commits there is no CAF and no "inactive"), unless the package is small and finished.
 */
function fallbackUpkeep(x: StabilityInputs, name: string, asOf: Date, finished: boolean): Fallback {
  const facts: StabilityReason[] = [];
  const last = latestReleaseDate(x);
  const m = x.maintained && scorecardAsOf(x, asOf) ? x.maintained.value : undefined;
  const reg = registryOf(x);
  const basis: Fallback['basis'] = m ? `scorecard+${reg}` : last ? reg : 'none';
  const recent12 = last !== undefined && last > before(asOf, 12);
  const old18 = last !== undefined && last < before(asOf, R.inactiveMonths);
  const scActive = m !== undefined && m.score >= R.scorecardActiveScore;
  const lastText = last ? lastReleaseText(x, asOf)! : undefined;
  if (lastText) facts.push({ signal: 'S3', text: `${lastText} (${regLabel(x)}).`, source: reg, confidence: 'high', evidence: [pageOf(x, name)], date: last! });
  if (m) facts.push({ signal: 'S3', text: `OpenSSF Scorecard Maintained ${m.score}/10 for ${m.repo}${m.reason ? `: ${m.reason}` : ''}${m.date ? ` (run of ${day(m.date)})` : ''} (no clone needed).`, source: 'scorecard', confidence: 'medium', ...(x.maintained?.evidence ? { evidence: x.maintained.evidence } : {}) });
  const noRecentRelease = old18 && !scActive && !finished;
  const steady = !noRecentRelease && (recent12 || scActive || (old18 && finished));
  const bits: string[] = [];
  if (last) bits.push(`last release ${last}`);
  if (m) bits.push(`Scorecard Maintained ${m.score}/10`);
  if (old18 && finished) bits.push('small, finished package');
  return { basis, steady, steadyText: bits.join(', '), noRecentRelease, facts };
}

