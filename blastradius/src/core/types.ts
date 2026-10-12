/**
 * Shared domain model for Blastradius (PLAN §3.5).
 *
 * This file is the contract between modules (ingest, enrich/*, entities,
 * incidents, scoring, report). Change it only by agreement; see CONTRACTS.md.
 *
 * Everything here is plain data (JSON-serialisable). Values that come from
 * scanned repos or remote registries are untrusted: never eval them, never
 * pass them to a shell, and escape them when rendering.
 */

// ---------------------------------------------------------------------------
// Package URLs (purl) — https://github.com/package-url/purl-spec
// ---------------------------------------------------------------------------

/** Ecosystems we model. Phase 1 scores npm only; the others are inventory-only. */
import type { AgentFactValue, AgenticReport } from './agentic-types.js';
import { componentScopes, countScopes, type ComponentScope } from './scope.js';
export type * from './agentic-types.js';
export type { ComponentScope } from './scope.js';

export type Ecosystem = 'npm' | 'pypi' | 'githubactions' | 'docker' | 'generic';

export interface Purl {
  /** purl type, e.g. "npm", "githubactions", "docker", "generic". */
  type: string;
  /** Decoded namespace, e.g. "@babel" for scoped npm packages, "actions" for actions/checkout. */
  namespace?: string;
  /** Decoded name, e.g. "core". */
  name: string;
  /** Decoded version, e.g. "7.24.0". Absent for an unversioned purl. */
  version?: string;
  qualifiers?: Record<string, string>;
  subpath?: string;
}

/** A purl string, e.g. "pkg:npm/%40babel/core@7.24.0". Alias for readability. */
export type PurlString = string;

export class PurlParseError extends Error {
  constructor(input: string, reason: string) {
    super(`Invalid purl "${truncate(input, 200)}": ${reason}`);
    this.name = 'PurlParseError';
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Percent-encode a purl segment (keeps the characters purl-spec allows unescaped). */
function encodeSegment(s: string): string {
  return encodeURIComponent(s).replace(/%3A/gi, ':');
}

function decodeSegment(s: string, input: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new PurlParseError(input, `bad percent-encoding in "${truncate(s, 50)}"`);
  }
}

/**
 * Parse a purl string. Throws PurlParseError on malformed input.
 * Normalises: type lower-cased; npm namespace/name lower-cased (npm names are
 * case-insensitive for new packages and lower-case by registry rule).
 */
export function parsePurl(input: string): Purl {
  if (typeof input !== 'string' || input.length === 0) throw new PurlParseError(String(input), 'empty');
  if (input.length > 2048) throw new PurlParseError(input, 'too long');
  if (!input.startsWith('pkg:')) throw new PurlParseError(input, 'must start with "pkg:"');

  let rest = input.slice(4).replace(/^\/+/, '');

  let subpath: string | undefined;
  const hashIdx = rest.indexOf('#');
  if (hashIdx >= 0) {
    subpath = rest
      .slice(hashIdx + 1)
      .split('/')
      .filter((p) => p && p !== '.' && p !== '..')
      .map((p) => decodeSegment(p, input))
      .join('/');
    rest = rest.slice(0, hashIdx);
  }

  let qualifiers: Record<string, string> | undefined;
  const qIdx = rest.indexOf('?');
  if (qIdx >= 0) {
    qualifiers = {};
    for (const pair of rest.slice(qIdx + 1).split('&')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      if (eq <= 0) throw new PurlParseError(input, `bad qualifier "${truncate(pair, 50)}"`);
      const key = pair.slice(0, eq).toLowerCase();
      const value = decodeSegment(pair.slice(eq + 1), input);
      if (value) qualifiers[key] = value;
    }
    rest = rest.slice(0, qIdx);
  }

  let version: string | undefined;
  // The version separator is the last "@" that is not the first char of a segment
  // (an npm scope "%40scope" is normally encoded, but tolerate a raw "@scope").
  const atIdx = rest.lastIndexOf('@');
  if (atIdx > 0 && rest[atIdx - 1] !== '/') {
    version = decodeSegment(rest.slice(atIdx + 1), input);
    rest = rest.slice(0, atIdx);
    if (!version) throw new PurlParseError(input, 'empty version');
  }

  const parts = rest.split('/').filter((p) => p.length > 0);
  if (parts.length < 2) throw new PurlParseError(input, 'missing type or name');
  const type = parts[0]!.toLowerCase();
  if (!/^[a-z.+-][a-z0-9.+-]*$/.test(type)) throw new PurlParseError(input, `bad type "${type}"`);
  let name = decodeSegment(parts[parts.length - 1]!, input);
  const nsParts = parts.slice(1, -1).map((p) => decodeSegment(p, input));
  let namespace = nsParts.length > 0 ? nsParts.join('/') : undefined;
  if (!name) throw new PurlParseError(input, 'empty name');

  if (type === 'npm') {
    name = name.toLowerCase();
    namespace = namespace?.toLowerCase();
  }

  const purl: Purl = { type, name };
  if (namespace !== undefined) purl.namespace = namespace;
  if (version !== undefined) purl.version = version;
  if (qualifiers && Object.keys(qualifiers).length > 0) purl.qualifiers = qualifiers;
  if (subpath) purl.subpath = subpath;
  return purl;
}

/** Format a Purl into its canonical string form (qualifiers sorted). */
export function formatPurl(p: Purl): PurlString {
  let out = `pkg:${p.type.toLowerCase()}/`;
  if (p.namespace) out += p.namespace.split('/').map(encodeSegment).join('/') + '/';
  out += encodeSegment(p.name);
  if (p.version) out += `@${encodeSegment(p.version)}`;
  const q = p.qualifiers ? Object.entries(p.qualifiers).filter(([, v]) => v !== '') : [];
  if (q.length > 0) {
    q.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    out += '?' + q.map(([k, v]) => `${k.toLowerCase()}=${encodeSegment(v)}`).join('&');
  }
  if (p.subpath) out += '#' + p.subpath.split('/').map(encodeSegment).join('/');
  return out;
}

/** Re-format a purl string canonically (e.g. "pkg:npm/@Babel/Core@1" → "pkg:npm/%40babel/core@1"). */
export function normalizePurl(input: string): PurlString {
  return formatPurl(parsePurl(input));
}

/**
 * Build an npm purl from a package name as written in package.json / lockfiles
 * ("lodash", "@babel/core") and an optional version.
 */
export function npmPurl(packageName: string, version?: string): PurlString {
  const { namespace, name } = splitNpmName(packageName);
  const p: Purl = { type: 'npm', name };
  if (namespace) p.namespace = namespace;
  if (version) p.version = version;
  return formatPurl(p);
}

/** Split "@scope/name" into { namespace: "@scope", name: "name" }. Lower-cases. */
export function splitNpmName(packageName: string): { namespace?: string; name: string } {
  const n = packageName.trim().toLowerCase();
  if (n.startsWith('@')) {
    const slash = n.indexOf('/');
    if (slash > 1 && slash < n.length - 1) return { namespace: n.slice(0, slash), name: n.slice(slash + 1) };
  }
  return { name: n };
}

/** The npm package name ("@scope/name" or "name") for an npm purl. */
export function npmNameFromPurl(purl: PurlString | Purl): string {
  const p = typeof purl === 'string' ? parsePurl(purl) : purl;
  return p.namespace ? `${p.namespace}/${p.name}` : p.name;
}

/** Strip version/qualifiers/subpath: "pkg:npm/x@1.0.0" → "pkg:npm/x". */
export function unversionedPurl(purl: PurlString): PurlString {
  const p = parsePurl(purl);
  const out: Purl = { type: p.type, name: p.name };
  if (p.namespace) out.namespace = p.namespace;
  return formatPurl(out);
}

// ---------------------------------------------------------------------------
// Inventory (ingest output)
// ---------------------------------------------------------------------------

export type AssetKind = 'repo' | 'workflow' | 'image';
export type Environment = 'prod' | 'staging' | 'dev' | 'ci';
/** 1 = lowest, 5 = most critical. */
export type Criticality = 1 | 2 | 3 | 4 | 5;

/** Something we own and care about: a repo, a CI workflow, a container image. */
export interface Asset {
  /** Stable id, e.g. "repo:my-app", "workflow:.github/workflows/release.yml", "image:Dockerfile". */
  id: string;
  kind: AssetKind;
  name: string;
  environment: Environment;
  criticality: Criticality;
  /** Path (relative to the scan target root) of the file this asset was derived from. */
  sourceFile: string;
  /**
   * Optional CI context, set for kind "workflow". Used for reach_multiplier (PLAN §3.6 step 4).
   */
  ci?: {
    /** Workflow requests write permissions / `id-token: write` / uses publish secrets. */
    hasWriteTokens?: boolean;
    hasOidc?: boolean;
    publishes?: boolean;
  };
}

/** A third-party package version (or action / image) found in the inventory. */
export interface Component {
  /** Versioned purl, canonical form (formatPurl). Unique within an Inventory. */
  purl: PurlString;
  ecosystem: Ecosystem;
  /** Display name: npm "@scope/name", action "owner/repo", image "library/node". */
  name: string;
  /** Exact resolved version, or the ref/tag/sha for actions and images. */
  version: string;
  /** npm: lockfile `hasInstallScript` or manifest has preinstall/install/postinstall. */
  hasInstallScript?: boolean;
  /** Tarball/source URL as recorded in the lockfile. Untrusted. */
  resolved?: string;
  /** SRI integrity string as recorded in the lockfile. */
  integrity?: string;
  /** For actions/images: how the reference is pinned. */
  pinning?: 'sha' | 'tag' | 'branch' | 'digest' | 'unpinned';
  /**
   * Licence strings declared in the scanned files themselves: the `license` field npm copies into
   * package-lock.json entries, or an imported SBOM's `licenses`. Untrusted, capped; normalised
   * by the licences enricher (source "lockfile" / "sbom").
   */
  declaredLicenses?: { values: string[]; via: 'lockfile' | 'sbom' };
}

export type DepScope = 'runtime' | 'dev' | 'optional' | 'peer' | 'build';

/** A dependency edge. `from` is an Asset.id or a Component.purl; `to` is a Component.purl. */
export interface DepEdge {
  from: string;
  to: PurlString;
  scope: DepScope;
  /** True when `from` is an asset (declared directly in the manifest/workflow). */
  direct: boolean;
}

export interface Inventory {
  assets: Asset[];
  components: Component[];
  edges: DepEdge[];
}

export interface InventorySummary {
  assets: number;
  components: number;
  edges: number;
  /** Components with at least one direct edge from an asset. */
  directComponents: number;
  byEcosystem: Partial<Record<Ecosystem, number>>;
  /** Number of edges per scope. */
  byScope: Partial<Record<DepScope, number>>;
  withInstallScripts: number;
  /**
   * Components per project scope (src/core/scope.ts: runtime, peer, optional, ci, dev, unreachable).
   * Absent on scans made before Tier 0.
   */
  byComponentScope?: Partial<Record<ComponentScope, number>>;
}

export function summarizeInventory(inv: Inventory): InventorySummary {
  const byEcosystem: Partial<Record<Ecosystem, number>> = {};
  for (const c of inv.components) byEcosystem[c.ecosystem] = (byEcosystem[c.ecosystem] ?? 0) + 1;
  const byScope: Partial<Record<DepScope, number>> = {};
  const direct = new Set<string>();
  for (const e of inv.edges) {
    byScope[e.scope] = (byScope[e.scope] ?? 0) + 1;
    if (e.direct) direct.add(e.to);
  }
  return {
    assets: inv.assets.length,
    components: inv.components.length,
    edges: inv.edges.length,
    directComponents: direct.size,
    byEcosystem,
    byScope,
    withInstallScripts: inv.components.filter((c) => c.hasInstallScript === true).length,
    byComponentScope: countScopes(componentScopes(inv)),
  };
}

// ---------------------------------------------------------------------------
// Facts (enrichment output)
// ---------------------------------------------------------------------------

export const FACT_KINDS = [
  'vuln',
  'malware',
  'scorecard',
  'provenance',
  'dependents',
  'maintainers',
  'publisher',
  'publisher_change',
  'maintainer_change',
  'install_script',
  'repo',
  'repo_owner',
  'repo_transfer',
  'funding',
  'archived',
  'release_age',
  'dependency_added',
  // docs/WHO-BEHIND-PLAN.md P0: licences (P1), git history (P2), stability (P3), funding (P4), orgs (P7).
  'license',
  'license_change',
  'contributors',
  'commit_history',
  'release_cadence',
  'release_publishers',
  'declared_status',
  'package_size',
  'funding_detail',
  'org_profile',
  // Agentic gap-filler (src/agentic): verified facts proposed by a model, source `agent:<task>`.
  'agent_fact',
] as const;

export type FactKind = (typeof FACT_KINDS)[number];

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'unknown';

export interface VulnValue {
  /** OSV id, e.g. "GHSA-xxxx-xxxx-xxxx" or "CVE-2021-1234". */
  id: string;
  aliases: string[];
  summary?: string;
  severity: Severity;
  /** CVSS base score 0–10 when known. */
  cvss?: number;
  /** CVSS vector string when known. */
  cvssVector?: string;
  /** EPSS probability 0–1 when known. */
  epss?: number;
  /** Listed in CISA KEV. */
  kev?: boolean;
  /** Versions that fix it (from OSV ranges "fixed" events). */
  fixedVersions: string[];
  /** Advisory URL. */
  url?: string;
  /** ISO timestamp the advisory was first published (lets backtests ignore later advisories). */
  published?: string;
}

export interface MalwareValue {
  /** e.g. "MAL-2022-1234" (OSV) or "INC-2018-0001" (incident KB). */
  id: string;
  summary?: string;
  origin: 'osv' | 'incident' | 'other';
  url?: string;
  /** ISO timestamp the advisory / incident was first published, when known. */
  published?: string;
}

export interface ScorecardValue {
  /** Aggregate OpenSSF Scorecard score 0–10. */
  score: number;
  /** ISO date of the scorecard run. */
  date?: string;
  /** Repo the score applies to, e.g. "github.com/owner/repo". */
  repo: string;
  checks: { name: string; score: number; reason?: string }[];
}

export interface ProvenanceValue {
  /** True when the version has a verifiable build attestation. */
  hasProvenance: boolean;
  /** e.g. "slsa-v1", "npm-attestation", "sigstore". */
  type?: string;
  /** Source repo the attestation names, if any. */
  sourceRepo?: string;
  url?: string;
  /**
   * Set when this version has no provenance but the release it follows did: a release made
   * outside the usual pipeline (the nx and eslint-config-prettier attacks used stolen tokens).
   */
  droppedSince?: string;
}

export interface DependentsValue {
  /** Total number of packages depending on this package (all versions). */
  count: number;
  /** Direct dependents only, when the source distinguishes. */
  direct?: number;
  indirect?: number;
}

export interface Maintainer {
  /** Registry account handle (npm username). */
  name: string;
  /** Only stored if public in registry metadata. */
  email?: string;
}

export interface MaintainersValue {
  maintainers: Maintainer[];
  count: number;
  /** Maintainers that are organisation release bots (src/history/bots.ts), e.g. google-wombot (Tier 0). */
  releaseBots?: number;
}

export interface PublisherValue {
  /** Account that published this version (npm `_npmUser`). */
  name: string;
  email?: string;
  version: string;
  /** ISO timestamp of publication. */
  publishedAt?: string;
  /** Published with a trusted-publisher / OIDC flow (npm `trustedPublisher` / provenance). */
  trustedPublisher?: boolean;
}

export interface PublisherChangeValue {
  /** Version whose publisher differs from the previous version's publisher. */
  version: string;
  previousVersion: string;
  previousPublisher: string;
  newPublisher: string;
  /** ISO timestamp of the version publication where the change was observed. */
  changedAt: string;
  /** Whether newPublisher had ever published this package before. */
  firstTimePublisher: boolean;
}

export interface MaintainerChangeValue {
  /** Accounts added to / removed from the maintainer list. */
  added: string[];
  removed: string[];
  /** ISO timestamp when the change was observed (version publish time or snapshot time). */
  changedAt: string;
  /** Version at which the change first appears, when derived from version history. */
  version?: string;
  /** Days between the change and the next release, if known. */
  daysBeforeRelease?: number;
  /**
   * Tier 0: every added account already maintains this many sibling packages in the scan (same npm
   * scope or the same source repository). A team event, not scored.
   */
  sibling?: { packages: number; by: 'scope' | 'repository' };
}

export type InstallHook = 'preinstall' | 'install' | 'postinstall' | 'prepare';

export interface InstallScriptValue {
  hasInstallScript: boolean;
  hooks: InstallHook[];
  /** Raw script command strings, truncated to 500 chars each. Untrusted: never execute. */
  commands: Partial<Record<InstallHook, string>>;
  /** Static heuristics; names from core/install-flags.ts (e.g. "network", "credential_files"). */
  flags?: string[];
  /** Hooks this version has that the previous release (`previousVersion`) did not. */
  newHooks?: InstallHook[];
  /** The release `newHooks` was compared against. */
  previousVersion?: string;
}

export interface RepoValue {
  /** Normalised https URL, e.g. "https://github.com/owner/repo". */
  url: string;
  host: 'github' | 'gitlab' | 'bitbucket' | 'other';
  owner?: string;
  name?: string;
  /** Monorepo subdirectory. */
  directory?: string;
  /** Where the link came from: "npm.repository", "depsdev.links", "provenance". */
  via: string;
}

export interface RepoOwnerValue {
  /** "github.com/owner/repo" */
  repo: string;
  owner: string;
  ownerType: 'User' | 'Organization';
  url: string;
}

export interface RepoTransferValue {
  repo: string;
  fromOwner: string;
  toOwner: string;
  /** ISO timestamp when the move was observed (scan time). Not when it happened. */
  detectedAt: string;
  /**
   * ISO timestamp when the transfer actually happened, if a source states it. Scoring only
   * applies the recency decay to this; an undated transfer gets a small constant weight.
   */
  transferredAt?: string;
}

export interface FundingSource {
  /** e.g. "github", "open_collective", "patreon", "tidelift", "custom", "url". */
  platform: string;
  /** Account/handle on that platform, if applicable. */
  handle?: string;
  url?: string;
}

export interface FundingValue {
  sources: FundingSource[];
  /** "package.json#funding", "FUNDING.yml", "opencollective". */
  via: string;
}

export interface ArchivedValue {
  archived: boolean;
  /** Repository the flag is about, "github.com/owner/name" as declared (Tier 0: archived counts only for the current repository). */
  repo?: string;
  /** ISO timestamp of the last push / commit, if known. */
  lastPushAt?: string;
}

/** Runtime dependencies that a patch release added (none of them were in the previous release). */
export interface DependencyAddedValue {
  version: string;
  previousVersion: string;
  /** Dependency names new in `version`, sorted. */
  added: string[];
  /** When `version` was published. */
  releasedAt?: string;
  /**
   * Added dependencies that were brand new on the registry when `version` came out (first release
   * at most YOUNG_DEPENDENCY_DAYS before it, or only after it). Only these make it a risk signal:
   * a patch pulling in a well-known package is routine, one pulling in a package made last week
   * is the event-stream / node-ipc pattern. Days can be negative.
   */
  young?: { name: string; daysBeforeRelease: number; weeklyDownloads?: number }[];
}

export interface ReleaseAgeValue {
  version: string;
  /** ISO timestamp this version was published. */
  publishedAt: string;
  /** Days between publishedAt and EnrichContext.now. */
  ageDays: number;
  latestVersion?: string;
  latestPublishedAt?: string;
  /** Days between the latest release of the package and EnrichContext.now. */
  daysSinceLatestRelease?: number;
  /** Package deprecated message, if any. */
  deprecated?: string;
  /**
   * Deprecation message of the latest release (plan S3, P3). npm deprecates versions or ranges
   * (`npm deprecate`), so only a deprecated latest release says the package as a whole is.
   */
  latestDeprecated?: string;
  /** First release of the package (any version) up to the scan time (finished / low-surface test, P3). */
  firstPublishedAt?: string;
  /** Stable releases in the 365 days up to and including the latest release (release churn, P3). */
  releasesInFinalYear?: number;
  /**
   * Source repository declared by this version's package.json (`repository`, normalised), and by the
   * latest release's (Tier 0 moved-repo check): when they differ, the package moved and facts about
   * the old repository (archived, Scorecard, git history) no longer describe its upkeep.
   */
  repository?: { url: string; directory?: string };
  latestRepository?: { url: string; directory?: string };
  /**
   * Tier 0.5 (PyPI): the project status the index declares (PEP 792: archived, deprecated,
   * quarantined; "active" is not recorded), and whether this version is yanked (PEP 592), with the
   * reason when one was given (empty string: yanked without a reason).
   */
  projectStatus?: { status: 'archived' | 'deprecated' | 'quarantined'; reason?: string };
  yanked?: string;
}

/**
 * Size of a published npm version (finished / low-surface test, P3): the registry's
 * `dist.unpackedSize` and `dist.fileCount` (npm publish computes them from the tarball, npm/cli
 * lib/utils/tar.js), or the same numbers read from the version's tarball when the registry has
 * none (versions published before npm recorded them). `dependencies` counts the runtime and
 * optional dependencies the version declares.
 */
export interface PackageSizeValue {
  version: string;
  /** Sum of the sizes of the tarball's entries, in bytes. */
  unpackedSize: number;
  /** Files in the tarball. */
  fileCount: number;
  dependencies: number;
  via: 'npm.dist' | 'npm.tarball';
}

/**
 * Obligation category of a licence (docs/WHO-BEHIND-PLAN.md L4). Taken from published
 * classifications, never decided by us: Blue Oak Council's licence list (permissive) and copyleft
 * guide (weak / strong / network / maximal), then ScanCode LicenseDB categories for licences Blue
 * Oak does not cover (source-available, proprietary). See src/licenses/classify.ts.
 */
export const LICENSE_CATEGORIES = [
  'permissive',
  'weak_copyleft',
  'strong_copyleft',
  'network_copyleft',
  'source_available',
  'proprietary',
  'unknown',
] as const;
export type LicenseCategory = (typeof LICENSE_CATEGORIES)[number];

/**
 * How a declared licence string was read:
 * - `spdx`: a valid SPDX expression as declared (deprecated ids kept as written);
 * - `corrected`: not valid SPDX, mapped by spdx-correct (a guess; `raw` keeps the original);
 * - `non_standard`: no SPDX mapping (deps.dev "non-standard", or nothing we could map);
 * - `unlicensed`: npm's "UNLICENSED" (no rights granted; package.json docs);
 * - `see_file`: npm's "SEE LICENSE IN <file>" (terms only in a file we do not read);
 * - `unknown`: the source has no licence for it (empty, NOASSERTION, NONE).
 */
export type LicenseStatus = 'spdx' | 'corrected' | 'non_standard' | 'unlicensed' | 'see_file' | 'unknown';

/** Declared licence of one component version, as one source states it. */
export interface LicenseValue {
  /** Exact strings the source gave (deps.dev licenseDetails[].license, package.json `license`, SBOM). */
  raw: string[];
  /**
   * Valid SPDX expressions, one per declared licence entry, sorted. Absent for entries we could
   * not map. deps.dev: "when more than one license is listed, their relationship is unspecified".
   */
  expressions: string[];
  /** Weakest status across the entries (unknown when nothing usable was declared). */
  status: LicenseStatus;
  /** Category of the combination (entries treated as all applying when their relation is unknown). */
  category: LicenseCategory;
  /** The version the value is for. */
  version: string;
  /** spdx-correct guesses: raw string → expression. Shown as "corrected", never as declared. */
  corrected?: { from: string; to: string }[];
  /** ClearlyDefined licence score (0–100) when the source is ClearlyDefined. */
  score?: number;
  /**
   * "repository": the licence the source repository declares today (deps.dev GetProject, as
   * reported by GitHub), used for GitHub Actions, which have no package metadata. Not per version.
   */
  basis?: 'repository';
}

/** The declared licence changed between two releases of a package (version order). */
export interface LicenseChangeValue {
  /**
   * First release known to carry the new licence. When `unknownBetween` > 0 the change is a
   * range: it happened at some release after `previousVersion`, up to and including this one.
   */
  version: string;
  /** Last release known to carry the old licence (releases without licence data are skipped). */
  previousVersion: string;
  /**
   * Before and after, sorted: normalised SPDX expressions, or the author's strings when they have
   * no SPDX form (then the matching status is non_standard).
   */
  from: string[];
  to: string[];
  fromStatus: LicenseStatus;
  toStatus: LicenseStatus;
  fromCategory: LicenseCategory;
  toCategory: LicenseCategory;
  /** SPDX ids added / removed by the change. */
  added: string[];
  removed: string[];
  /** Publication time of `version` (ISO), when known. */
  date?: string;
  /** Releases between the two with no licence data from any source (the change is a range). */
  unknownBetween?: number;
  /**
   * Sources of the before / after values, set when one of them is not the primary source
   * (e.g. "registry": the package registry's own metadata filled a deps.dev gap).
   */
  fromSource?: string;
  toSource?: string;
  /** How the primary source alone places this change, when gap filling placed it more precisely. */
  primary?: { source: string; previousVersion: string; version: string; unknownBetween?: number };
}

/** Contributor concentration from git history (plan S2; produced in P2). */
export interface ContributorsValue {
  /** Window the numbers cover (ISO dates). */
  from: string;
  to: string;
  commits: number;
  /** CHAOSS Contributor Absence Factor at 50 %. */
  absenceFactor: number;
  /** Largest shares, ids are GitHub logins or `hash:<salted hash>`; never clear-text emails. */
  top: { id: string; share: number }[];
  /** Commits whose author could not be mapped to a login. */
  unmapped: number;
  /** Distinct contributors in the window (bots excluded). */
  contributors?: number;
  /** CAF over the whole default-branch history, for context. */
  allHistory?: { from: string; commits: number; absenceFactor: number; contributors: number };
}

/**
 * Repo-level aggregates of default-branch history (plan C1, C2, C3, S3 activity; produced in P2).
 *
 * Privacy (plan §5): per-person data is limited to `people` (counts and first/last-seen dates);
 * time zones exist only as repo-level histograms per window, never per person; emails never
 * appear (ids are GitHub logins or `hash:` salted hashes).
 */
export interface CommitHistoryValue {
  /** Repository the history was read from (https URL). */
  repo: string;
  /** Default-branch head commit at collection time. */
  head: string;
  /** Reference time the windows end at (ISO). */
  asOf: string;
  firstCommit: string;
  lastCommit: string;
  commits: number;
  /** 12-month windows ending at asOf, newest first. */
  windows: CommitHistoryWindow[];
  /** Neutral, factual changes between windows and release continuity observations. */
  changes: CommitHistoryChange[];
  /** Per-person counts (no time zone, no hour, no email): CAF set, release taggers, top contributors. */
  people: HistoryPerson[];
  /** Days since the last commit at asOf, and the longest gap between commits in the last 24 months. */
  daysSinceLastCommit: number;
  longestGapDays24m: number;
  /**
   * Tier 0.5: the history was read from a shallow clone starting at this date (YYYY-MM-DD);
   * first-seen dates in its first two years mean "on or before".
   */
  readFrom?: string;
  /** GitHub's signature verification for the latest commits (GraphQL), when it was queried. */
  verified?: { checked: number; verified: number };
  /** How identities were resolved. */
  identity: {
    mapped: number;
    hashed: number;
    via: string[];
    /**
     * Tier 0: identities were resolved (display names compared, or GitHub logins mapped). Without it
     * the git-only continuity signals (S5a git side, C1) are context, never a label rule.
     */
    resolved?: boolean;
    /** Ids merged into another one by display name plus overlapping activity, and by npm publisher. */
    merged?: { displayName: number; npmPublisher: number };
  };
  /** CAF over the 24 months up to the last commit (P3: the CAF of the last active period). */
  cafAtLastCommit?: { from: string; to: string; commits: number; absenceFactor: number };
  /**
   * S5a npm side (P3): npm accounts that published releases, and how many of them could be matched
   * to this history (registry e-mail address hashed like commit e-mails, or a no-reply login).
   */
  npmPublishers?: { total: number; matched: number };
}

export interface CommitHistoryWindow {
  from: string;
  to: string;
  commits: number;
  contributors: number;
  absenceFactor: number;
  /** CHAOSS Occasional Contributors with "minimum contributions" = 3: people with 1–2 commits in the window. */
  occasional: number;
  regular: number;
  /** Share of commits by people first seen ≥ 2 years before the window end (C1). */
  longStandingShare: number;
  /** Share of commits by people first seen inside the window. */
  newShare: number;
  /** Share of commits with a signature header (gpgsig / gpgsig-sha256) (C2). */
  signedShare: number;
  releases: number;
  /** Share of releases in the window made by long-standing people (null without releases). */
  releasesByLongStandingShare: number | null;
  signedReleaseShare: number | null;
  /** Whether the top committer of the window was first seen less than 36 months before its end. */
  topCommitterFirstSeenRecently: boolean;
  /** Repo-level time-zone aggregate (C3); absent below the k-anonymity floor. */
  timeZones?: RepoTimeZones;
  /** Why timeZones is absent. */
  timeZonesWithheld?: 'below_floor';
}

/** Repo-level only: commit counts per recorded UTC offset and per UTC hour of week. */
export interface RepoTimeZones {
  /** UTC offset as git records it ("+0300") → commits. */
  offsets: Record<string, number>;
  /** 168 counts, Monday 00:00 UTC first. */
  hourOfWeekUtc: number[];
}

export type CommitHistoryChangeKind =
  | 'contributor_base_changed'
  | 'top_committer_new'
  /** The window's top committer is a recent account and also made most of the window's releases (the xz pattern, plan §8 row 2). */
  | 'release_takeover'
  | 'release_by_new_person'
  | 'release_handover'
  | 'signed_share_changed'
  | 'time_zone_pattern_changed'
  /** S5a, npm side (P3): a release published on npm by an account first seen in the repository < 180 days earlier. */
  | 'npm_release_by_new_account';

export interface CommitHistoryChange {
  kind: CommitHistoryChangeKind;
  /** When it shows (window end, release date). */
  date: string;
  /** Plain-language statement with fixed wording; never about intent. */
  text: string;
  /** Numbers behind the statement. */
  before?: number;
  after?: number;
  /** For release observations: the release and days between the releaser's first commit and it. */
  release?: string;
  daysSinceFirstSeen?: number;
}

/** ScanResult.history: one entry per source repository read. */
export interface HistoryReport {
  repos: HistoryReportRepo[];
}

export interface HistoryReportRepo {
  repo: string;
  /** Packages (unversioned purls) that declare this repository. */
  packages: PurlString[];
  contributors: ContributorsValue;
  history: CommitHistoryValue;
  fetchedAt: string;
}

/** One contributor's per-repo counts. Deliberately no location, time-zone or hour fields. */
export interface HistoryPerson {
  /** GitHub login or `hash:<salted hash>`. */
  id: string;
  firstSeen: string;
  lastSeen: string;
  commits: number;
  commits24m: number;
  releases: number;
}

/** Release regularity from registry publish times (plan S4; produced in P3). */
export interface ReleaseCadenceValue {
  /** Releases the numbers are computed over (the last N stable releases, N ≤ 10). */
  releases: number;
  /** Median days between consecutive releases among them. */
  medianDays: number;
  /** Coefficient of variation of the gaps (population standard deviation / mean). */
  cv: number;
  /** Days between the two most recent releases. */
  latestGapDays: number;
  /** CV > 1.5 and latest gap > 3 × median (STABILITY_RULES). */
  irregular: boolean;
  /** Release dates (YYYY-MM-DD) the numbers are computed over, oldest first. */
  dates?: string[];
  /** Stable releases up to the scan time, and the latest one. */
  totalReleases?: number;
  lastRelease?: { version: string; date: string };
  /** Days from the latest release (any, including pre-releases) to the scan time. */
  daysSinceLastRelease?: number;
}

/**
 * Who published the releases of an npm package (`_npmUser`), per account: its first release and
 * how many it published (plan S5a input; produced in P3). npm handles are public account ids.
 * Read only by the history aggregate, which turns them into repo-level observations; the
 * stability labels never read this fact (src/stability/signals.ts, guarded by a test).
 */
export interface ReleasePublishersValue {
  /** Releases with a time entry up to the scan time (pre-releases included). */
  releases: number;
  accounts: {
    name: string;
    firstVersion: string;
    firstAt: string;
    /** Position of the first release by this account in the release order (0 = the first release). */
    index: number;
    releases: number;
    /** Published through npm trusted publishing (an OIDC CI identity, not a person's account). */
    trusted: boolean;
    /**
     * The account's first stable (non-prerelease) release, its date and position (Tier 0.5): a
     * pre-release-only account says nothing about the stable line in use. Absent when the account
     * published only pre-releases.
     */
    firstStableVersion?: string;
    firstStableAt?: string;
    firstStableIndex?: number;
  }[];
  /**
   * Stable versions published through npm trusted publishing (an OIDC CI identity), newest last, at
   * most 500 (Tier 0): a git-side release observation for one of them is not a person's release.
   */
  trustedVersions?: string[];
  /**
   * The npm account that published each version of the last 36 months (at most 500), so a
   * git-side release observation can be checked against who actually published it (Tier 0).
   * PyPI (Tier 0.5): every version of the window maps to "" (published; the uploader is not public).
   */
  publisherByVersion?: Record<string, string>;
  /** Earliest publish date (YYYY-MM-DD) covered by `publisherByVersion`: before it, a missing version proves nothing. */
  publisherSince?: string;
}

/** A maintenance status the package itself declares (README; plan S3). Low confidence by definition. */
export interface DeclaredStatusValue {
  status: 'deprecated' | 'unmaintained' | 'maintenance_mode';
  /** The matched sentence, verbatim (≤ 200 characters). */
  phrase: string;
  /** npm README, or the PyPI "Development Status :: 7 - Inactive" classifier (Tier 0.5). */
  via: 'npm.readme' | 'pypi.classifier';
}

/** Money received through a funding platform with public books (plan F2/F3; produced in P4). */
export interface FundingDetailValue {
  platform: 'open_collective';
  slug: string;
  currency: string;
  last12Months: number;
  previous12Months: number;
  /** Share of the last 12 months from the largest organisational funder (0–1). */
  topShare?: number;
  fundersOver5Percent?: number;
  trend: 'growing' | 'flat' | 'declining' | 'stopped' | 'unknown';
}

/** Facts an organisation declares about itself (plan C4; produced in P7). Never about a person. */
export interface OrgProfileValue {
  /** Entity id, e.g. "org:github/hashicorp" or "funder:opencollective/babel". */
  entity: string;
  name?: string;
  legalName?: string;
  /** Self-declared location string, shown as declared, never parsed into a country. */
  location?: string;
  /** Where it came from: "github.org", "opencollective.account", "companies-house". */
  via: string;
}

/** Value shape for each Fact kind. */
export interface FactValueMap {
  vuln: VulnValue;
  malware: MalwareValue;
  scorecard: ScorecardValue;
  provenance: ProvenanceValue;
  dependents: DependentsValue;
  maintainers: MaintainersValue;
  publisher: PublisherValue;
  publisher_change: PublisherChangeValue;
  maintainer_change: MaintainerChangeValue;
  install_script: InstallScriptValue;
  repo: RepoValue;
  repo_owner: RepoOwnerValue;
  repo_transfer: RepoTransferValue;
  funding: FundingValue;
  archived: ArchivedValue;
  release_age: ReleaseAgeValue;
  dependency_added: DependencyAddedValue;
  license: LicenseValue;
  license_change: LicenseChangeValue;
  contributors: ContributorsValue;
  commit_history: CommitHistoryValue;
  release_cadence: ReleaseCadenceValue;
  release_publishers: ReleasePublishersValue;
  declared_status: DeclaredStatusValue;
  package_size: PackageSizeValue;
  funding_detail: FundingDetailValue;
  org_profile: OrgProfileValue;
  agent_fact: AgentFactValue;
}

/** A fact of one specific kind. */
export interface TypedFact<K extends FactKind> {
  /**
   * The thing the fact is about. A Component.purl (versioned) for
   * version-specific facts, or the unversioned purl for package-level facts
   * (maintainers, dependents, repo, ...). Use `factsFor()` to match both.
   */
  subject: PurlString;
  kind: K;
  value: FactValueMap[K];
  /** Producer id, e.g. "osv", "depsdev", "npm", "github", "scorecard", "kb". */
  source: string;
  /** ISO timestamp when the data was fetched (or the fixture recorded). */
  fetchedAt: string;
  /** Public URLs supporting the fact. */
  evidence?: string[];
}

/** A fact of any kind — a discriminated union on `kind`. */
export type Fact = { [K in FactKind]: TypedFact<K> }[FactKind];

export function makeFact<K extends FactKind>(
  kind: K,
  subject: PurlString,
  value: FactValueMap[K],
  meta: { source: string; fetchedAt: string | Date; evidence?: string[] },
): TypedFact<K> {
  const f: TypedFact<K> = {
    subject,
    kind,
    value,
    source: meta.source,
    fetchedAt: typeof meta.fetchedAt === 'string' ? meta.fetchedAt : meta.fetchedAt.toISOString(),
  };
  if (meta.evidence && meta.evidence.length > 0) f.evidence = meta.evidence;
  return f;
}

export function isFactKind(k: string): k is FactKind {
  return (FACT_KINDS as readonly string[]).includes(k);
}

/** Narrowing filter: `facts.filter(isFactOf('vuln'))`. */
export function isFactOf<K extends FactKind>(kind: K): (f: Fact) => f is Extract<Fact, { kind: K }> {
  return (f: Fact): f is Extract<Fact, { kind: K }> => f.kind === kind;
}

/**
 * All facts about a component: those whose subject equals the versioned purl
 * or its unversioned form. Optionally filtered by kind.
 */
export function factsFor<K extends FactKind>(facts: readonly Fact[], purl: PurlString, kind: K): Extract<Fact, { kind: K }>[];
export function factsFor(facts: readonly Fact[], purl: PurlString): Fact[];
export function factsFor(facts: readonly Fact[], purl: PurlString, kind?: FactKind): Fact[] {
  let base: string;
  try {
    base = unversionedPurl(purl);
  } catch {
    base = purl;
  }
  return facts.filter((f) => (f.subject === purl || f.subject === base) && (kind === undefined || f.kind === kind));
}

// ---------------------------------------------------------------------------
// Entities (PLAN §3.3)
// ---------------------------------------------------------------------------

/**
 * - `owner`: a repository owner whose account type (user or organisation) is not known, e.g. after
 *   a GitHub 403. Never treated as an org: excluded from every org rule, roll-up, policy and
 *   jurisdiction check.
 * - `funding`: a payable funding page the package or repository itself names (FUNDING.yml or
 *   package.json#funding), e.g. an Open Collective collective. It says where money can be sent, not
 *   who sends it.
 */
export type EntityType = 'person' | 'org' | 'funder' | 'account' | 'owner' | 'funding';

/**
 * Entity ids are namespaced strings:
 *   account:npm/<handle>, account:github/<login>, org:github/<login>, owner:github/<login> (type
 *   unknown), person:<slug>, funding:<platform>/<handle>, funder:opencollective/<slug> (legacy),
 *   repo:github/<owner>/<name>
 */
export interface Entity {
  id: string;
  type: EntityType;
  name: string;
}

/**
 * `receives_funding_at` runs from a package to the funding page it names (neutral: where money can
 * be sent). `funds` (who pays whom) is no longer produced until funding direction is modelled (P4);
 * it stays in the union so stored data and review files still parse.
 */
export type EntityRelation = 'maintains' | 'publishes' | 'owns' | 'funds' | 'receives_funding_at' | 'member_of' | 'linked_to';

/**
 * How a link was established: `deterministic` (a registry or repository field read as-is),
 * `probabilistic` (a heuristic match), or `agent:<task>` (proposed by the agentic gap-filler and
 * verified against its source).
 */
export type LinkMethod = 'deterministic' | 'probabilistic' | `agent:${string}`;

/** Directed edge. `from`/`to` are Entity ids or component purls (unversioned). */
export interface EntityLink {
  from: string;
  to: string;
  relation: EntityRelation;
  /** 0–1. Probabilistic links < 0.8 must be reviewed before they affect scores. */
  confidence: number;
  /** Public URLs. At least one is required (PLAN §7). */
  evidence: string[];
  /** How a machine established the link. Says nothing about human review. */
  method: LinkMethod;
  /**
   * True only after a human decision: a `--review` file entry or an API review decision accepted
   * the link. Machine-derived links (any `method`) are always false.
   */
  reviewed: boolean;
}

// ---------------------------------------------------------------------------
// Incidents (PLAN §3.4)
// ---------------------------------------------------------------------------

export const INCIDENT_TYPES = [
  'malware_publish',
  'account_takeover',
  'maintainer_sabotage',
  'maintainer_infiltration',
  'malicious_handover',
  'ci_compromise',
  'domain_or_name_takeover',
  'typosquat',
  'abandonment',
  'crypto_rugpull',
  'sanctions',
] as const;
export type IncidentType = (typeof INCIDENT_TYPES)[number];

export type IncidentStatus = 'confirmed' | 'alleged' | 'disputed' | 'retracted';
export type IncidentSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface Incident {
  /** e.g. "INC-2018-0001" */
  id: string;
  title: string;
  type: IncidentType;
  status: IncidentStatus;
  /** ISO date (YYYY-MM-DD). */
  date: string;
  severity: IncidentSeverity;
  /** `purl` is unversioned; `versions` lists exact affected versions ("*" = all). */
  affected: { purl: PurlString; versions: string[] }[];
  /**
   * `ref` is an Entity id (e.g. "account:npm/right9ctrl"). `role` is factual, e.g.
   * "publisher_of_affected_version", "compromised_account", "maintainer".
   */
  entities: { ref: string; role: string; confidence: number }[];
  /** Public source URLs; at least one required. */
  evidence: string[];
  reviewed_by?: string[];
}

// ---------------------------------------------------------------------------
// Scoring & findings (PLAN §3.6)
// ---------------------------------------------------------------------------

export type RiskLevel = 'critical' | 'high' | 'medium' | 'low';

/** Score thresholds (inclusive lower bounds) on the 0–100 scale. */
export const LEVEL_THRESHOLDS = { critical: 80, high: 60, medium: 30 } as const;

/** critical ≥80, high 60–79, medium 30–59, low <30. */
export function levelForScore(score: number): RiskLevel {
  if (score >= LEVEL_THRESHOLDS.critical) return 'critical';
  if (score >= LEVEL_THRESHOLDS.high) return 'high';
  if (score >= LEVEL_THRESHOLDS.medium) return 'medium';
  return 'low';
}

/** One explainable contribution to a score. */
export interface Reason {
  /** Factor id, e.g. "malware", "vuln", "maintainer_change", "install_script", "weak_posture", "no_provenance", "single_maintainer", "abandoned", "entity_incident". */
  factor: string;
  /** Normalised factor value fᵢ in 0–1. */
  value: number;
  /** Weight wᵢ. */
  weight: number;
  /** Marginal contribution to the 0–1 risk (for display; contributions need not sum exactly due to noisy-OR). */
  contribution: number;
  /** Human-readable, factual explanation. Never a judgement about people. */
  detail: string;
  evidence: string[];
}

export interface AssetExposure {
  assetId: string;
  /** Exposure multiplier from the scope of the path (PLAN §3.6 step 4). */
  exposure: number;
  /**
   * Dependency paths from the asset to the component; each path is [assetId, purl, ..., purl].
   * The strongest path (runtime before optional, peer, CI and dev) comes first.
   */
  paths: string[][];
  /** Scope of this asset's best path to the component (src/core/scope.ts). Absent before Tier 0. */
  scope?: ComponentScope;
  /** Scope of each entry of `paths`, same order. Absent before Tier 0. */
  pathScopes?: ComponentScope[];
}

/**
 * Why the exposure gate placed a finding where it is (docs/WHO-BEHIND-PLAN.md, Tier 0): a runtime
 * advisory with CVSS >= 9 and a fix is raised to critical; dev-only and CI-only items are capped
 * below high; posture signals only break ties.
 */
export interface FindingGate {
  /** 'runtime_critical_fix' | 'non_runtime_cap' | 'install_time' | 'runtime' | 'optional' ... */
  rule: string;
  /** One plain sentence shown with the finding. */
  detail: string;
  /** Score before the gate (signals only, 0–100). */
  signalScore: number;
}

export interface Finding {
  /** Versioned component purl. */
  purl: PurlString;
  /** Combined risk on a 0–100 scale. */
  score: number;
  level: RiskLevel;
  /**
   * The component's one scope in this project (src/core/scope.ts). Findings are ordered
   * production first: runtime, then peer, optional, CI and dev. Absent on scans before Tier 0.
   */
  scope?: ComponentScope;
  /** How exposure shaped the score and rank. Absent on scans before Tier 0. */
  gate?: FindingGate;
  reasons: Reason[];
  blastRadius: {
    assets: AssetExposure[];
    /** Inbound blast radius score (unbounded; larger = more exposure). */
    score: number;
  };
  /**
   * Chain from the component through entities to an incident, if any. Each entry is one link
   * `from` → `entityId`; the first entry starts at the component's unversioned purl and the last
   * one ends at the incident id. A confirmed incident naming this exact version (the malware
   * override) is a single hop from the purl to the incident.
   */
  entityChain: EntityChainEntry[];
  /**
   * Who is behind the package, incident or not: its own documented links up to two hops out
   * (npm accounts and the repo owner, then the orgs they belong to and who funds them). Same entry
   * shape as `entityChain`, without the incident hop. Absent when nothing is known.
   */
  behind?: EntityChainEntry[];
}

export interface EntityChainEntry {
  /** Node this link starts at (unversioned purl or entity id). Always set by scoring. */
  from?: string;
  /** Node this link ends at: an entity id, or the incident id when relation is 'incident'. */
  entityId: string;
  relation: EntityRelation | 'incident';
  confidence: number;
  /** Public evidence URLs for this link (the incident's evidence for the incident hop). Always set by scoring. */
  evidence?: string[];
  /** How the link was established; KB incident hops are 'deterministic'. Always set by scoring. */
  method?: EntityLink['method'];
  /**
   * Whether a human reviewed the link: a review decision accepted it, or (incident hop) the KB entry
   * is a hand-curated incident. Machine-derived links are false. Always set by scoring.
   */
  reviewed?: boolean;
}

export interface OutboundFinding {
  /** Asset id of a repo/workflow we publish from. */
  assetId: string;
  score: number;
  dependents?: number;
  reasons: Reason[];
}

export interface ScanResult {
  schemaVersion: '1';
  /** What was scanned: local path or repo URL as given. */
  target: string;
  /** ISO timestamp. */
  generatedAt: string;
  inventory: InventorySummary;
  /** Sorted by score descending. */
  findings: Finding[];
  outbound?: OutboundFinding[];
  /**
   * Components whose only reasons are weak posture signals (no provenance, single maintainer,
   * weak Scorecard posture, abandoned, an undated repo move). Not findings: shown as a health
   * column so real problems are not buried (docs/DATA-ML.md, noise rule). Sorted like findings.
   */
  health?: HealthEntry[];
  /**
   * Declared licences per component, licence changes and their sources (docs/WHO-BEHIND-PLAN.md
   * L1, L2). Shown from others: no policy result is stored here, policies are applied when read.
   */
  licenses?: LicenseReport;
  /**
   * Git history aggregates per source repository (docs/WHO-BEHIND-PLAN.md S2, C1–C3), present
   * when the scan ran with history collection. Repo-level and pseudonymous by construction.
   */
  history?: HistoryReport;
  /**
   * Agentic gap-filler (--agentic): proposals, gate results and usage. Verified proposals are also
   * `agent_fact` facts; unverified ones are only here, for review.
   */
  agentic?: AgenticReport;
  /**
   * Stability labels per package (docs/WHO-BEHIND-PLAN.md §4, S3, S4, S5a; P3). Not risk: never
   * part of findings or scores. Present on scans made since P3.
   */
  stability?: StabilityReport;
  /** Non-fatal problems (enricher failures, missing fixtures in offline mode). */
  warnings?: string[];
  /**
   * Manifests and lockfiles found in the target that were NOT analysed (unsupported formats,
   * manifests without a lockfile). Never a silent all-clear: every report shows them, and
   * `--strict` fails the scan when any are present. Absent when everything found was analysed.
   */
  notAnalysed?: NotAnalysedManifest[];
  /**
   * Per-source coverage (Tier 0): whether each data source answered. A source that failed (network
   * error, 403, 429, offline miss) must never read as a clean result. Absent on older scans.
   */
  coverage?: { sources?: SourceCoverage[]; /** Older shape read by the HTML banner; the pipeline writes `notAnalysed` at the top level. */ notAnalysed?: NotAnalysedManifest[] };
}

/** How one data source (enricher) did in this scan. */
export interface SourceCoverage {
  /** Enricher name: osv, depsdev, npm, licenses, github, history, pack, agentic. */
  source: string;
  /** ok: answered without problems; partial: some lookups failed; failed: nothing usable came back. */
  status: 'ok' | 'partial' | 'failed';
  /** Security sources (vulnerabilities, malware): their failure fails `--strict`. */
  security: boolean;
  /** Facts the source produced. */
  facts: number;
  /** Problems it reported (warnings). */
  problems: number;
  /** First problem(s), plain text, when not ok. */
  reason?: string;
}

/** A manifest or lockfile the scan found but did not turn into components. */
export interface NotAnalysedManifest {
  /** Path relative to the scan root. */
  file: string;
  /** Ecosystem the file belongs to ("npm", "pypi", "go", "cargo", "maven", ...). */
  ecosystem: string;
  /** Why it was not analysed, e.g. "yarn.lock is not supported", "no lockfile". */
  reason: string;
  /** Approximate number of packages the file lists (absent when it cannot be estimated). */
  packages?: number;
}

/** A component with posture signals only (see ScanResult.health). */
export interface HealthEntry {
  purl: PurlString;
  /** What the combined posture signals would have scored (0–100), for sorting. */
  score: number;
  /** The component's scope in this project (see Finding.scope). */
  scope?: ComponentScope;
  reasons: Reason[];
  /** Who is behind the package (see Finding.behind). */
  behind?: EntityChainEntry[];
}

// ---------------------------------------------------------------------------
// Licences (docs/WHO-BEHIND-PLAN.md L1, L2, L4)
// ---------------------------------------------------------------------------

/** A customer's licence policy decision (src/licenses/policy.ts evaluates it). */
export const LICENSE_POLICY_DECISIONS = ['allow', 'review', 'deny'] as const;
export type LicensePolicyDecision = (typeof LICENSE_POLICY_DECISIONS)[number];

/**
 * Licence policy: a decision per obligation category, plus per-SPDX-id overrides. `unknown` can
 * only be review or deny. The customer's rules, not ours; not legal advice.
 */
export interface LicensePolicy {
  version: 1;
  categories: Record<LicenseCategory, LicensePolicyDecision>;
  ids: { id: string; decision: LicensePolicyDecision; note?: string }[];
}

/** One source's statement of a component's licence. */
export interface LicenseSourceValue {
  /** Fact source: "depsdev", "clearlydefined", "lockfile", "sbom". */
  source: string;
  raw: string[];
  expressions: string[];
  status: LicenseStatus;
  category: LicenseCategory;
  evidence?: string[];
  corrected?: { from: string; to: string }[];
  score?: number;
  basis?: 'repository';
}

/** The licence shown for a component, with every source that stated one. */
export interface ComponentLicense {
  /** Versioned purl. */
  purl: PurlString;
  name: string;
  version: string;
  ecosystem: Ecosystem;
  /** Chosen value (first known of: deps.dev, ClearlyDefined, lockfile, SBOM). */
  expressions: string[];
  status: LicenseStatus;
  category: LicenseCategory;
  /** Source of the chosen value; "none" when no source stated a licence. */
  source: string;
  sources: LicenseSourceValue[];
  /** Two sources state different licences. */
  disagreement: boolean;
}

/** A licence change of a package in the inventory, placed against the versions in use. */
export interface LicenseChangeEntry extends LicenseChangeValue {
  /** Unversioned purl. */
  purl: PurlString;
  name: string;
  /** Versions of the package in this inventory. */
  inUse: string[];
  /** Whether the versions in use already carry the new licence, or would on upgrade. */
  relation: 'in_use_or_earlier' | 'after_in_use' | 'mixed' | 'unknown';
  categoryChange: boolean;
  source: string;
  evidence?: string[];
}

export interface LicenseReport {
  components: ComponentLicense[];
  changes: LicenseChangeEntry[];
  /** Components per category. */
  counts: Record<LicenseCategory, number>;
  /** Classifications the categories come from (name, url, version, licence of the data). */
  classification: { name: string; url: string; version: string; license: string }[];
  note: string;
}

// ---------------------------------------------------------------------------
// Stability labels (docs/WHO-BEHIND-PLAN.md §4; P3)
// ---------------------------------------------------------------------------

export const STABILITY_LABELS = ['fragile', 'watch', 'steady', 'unknown'] as const;
export type StabilityLabel = (typeof STABILITY_LABELS)[number];

export const MAINTENANCE_STATES = ['active', 'quiet', 'inactive', 'ended', 'unknown'] as const;
export type MaintenanceState = (typeof MAINTENANCE_STATES)[number];

export type StabilityConfidence = 'high' | 'medium' | 'low';

/** One fact behind a label: what it says, where it comes from, how sure. Repo/org level only. */
export interface StabilityReason {
  /** Signal id from the plan: S1, S2, S3, S4, S5a, C1, C2, L2, F2, F3. */
  signal: string;
  /** Plain factual sentence; no names, ids or e-mails. */
  text: string;
  /** Producer: "npm", "git", "scorecard", "github", "depsdev", "npm.readme". */
  source: string;
  confidence: StabilityConfidence;
  /** Public URLs (registry page, repository, Scorecard). */
  evidence?: string[];
  /** Date the fact refers to (YYYY-MM-DD), when it has one. */
  date?: string;
}

/** A rule that decided the label, with the facts that triggered it. */
export interface StabilityRuleHit {
  /** Rule id (src/stability/rules.ts LABEL_RULES). */
  rule: string;
  /** Rule as written in the plan, e.g. "Fragile: CAF = 1 and S3 inactive". */
  name: string;
  facts: StabilityReason[];
}

/** S5a observation for the Changes page: a release made or published by a recent account. */
export interface ContinuityEvent {
  package: PurlString;
  name: string;
  kind: 'release_by_new_person' | 'npm_release_by_new_account' | 'release_takeover';
  date: string;
  release?: string;
  daysSinceFirstSeen?: number;
  text: string;
  source: 'git' | 'npm+git';
  confidence: StabilityConfidence;
  evidence?: string[];
}

export interface StabilityEntry {
  /** Unversioned purl. */
  package: PurlString;
  name: string;
  /** Versions of the package in the scanned inventory. */
  versions: string[];
  /** Reached through a runtime (non-dev) dependency path. */
  production: boolean;
  label: StabilityLabel;
  /** One factual sentence, e.g. "Single active contributor and no commit or release in 18 months." */
  summary: string;
  /** Rules that fired (empty for Steady and Unknown). */
  rules: StabilityRuleHit[];
  /** Facts shown for context that decided nothing (e.g. C1 alone, S1, S4 regular). */
  context: StabilityReason[];
  /** What is missing for a fuller label (Unknown says why). */
  missing: string[];
  s3: { state: MaintenanceState; confidence: StabilityConfidence; lastCommit?: string; lastRelease?: string; declared?: DeclaredStatusValue['status'] };
  /** S2 used by the rules: CAF and the window it covers. */
  caf?: { value: number; commits: number; from: string; to: string };
  s4?: ReleaseCadenceValue;
  s5a: ContinuityEvent[];
  /** F2/F3 are P4: always "not_assessed" until funding data exists. */
  funding: 'not_assessed';
  /**
   * Finished / low-surface test (STABILITY_RULES): `yes` when every condition holds, `no` when one
   * fails, `unknown` when an input is missing. `notMet` says which conditions failed or are unknown.
   */
  finished?: { state: 'yes' | 'no' | 'unknown'; notMet: string[]; size?: { unpackedSize: number; fileCount: number; dependencies: number } };
  /**
   * What to do, when a rule has a clear action (Tier 0), e.g. "Moved: upgrade to 9.x (repo
   * github.com/TooTallNate/proxy-agents)".
   */
  action?: string;
  /**
   * The repository the labels used (Tier 0 moved-repo check): the one the latest release declares,
   * and the earlier repositories versions in use declare when the package moved.
   */
  repo?: { current: string; directory?: string; previous?: string[] };
  /**
   * Where the upkeep facts came from (Tier 0 coverage): `git` when the git history of the current
   * repository was read; `scorecard+npm` or `npm` when it was not and the label falls back to the
   * OpenSSF Scorecard Maintained check (via deps.dev, no clone) and the npm release record;
   * `scorecard+pypi` or `pypi` the same with the PyPI release record (Tier 0.5); `none` when no
   * source was available (also for ecosystems without an upkeep source, which stay Unknown).
   */
  basis?: 'git' | 'scorecard+npm' | 'npm' | 'scorecard+pypi' | 'pypi' | 'none';
}

/**
 * One decision for a family of labelled packages (Tier 0): the direct dependency to change, and the
 * packages it brings in that share a Fragile / moved label (9 @ldapjs/* rows become one "ldapjs" row).
 */
export interface StabilityDecision {
  /** The direct dependency (name) whose change removes or fixes the family. */
  direct: string;
  /** Label of the worst member. */
  label: StabilityLabel;
  /** Packages in the family (names), the direct dependency first when it is a member. */
  packages: string[];
  /** Rules that fired across the family. */
  rules: string[];
  /** One sentence: what to do. */
  action: string;
}

/** Tier 0 coverage: how many packages have an upkeep label, from which source, and what was skipped. */
export interface StabilityCoverage {
  /** npm packages labelled (all scopes). */
  packages: number;
  /** Not Unknown. */
  assessed: number;
  byBasis: { git: number; 'scorecard+npm': number; npm: number; 'scorecard+pypi'?: number; pypi?: number };
  /**
   * Per ecosystem (Tier 0.5): packages labelled and assessed (not Unknown). Production packages of
   * ecosystems without an upkeep source (Docker images, …) are counted as Unknown here.
   */
  byEcosystem?: Record<string, { packages: number; assessed: number; production: number; productionUnknown: number }>;
  /** Packages of ecosystems that get no upkeep label outside production (e.g. GitHub Actions in CI), by ecosystem. */
  notAssessed?: Record<string, number>;
  direct: { total: number; assessed: number };
  runtimeTransitive: { total: number; assessed: number };
  production: { total: number; unknown: number };
  /** Unknown packages by reason. */
  skipped: { reason: string; count: number }[];
  /** Git history selection (absent when history collection was off). */
  history?: { declared: number; read: number; capped: number; failed: number; maxRepos: number; tooLarge?: number; budget?: { maxMb: number; perCloneMb: number; peakMb: number; evicted: number; shallowMonths: number } };
  /** "Upkeep assessed for N of M: all D direct, R runtime transitive; skipped: …". */
  line: string;
}

export interface StabilityReport {
  /** Scan time the labels are computed at. */
  asOf: string;
  /** Rule set version (bumped when STABILITY_RULES change meaning; 2 adds the finished / low-surface tier and the open-advisory rule). */
  rulesVersion: 1 | 2 | 3;
  packages: StabilityEntry[];
  counts: Record<StabilityLabel, number>;
  /** Wording shown with every label. */
  disclaimer: string;
  /** Families grouped into one decision row each (Tier 0). */
  decisions?: StabilityDecision[];
  coverage?: StabilityCoverage;
  /**
   * Git history state (web): `pending` while the background history job runs after the exposure
   * answer was stored, `done` when it ran, `off` when history collection was not asked for.
   */
  historyStatus?: 'pending' | 'done' | 'off';
}
