/**
 * Web API contract for the account index (docs/WEB-API.md "Accounts", docs/ACCOUNT-PROOF.md):
 * who can publish what you depend on, "account X is compromised", and publishing-account
 * concentration. Type imports and constant tables only, so the web app imports it through the
 * @server alias. Account and package names come from public registries: untrusted text.
 */
import type { Id, IsoTime } from './api-types.js';
import type { IncidentStatus } from './api-types-incidents.js';

export const ACCOUNT_REGISTRIES = ['npm', 'github', 'gitlab'] as const;
export type AccountRegistry = (typeof ACCOUNT_REGISTRIES)[number];

/**
 * How an account is linked to a package:
 * - maintainer: in the packument's maintainers (can publish now);
 * - listed: in the account's own npm package listing (can publish now);
 * - version_maintainer: in the maintainers of the latest version published at or before `asOf`
 *   (can publish at that time; used for questions about the past);
 * - repo_owner: owns the repository the package declares (can push code, not npm publish rights);
 * - publisher: published (`_npmUser`) the exact version a project locks.
 */
export type AccountRelation = 'maintainer' | 'listed' | 'version_maintainer' | 'repo_owner' | 'publisher';
export type LinkConfidence = 'high' | 'medium' | 'low';

export interface AccountLinkSource {
  relation: AccountRelation;
  /** Where the link comes from, in words ("npm packument maintainers"). */
  source: string;
  confidence: LinkConfidence;
  /** A public page that shows it. */
  evidence: string;
}

export interface AccountRef {
  registry: AccountRegistry;
  name: string;
  /** Entity id as in "Who's behind it": "account:npm/qix", "owner:github/chalk" (repository owner, type unknown). */
  entityId: string;
  /** Public profile page. */
  profileUrl: string;
}

/**
 * A known-bad record naming a package version: a hand-curated KB incident (kb/incidents, e.g.
 * INC-2025-0002) or an OSV malware advisory (MAL-*). Public records about versions, not people.
 */
export interface KnownBadRef {
  id: string;
  source: 'kb' | 'osv';
  /** The record's first public source (advisory or write-up). */
  url: string;
}

/** One known-bad record, with every version of the account's packages it names. */
export interface AccountKnownBad {
  id: string;
  source: 'kb' | 'osv';
  title: string;
  date: string | null;
  /** Other ids for the same record (GHSA, CVE, the OSV MAL id of a KB incident). */
  aliases: string[];
  evidence: string[];
  /** The account's packages and the exact versions the record names ("*" = every version). */
  packages: { name: string; versions: string[] }[];
  /** A project you can see locks one of those versions now. */
  lockedInYourProjects: boolean;
}

/** A package the account can publish. */
export interface AccountPackage {
  name: string;
  links: AccountLinkSource[];
  /** Projects you can see whose latest scan has it (any version). */
  projects: number;
  /** It reaches production in at least one of them. */
  production: boolean;
  /** Known-bad records for any version of it (empty when none). */
  knownBad: KnownBadRef[];
}

/** One version the account published. `attribution` says how the publisher is known. */
export interface AccountPublish {
  name: string;
  version: string;
  at: IsoTime;
  /** npmUser: the registry names the publisher; sole-maintainer: deleted version, the previous version had one maintainer. */
  attribution: 'npmUser' | 'sole-maintainer';
  /** Projects you can see that lock exactly this version. */
  projects: number;
  /** Known-bad records naming exactly this version (flagged in place; empty when none). */
  knownBad: KnownBadRef[];
}

/** One project × package version exposed by the account. */
export interface AccountExposureRow {
  projectId: Id;
  projectName: string;
  /** Free-text owner from the project settings. */
  owner: string | null;
  purl: string;
  name: string;
  version: string;
  production: boolean;
  direct: boolean;
  /** Direct dependencies that bring it in ("mocha@10.2.0"); empty when direct. */
  broughtInBy: string[];
  /**
   * can_publish: the account could publish this package (as of `asOf`);
   * published_since: the account published this exact version within [since, asOf].
   */
  reasons: ('can_publish' | 'published_since')[];
  /** Who published the locked version, when the registry still says. */
  publishedBy: { account: string; attribution: 'npmUser' | 'sole-maintainer'; at: IsoTime } | null;
  links: AccountLinkSource[];
  confidence: LinkConfidence;
  /** The project's finding for this package in its latest scan, if any. */
  findingId: Id | null;
  /** Known-bad records naming the locked version (empty when none). */
  knownBad: KnownBadRef[];
}

export interface AccountIndexState {
  /** Packages in your projects with registry data. */
  packagesIndexed: number;
  /** Packages in your projects without registry data yet (not fetched, missing or unavailable). */
  packagesWithoutData: number;
  /** The account's own package listing (npm only). */
  listing: { status: 'ok' | 'unavailable'; fetchedAt: IsoTime; count: number; detail: string | null } | null;
  /** Packages the listing names whose history is not indexed yet (so "as of" cannot confirm them). */
  unverified: number;
}

export interface AccountIncidentRef {
  id: string;
  status: IncidentStatus;
  since: IsoTime | null;
  markedAt: IsoTime;
}

/**
 * GET /api/accounts/:registry/:name/exposure?since=&asOf= — "account X is compromised": every
 * exposed project, package and version. Read-only.
 */
export interface AccountExposureResponse {
  account: AccountRef;
  since: IsoTime | null;
  /** "Can publish" is answered as of this time (now when not given). */
  asOf: IsoTime;
  historical: boolean;
  projectsSearched: number;
  /** Every package the account can publish (as of `asOf`), in your projects first. */
  packages: AccountPackage[];
  /** Versions the account published within [since, asOf] (only with `since`), newest first. */
  publishedSince: AccountPublish[];
  /** Production first, then project and package. */
  exposures: AccountExposureRow[];
  counts: { exposures: number; projects: number; production: number; packages: number; packagesInYourProjects: number; versionsPublishedSince: number };
  index: AccountIndexState;
  /** The org's own incident for this account (opened by "mark as compromised"); null otherwise. */
  incident: AccountIncidentRef | null;
  /** KB incidents and OSV malware advisories naming versions of the packages it can publish. */
  knownBad: AccountKnownBad[];
}

/**
 * Account page counts, every one in distinct package names (any version), so they add up:
 * canPublishInProduction ≤ canPublishInYourProjects ≤ canPublish, and concentration.packages equals
 * canPublishInProduction.
 */
export interface AccountCounts {
  /** Packages it can publish now (packument maintainers, or its own npm listing). */
  canPublish: number;
  /** …that a project you can see uses (any version). */
  canPublishInYourProjects: number;
  /** …that reach production in at least one of them. */
  canPublishInProduction: number;
  /** Production packages (org-wide, your projects) with registry data: the denominator of the share. */
  productionPackagesWithData: number;
}

/** Plain-language definitions of AccountCounts, for the page and the API docs. */
export const ACCOUNT_COUNT_DEFINITIONS: Record<keyof AccountCounts, string> = {
  canPublish: 'Packages this account can publish now (npm packument maintainers or its own package listing), counted by name.',
  canPublishInYourProjects: 'Of those, packages a project you can see uses, any version, counted by name.',
  canPublishInProduction: 'Of those, packages that reach production in at least one project, counted by name.',
  productionPackagesWithData: 'Production packages across your projects with registry data, counted by name.',
};

/** GET /api/accounts/:registry/:name — the Account page. */
export interface AccountDetail {
  account: AccountRef;
  /** The index knows at least one package for it. */
  known: boolean;
  /** Packages it can publish now, in your projects first. */
  packages: AccountPackage[];
  /**
   * Recent publish activity (context only, never an alert: the burst rule failed its noise gate,
   * docs/ACCOUNT-PROOF.md H2). The latest 25 publishes the index knows, newest first, any age.
   */
  recentPublishes: AccountPublish[];
  /** Distinct packages it published in the last day, week and 30 days (counted from now). */
  activity: { last24h: number; last7d: number; last30d: number };
  /**
   * Share of your production dependencies (org-wide) it can publish: `packages` production package
   * names whose current maintainers include it, of `of` production package names with registry data.
   */
  concentration: { packages: number; of: number; share: number };
  /** Counts with one unit (package names); see AccountCounts. */
  counts: AccountCounts;
  index: AccountIndexState;
  /** The org's own incident for this account (opened by "mark as compromised"); null otherwise. */
  incident: AccountIncidentRef | null;
  /** KB incidents and OSV malware advisories naming versions of the packages it can publish, newest first. */
  knownBad: AccountKnownBad[];
}

/** POST /api/accounts/:registry/:name/compromise { since? } (needs `review`). */
export interface MarkCompromisedRequest {
  since?: IsoTime;
}
export interface MarkCompromisedResponse {
  /** The incident listing the exposure; null when nothing in your projects is exposed (no incident is opened). */
  incidentId: string | null;
  /** False when the incident already existed and was updated (or none was opened). */
  created: boolean;
  /** Exposures that were not on the incident before. */
  added: number;
  /** Exposures already on the incident whose level this update raised (e.g. high → critical for a version published since `since`). */
  raised: number;
  exposure: AccountExposureResponse;
}

export interface ConcentrationAccount {
  registry: 'npm';
  name: string;
  /** Production packages it can publish. */
  packages: number;
  /** packages / production packages with registry data. */
  share: number;
  /** Projects where it can publish at least one production package (org-wide rows only). */
  projects?: number;
}

export interface ConcentrationScope {
  /** Distinct production npm packages (name@version). */
  productionPackages: number;
  /** Of those, packages with registry data. */
  withData: number;
  /** Largest share first. */
  accounts: ConcentrationAccount[];
}

/** GET /api/accounts/concentration?projects=&limit= — who can publish the largest share of production dependencies (H3). */
export interface ConcentrationResponse {
  org: ConcentrationScope;
  projects: (ConcentrationScope & { projectId: Id; projectName: string })[];
}
