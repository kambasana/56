/**
 * The repo- and org-level inputs of a stability label, read from a scan's facts.
 *
 * This is the only place the label code reads fact values, and it reads repo-level fields only:
 * counts, dates, flags, repo-level observations with fixed wording. It never reads a per-person
 * field (contributor ids and shares, `people`, maintainer or publisher names, the npm publisher
 * timeline) and never reads fact kinds that are about a person (publisher, publisher_change,
 * maintainer_change, release_publishers). No location, time zone (C3) or nationality is read.
 * Guarded by src/stability/stability.test.ts, which makes every per-person field throw when read.
 */
import { unversionedPurl, type CommitHistoryChange, type DeclaredStatusValue, type Fact, type PurlString, type ReleaseCadenceValue, type RepoValue } from '../core/types.js';

/** Fact kinds the labels may read. Everything else is ignored before its value is touched. */
export const LABEL_FACT_KINDS = ['maintainers', 'release_age', 'release_cadence', 'declared_status', 'scorecard', 'archived', 'repo', 'contributors', 'commit_history', 'license_change', 'package_size', 'vuln'] as const;
type LabelKind = (typeof LABEL_FACT_KINDS)[number];

/** Per-person fields that must never be read by the label code (test-enforced). */
export const PER_PERSON_FIELDS = ['top', 'people', 'maintainers', 'accounts', 'email', 'login', 'id', 'by', 'added', 'removed', 'newPublisher', 'previousPublisher', 'previousPublishers', 'publisher', 'offsets', 'hourOfWeekUtc', 'timeZones', 'location', 'country'] as const;

/** Repo-level observation kinds the labels use (C3 time zones are never used). */
const EVENT_KINDS: ReadonlySet<CommitHistoryChange['kind']> = new Set(['contributor_base_changed', 'top_committer_new', 'release_takeover', 'release_by_new_person', 'release_handover', 'signed_share_changed', 'npm_release_by_new_account']);

export interface RepoEvent {
  kind: CommitHistoryChange['kind'];
  date: string;
  text: string;
  release?: string;
  daysSinceFirstSeen?: number;
  before?: number;
  after?: number;
}

export interface Sourced<T> {
  value: T;
  source: string;
  evidence?: string[];
  fetchedAt: string;
}

export interface StabilityInputs {
  package: PurlString;
  /** S1: number of npm maintainers (the count only). */
  maintainerCount?: Sourced<number>;
  /** How many of them are organisation release bots (a count; Tier 0). */
  releaseBotCount?: number;
  /** npm: latest release, its deprecation, the version in use's deprecation. */
  npm?: Sourced<{
    latestVersion?: string;
    latestPublishedAt?: string;
    daysSinceLatestRelease?: number;
    latestDeprecated?: string;
    firstPublishedAt?: string;
    releasesInFinalYear?: number;
    /** Repository the latest release declares (Tier 0 moved-repo check). */
    latestRepo?: { url: string; directory?: string };
    /** PyPI project status other than active (PEP 792; Tier 0.5). */
    projectStatus?: { status: 'archived' | 'deprecated' | 'quarantined'; reason?: string };
    inUse: { version: string; deprecated?: string; yanked?: string; repo?: { url: string; directory?: string } }[];
  }>;
  /** Finished / low-surface input: size and dependency count of each version in use (npm dist or tarball). */
  sizes?: Sourced<{ version: string; unpackedSize: number; fileCount: number; dependencies: number; via: 'npm.dist' | 'npm.tarball' }>[];
  /**
   * OSV advisories affecting a version in use (vuln facts): the advisory page, whether a fixed
   * release exists, and when it was published. Package-level facts, nothing about a person.
   */
  advisories?: Sourced<{ version: string; advisory: string; page: string; fixed: boolean; published?: string }>[];
  cadence?: Sourced<ReleaseCadenceValue>;
  declared?: Sourced<Omit<DeclaredStatusValue, 'via'> & { via?: DeclaredStatusValue['via'] }>;
  /** Scorecard Maintained check (repo-level). */
  maintained?: Sourced<{ score: number; reason?: string; date?: string; repo: string }>;
  /** Every Scorecard Maintained result for the package (one per repository looked up). */
  maintainedAll?: Sourced<{ score: number; reason?: string; date?: string; repo: string }>[];
  archived?: Sourced<{ archived: boolean; lastPushAt?: string; repo?: string }>;
  /** Every archived flag for the package (one per repository looked up). */
  archivedAll?: Sourced<{ archived: boolean; lastPushAt?: string; repo?: string }>[];
  repo?: Sourced<Pick<RepoValue, 'url' | 'directory' | 'host'>>;
  /** S2: CAF over the 24 months to the scan, and over the 24 months to the last commit. */
  caf24?: Sourced<{ value: number; commits: number; from: string; to: string }>;
  history?: Sourced<{
    repo: string;
    lastCommit: string;
    daysSinceLastCommit: number;
    cafAtLastCommit?: { from: string; to: string; commits: number; absenceFactor: number };
    events: RepoEvent[];
    npmPublishers?: { total: number; matched: number };
    /** Identities that are salted e-mail hashes, and whether GitHub logins were mapped (repo-level counts). */
    hashedIdentities: number;
    loginsMapped: boolean;
    /** Tier 0: identities resolved (display names compared or GitHub logins mapped). */
    identityResolved: boolean;
  }>;
  licenseChanges: Sourced<{ version: string; fromCategory: string; toCategory: string; date?: string }>[];
}

const meta = (f: Fact) => ({ source: f.source, fetchedAt: f.fetchedAt, ...(f.evidence?.length ? { evidence: [...f.evidence] } : {}) });

function isLabelKind(k: Fact['kind']): k is LabelKind {
  return (LABEL_FACT_KINDS as readonly string[]).includes(k);
}

/** Group label inputs by unversioned package purl. Reads only the repo-level fields listed above. */
export function collectInputs(facts: readonly Fact[]): Map<PurlString, StabilityInputs> {
  const out = new Map<PurlString, StabilityInputs>();
  const get = (purl: PurlString) => {
    const key = unversionedPurl(purl);
    let x = out.get(key);
    if (!x) out.set(key, (x = { package: key, licenseChanges: [] }));
    return x;
  };
  for (const f of facts) {
    if (!isLabelKind(f.kind)) continue;
    const x = get(f.subject);
    switch (f.kind) {
      case 'maintainers':
        x.maintainerCount ??= { value: f.value.count, ...meta(f) };
        if (f.value.releaseBots) x.releaseBotCount ??= f.value.releaseBots;
        break;
      case 'release_age': {
        const v = f.value;
        const version = f.subject.slice(f.subject.lastIndexOf('@') + 1);
        if (!x.npm) {
          x.npm = { value: { inUse: [] }, ...meta(f) };
          if (v.latestVersion !== undefined) x.npm.value.latestVersion = v.latestVersion;
          if (v.latestPublishedAt !== undefined) x.npm.value.latestPublishedAt = v.latestPublishedAt;
          if (v.daysSinceLatestRelease !== undefined) x.npm.value.daysSinceLatestRelease = v.daysSinceLatestRelease;
          if (v.latestDeprecated !== undefined) x.npm.value.latestDeprecated = v.latestDeprecated;
          else if (v.deprecated !== undefined && v.latestVersion === v.version) x.npm.value.latestDeprecated = v.deprecated;
          if (v.firstPublishedAt !== undefined) x.npm.value.firstPublishedAt = v.firstPublishedAt;
          if (v.releasesInFinalYear !== undefined) x.npm.value.releasesInFinalYear = v.releasesInFinalYear;
          if (v.projectStatus) x.npm.value.projectStatus = { status: v.projectStatus.status, ...(v.projectStatus.reason !== undefined ? { reason: v.projectStatus.reason } : {}) };
        }
        if (v.latestRepository && !x.npm.value.latestRepo) x.npm.value.latestRepo = { url: v.latestRepository.url, ...(v.latestRepository.directory !== undefined ? { directory: v.latestRepository.directory } : {}) };
        x.npm.value.inUse.push({
          version,
          ...(v.deprecated !== undefined ? { deprecated: v.deprecated } : {}),
          ...(v.yanked !== undefined ? { yanked: v.yanked } : {}),
          ...(v.repository ? { repo: { url: v.repository.url, ...(v.repository.directory !== undefined ? { directory: v.repository.directory } : {}) } } : {}),
        });
        break;
      }
      case 'release_cadence': {
        const v = f.value;
        const value: ReleaseCadenceValue = { releases: v.releases, medianDays: v.medianDays, cv: v.cv, latestGapDays: v.latestGapDays, irregular: v.irregular };
        if (v.dates) value.dates = [...v.dates];
        if (v.totalReleases !== undefined) value.totalReleases = v.totalReleases;
        if (v.lastRelease) value.lastRelease = { version: v.lastRelease.version, date: v.lastRelease.date };
        if (v.daysSinceLastRelease !== undefined) value.daysSinceLastRelease = v.daysSinceLastRelease;
        x.cadence ??= { value, ...meta(f) };
        break;
      }
      case 'declared_status':
        x.declared ??= { value: { status: f.value.status, phrase: f.value.phrase, via: f.value.via }, ...meta(f) };
        break;
      case 'scorecard': {
        const checks = f.value.checks;
        const m = checks.find((c) => c.name === 'Maintained');
        if (m && !(x.maintainedAll ?? []).some((o) => o.value.repo.toLowerCase() === f.value.repo.toLowerCase())) {
          const value: { score: number; reason?: string; date?: string; repo: string } = { score: m.score, repo: f.value.repo };
          if (m.reason !== undefined) value.reason = m.reason;
          if (f.value.date !== undefined) value.date = f.value.date;
          x.maintained ??= { value, ...meta(f) };
          (x.maintainedAll ??= []).push({ value, ...meta(f) });
        }
        break;
      }
      case 'archived': {
        const value = { archived: f.value.archived, ...(f.value.lastPushAt !== undefined ? { lastPushAt: f.value.lastPushAt } : {}), ...(f.value.repo !== undefined ? { repo: f.value.repo } : {}) };
        x.archived ??= { value, ...meta(f) };
        (x.archivedAll ??= []).push({ value, ...meta(f) });
        break;
      }
      case 'repo':
        x.repo ??= { value: f.value.directory !== undefined ? { url: f.value.url, host: f.value.host, directory: f.value.directory } : { url: f.value.url, host: f.value.host }, ...meta(f) };
        break;
      case 'contributors':
        x.caf24 ??= { value: { value: f.value.absenceFactor, commits: f.value.commits, from: f.value.from, to: f.value.to }, ...meta(f) };
        break;
      case 'commit_history': {
        if (x.history) break;
        const v = f.value;
        const events: RepoEvent[] = [];
        for (const c of v.changes) {
          if (!EVENT_KINDS.has(c.kind)) continue;
          const e: RepoEvent = { kind: c.kind, date: c.date, text: c.text };
          if (c.release !== undefined) e.release = c.release;
          if (c.daysSinceFirstSeen !== undefined) e.daysSinceFirstSeen = c.daysSinceFirstSeen;
          if (c.before !== undefined) e.before = c.before;
          if (c.after !== undefined) e.after = c.after;
          events.push(e);
        }
        const h: NonNullable<StabilityInputs['history']>['value'] = {
          repo: v.repo,
          lastCommit: v.lastCommit,
          daysSinceLastCommit: v.daysSinceLastCommit,
          events,
          hashedIdentities: v.identity.hashed,
          loginsMapped: v.identity.via.includes('github-graphql'),
          identityResolved: v.identity.resolved === true || v.identity.via.includes('github-graphql'),
        };
        if (v.cafAtLastCommit) h.cafAtLastCommit = { from: v.cafAtLastCommit.from, to: v.cafAtLastCommit.to, commits: v.cafAtLastCommit.commits, absenceFactor: v.cafAtLastCommit.absenceFactor };
        if (v.npmPublishers) h.npmPublishers = { total: v.npmPublishers.total, matched: v.npmPublishers.matched };
        x.history = { value: h, ...meta(f) };
        break;
      }
      case 'package_size': {
        const v = f.value;
        const sizes = (x.sizes ??= []);
        if (!sizes.some((s) => s.value.version === v.version)) sizes.push({ value: { version: v.version, unpackedSize: v.unpackedSize, fileCount: v.fileCount, dependencies: v.dependencies, via: v.via }, ...meta(f) });
        break;
      }
      case 'vuln': {
        // The advisory is named by its OSV page (the fact's first evidence URL, or `url`).
        const v = f.value;
        const page = f.evidence?.[0] ?? v.url;
        if (!page) break;
        const advisory = decodeURIComponent(page.slice(page.lastIndexOf('/') + 1));
        const version = f.subject.slice(f.subject.lastIndexOf('@') + 1);
        (x.advisories ??= []).push({ value: { version, advisory, page, fixed: v.fixedVersions.length > 0, ...(v.published !== undefined ? { published: v.published } : {}) }, ...meta(f) });
        break;
      }
      case 'license_change': {
        const v = f.value;
        x.licenseChanges.push({ value: { version: v.version, fromCategory: v.fromCategory, toCategory: v.toCategory, ...(v.date !== undefined ? { date: v.date } : {}) }, ...meta(f) });
        break;
      }
    }
  }
  return out;
}
