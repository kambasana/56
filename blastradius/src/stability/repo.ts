/**
 * Which repository is current for a package (Tier 0, teardown problem 3).
 *
 * Packages move: agent-base went from TooTallNate/node-agent-base (archived) to the
 * TooTallNate/proxy-agents monorepo, gaxios and @google-cloud/firestore to googleapis/google-cloud-node.
 * The version in use still declares the old repository, so the old repository's archived flag,
 * Scorecard result and git history describe a place the package no longer lives. Before any S3 rule
 * fires, the repository is resolved from the LATEST release's `repository.url` and `directory`
 * (npm), and facts about any other repository are set aside (shown as context, never as "ended").
 */
import { isFundingUrl } from '../history/repo-url.js';
import { addMonths } from '../history/aggregate.js';
import { STABILITY_RULES } from './rules.js';
import type { StabilityInputs } from './signals.js';

/** "github.com/owner/name" from an https URL or a Scorecard / archived repo id; lower case. */
export function repoKey(u: string): string {
  return u
    .trim()
    .replace(/^[a-z+]+:\/\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/** Repository name with the usual "node-" prefix and ".js" / "-js" suffix removed (node-mime → mime). */
function baseName(key: string): string {
  const name = key.split('/').pop() ?? key;
  return name.replace(/^node-/, '').replace(/[.-]js$/, '');
}

/**
 * Same repository: the same key, or the same host and repository name under another owner or with
 * the "node-" / ".js" decoration changed. GitHub keeps a transferred or renamed repository's history
 * and redirects the old URL (visionmedia/debug → debug-js/debug, broofa/node-mime → broofa/mime,
 * kelektiv/node-uuid → uuidjs/uuid), so that is a new address, not a move.
 */
export function sameRepo(a: string, b: string): boolean {
  const ka = repoKey(a);
  const kb = repoKey(b);
  if (ka === kb) return true;
  const ha = ka.split('/')[0];
  const hb = kb.split('/')[0];
  return ha === hb && baseName(ka) === baseName(kb);
}

export interface RepoResolution {
  /** URL of the current repository (latest release's, else the version in use's). */
  current?: string;
  directory?: string;
  /** Repositories versions in use declare that are not the current one. */
  previous: string[];
  /** Versions in use that declare a previous repository. */
  previousVersions: string[];
  /** Moved and released within STABILITY_RULES.movedReleaseMonths, latest release not deprecated. */
  moved?: { latestVersion: string; latestDate: string };
}

const day = (iso: string) => iso.slice(0, 10);

export function latestReleaseDate(x: StabilityInputs): string | undefined {
  const dates = [x.cadence?.value.lastRelease?.date, x.npm?.value.latestPublishedAt ? day(x.npm.value.latestPublishedAt) : undefined].filter((d): d is string => !!d);
  return dates.sort().pop();
}

export function resolveRepo(x: StabilityInputs, asOf: Date): RepoResolution {
  const npm = x.npm?.value;
  // Tier 0.5: a funding page (github.com/sponsors/encode, declared by some PyPI projects) is not a repository.
  const latest = npm?.latestRepo && !isFundingUrl(npm.latestRepo.url) ? npm.latestRepo : undefined;
  const declared = x.repo && !isFundingUrl(x.repo.value.url) ? x.repo : undefined;
  const current = latest?.url ?? declared?.value.url;
  const out: RepoResolution = { previous: [], previousVersions: [] };
  if (!current) return out;
  out.current = current;
  const dir = latest ? latest.directory : declared?.value.directory;
  if (dir) out.directory = dir;
  for (const u of npm?.inUse ?? []) {
    if (!u.repo || sameRepo(u.repo.url, current)) continue;
    out.previousVersions.push(u.version);
    if (!out.previous.some((p) => sameRepo(p, u.repo!.url))) out.previous.push(u.repo.url);
  }
  const last = latestReleaseDate(x);
  const recentCut = addMonths(asOf, -STABILITY_RULES.movedReleaseMonths).toISOString().slice(0, 10);
  if (out.previous.length > 0 && last && last > recentCut && !npm?.latestDeprecated && npm?.latestVersion) out.moved = { latestVersion: npm.latestVersion, latestDate: last };
  return out;
}

/** Whether a fact about `repo` (URL or "github.com/o/n") is about the current repository. */
export function isCurrent(res: RepoResolution, repo: string | undefined): boolean {
  if (!res.current) return true;
  if (repo === undefined) return res.previous.length === 0;
  return sameRepo(repo, res.current);
}

/** "9.x" for "9.0.0"; the version itself when it has no major. */
export function majorLine(version: string): string {
  const m = /^(\d+)\./.exec(version);
  return m ? `${m[1]}.x` : version;
}

const short = (u: string) => u.replace(/^https?:\/\//, '');

/**
 * The inputs as they apply to the current repository: archived flags, Scorecard results and git
 * history about another repository are removed. Returns the set-aside facts as context sentences.
 */
export function currentView(x: StabilityInputs, res: RepoResolution): { view: StabilityInputs; setAside: { text: string; source: string; evidence?: string[] }[] } {
  const view: StabilityInputs = { ...x };
  const setAside: { text: string; source: string; evidence?: string[] }[] = [];
  const arch = x.archivedAll ?? (x.archived ? [x.archived] : []);
  const archCur = arch.filter((a) => isCurrent(res, a.value.repo));
  if (archCur[0]) view.archived = archCur[0];
  else delete view.archived;
  for (const a of arch) {
    if (archCur.includes(a) || !a.value.archived) continue;
    setAside.push({ text: `The earlier repository ${a.value.repo ?? 'declared by the version in use'} is archived on GitHub; it is not the package's current repository${res.current ? ` (${short(res.current)})` : ''}, so this does not mean the package ended.`, source: a.source, ...(a.evidence ? { evidence: a.evidence } : {}) });
  }
  const sc = x.maintainedAll ?? (x.maintained ? [x.maintained] : []);
  const scCur = sc.filter((m) => isCurrent(res, m.value.repo));
  if (scCur[0]) view.maintained = scCur[0];
  else delete view.maintained;
  for (const m of sc) {
    if (scCur.includes(m)) continue;
    setAside.push({ text: `OpenSSF Scorecard result for the earlier repository ${m.value.repo}${m.value.reason ? ` ("${m.value.reason}")` : ''} is not used: the package's current repository is ${res.current ? short(res.current) : 'another one'}.`, source: m.source, ...(m.evidence ? { evidence: m.evidence } : {}) });
  }
  if (x.history && res.current && !sameRepo(x.history.value.repo, res.current)) {
    setAside.push({ text: `Git history was read for ${short(x.history.value.repo)}, which is not the package's current repository (${short(res.current)}); it is not used.`, source: 'git', evidence: [x.history.value.repo] });
    delete view.history;
    delete view.caf24;
  }
  return { view, setAside };
}
