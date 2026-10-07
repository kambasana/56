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
export type Ecosystem = 'npm' | 'githubactions' | 'docker' | 'generic';

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
  /** ISO timestamp of the last push / commit, if known. */
  lastPushAt?: string;
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

export type EntityType = 'person' | 'org' | 'funder' | 'account';

/**
 * Entity ids are namespaced strings:
 *   account:npm/<handle>, account:github/<login>, org:github/<login>,
 *   person:<slug>, funder:opencollective/<slug>, repo:github/<owner>/<name>
 */
export interface Entity {
  id: string;
  type: EntityType;
  name: string;
}

export type EntityRelation = 'maintains' | 'publishes' | 'owns' | 'funds' | 'member_of' | 'linked_to';

/** Directed edge. `from`/`to` are Entity ids or component purls (unversioned). */
export interface EntityLink {
  from: string;
  to: string;
  relation: EntityRelation;
  /** 0–1. Probabilistic links < 0.8 must be reviewed before they affect scores. */
  confidence: number;
  /** Public URLs. At least one is required (PLAN §7). */
  evidence: string[];
  method: 'deterministic' | 'probabilistic';
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
  /** Dependency paths from the asset to the component; each path is [assetId, purl, ..., purl]. */
  paths: string[][];
}

export interface Finding {
  /** Versioned component purl. */
  purl: PurlString;
  /** Combined risk on a 0–100 scale. */
  score: number;
  level: RiskLevel;
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
  /** Whether a human reviewed the link (KB incidents are curated, so true). Always set by scoring. */
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
  /** Non-fatal problems (enricher failures, missing fixtures in offline mode). */
  warnings?: string[];
}

/** A component with posture signals only (see ScanResult.health). */
export interface HealthEntry {
  purl: PurlString;
  /** What the combined posture signals would have scored (0–100), for sorting. */
  score: number;
  reasons: Reason[];
}
