/**
 * Web API contract (docs/WEB-API.md). Every request and response body the server sends or
 * accepts is typed here. Engine types (Finding, Reason, ScanResult, ...) are reused from
 * core/types.ts, never redefined.
 *
 * Conventions:
 *   - All ids are opaque strings. All timestamps are ISO 8601 UTC strings.
 *   - List endpoints return `{ items, total, nextCursor }` (Page<T>). `nextCursor` is opaque;
 *     pass it back as `?cursor=`. `limit` defaults to 50, max 500.
 *   - Errors are always ApiError with the HTTP status from ERROR_STATUS.
 *   - Values that came from scanned repos or registries are untrusted text: render escaped.
 *
 * This file only has type imports plus a few constant tables, so the web app can import it.
 */
import type {
  AssetExposure,
  AssetKind,
  Criticality,
  Ecosystem,
  EntityChainEntry,
  EntityType,
  Environment,
  Finding,
  InventorySummary,
  OutboundFinding,
  PurlString,
  Reason,
  RiskLevel,
} from '../core/types.js';
import type {
  ActionPermission,
  BindingScope,
  BindingSubject,
  PagePermission,
  Permission,
} from './permissions.js';

export type { Permission, PagePermission, ActionPermission, BindingScope, BindingSubject };
export type Id = string;
export type IsoTime = string;

// ---------------------------------------------------------------------------
// Common
// ---------------------------------------------------------------------------

export const API_ERROR_CODES = [
  'bad_request', // 400: malformed JSON or failed validation
  'unauthenticated', // 401: no or expired session
  'forbidden', // 403: signed in, permission missing
  'csrf', // 403: mutating request without X-Requested-With (or cross-origin Origin)
  'not_found', // 404: missing, or outside the caller's org (never 403 across orgs)
  'conflict', // 409: duplicate name, scan already running, deleting a built-in role
  'rate_limited', // 429: too many scans / logins
  'internal', // 500
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const ERROR_STATUS: Readonly<Record<ApiErrorCode, number>> = {
  bad_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  csrf: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  internal: 500,
};

export interface ApiError {
  error: {
    code: ApiErrorCode;
    /** Safe, human-readable. Never contains stack traces, secrets or file system paths. */
    message: string;
    /** For bad_request: offending field paths, e.g. ["tier", "permissions[3]"]. */
    fields?: string[];
  };
}

export interface Page<T> {
  items: T[];
  /** Total rows matching the filter (before paging). */
  total: number;
  nextCursor: string | null;
}

export interface PageQuery {
  limit?: number;
  cursor?: string;
}

/** `{ ok: true }` for mutations that return nothing else (logout, delete). */
export interface OkResponse {
  ok: true;
}

// ---------------------------------------------------------------------------
// Auth and /api/me
// ---------------------------------------------------------------------------

export interface User {
  id: Id;
  email: string;
  name: string;
}

/** POST /api/auth/login */
export interface LoginRequest {
  email: string;
  password: string;
}
/** POST /api/auth/login -> sets the session cookie */
export type LoginResponse = MeResponse;

/** POST /api/dev/switch-user (dev mode only; 404 otherwise) */
export interface DevSwitchUserRequest {
  userId: Id;
}
export type DevSwitchUserResponse = MeResponse;

/** POST /api/session/org: switch the working org (must be an org the user is bound in) */
export interface SwitchOrgRequest {
  orgId: Id;
}
export type SwitchOrgResponse = MeResponse;

export interface OrgRef {
  id: Id;
  name: string;
}

export interface ProjectRef {
  id: Id;
  name: string;
}

/** GET /api/me */
export interface MeResponse {
  user: User;
  /** Org the session is working in (null until the user belongs to one). */
  org: OrgRef | null;
  /** All orgs the user has any binding in. */
  orgs: OrgRef[];
  /** Ids and names of the user's org-scope roles in `org`. */
  roles: RoleRef[];
  /** Effective org-scope permissions (union of roles), catalogue order. Drives the nav. */
  permissions: Permission[];
  /**
   * Extra permissions per project from project-scope bindings, keyed by project id. Only
   * projects where the user has a project binding appear. Effective = org ∪ project.
   */
  projectPermissions: Record<Id, Permission[]>;
  /** True when the server runs with --dev; enables the role switcher. */
  devMode: boolean;
  /** Dev mode only: seeded users the switcher can become, each with its role names. */
  devUsers?: { id: Id; email: string; name: string; roles: string[] }[];
}

// ---------------------------------------------------------------------------
// Orgs and projects
// ---------------------------------------------------------------------------

export const SIZE_TIERS = ['Small', 'Standard', 'Large', 'Ecosystem'] as const;
export type SizeTier = (typeof SIZE_TIERS)[number];

/** Settings a tier fixes; every one can be overridden per project (PLAN §12). */
export interface TierSettings {
  /** Human-readable cadence, e.g. "daily". Scheduling is deferred; stored for display. */
  scanCadence: string;
  /** Max transitive dependency depth; null = unlimited. */
  dependencyDepth: number | null;
  includeDevDependencies: boolean;
  retentionDays: number;
  /** Max nodes rendered in a scoped graph before grouping. */
  graphNodeCap: number;
  entityHops: number;
}

export const TIER_DEFAULTS: Readonly<Record<SizeTier, TierSettings & { repoRange: string; fit: string }>> = {
  Small: { repoRange: '1–50 repos', fit: 'A team or a single product', scanCadence: 'every push + daily', dependencyDepth: null, includeDevDependencies: true, retentionDays: 365, graphNodeCap: 400, entityHops: 3 },
  Standard: { repoRange: '50–500 repos', fit: 'A department or platform', scanCadence: 'daily + on PR', dependencyDepth: null, includeDevDependencies: true, retentionDays: 365, graphNodeCap: 60, entityHops: 3 },
  Large: { repoRange: '500–10,000 repos', fit: 'Enterprise estates', scanCadence: 'daily, incremental', dependencyDepth: null, includeDevDependencies: false, retentionDays: 730, graphNodeCap: 150, entityHops: 2 },
  Ecosystem: { repoRange: 'Public packages', fit: 'Research on top public packages', scanCadence: 'registry change feed', dependencyDepth: 3, includeDevDependencies: false, retentionDays: 1095, graphNodeCap: 150, entityHops: 3 },
};

export interface Org {
  id: Id;
  name: string;
  /** URL-safe, unique: [a-z0-9-]{2,40}. */
  slug: string;
  createdAt: IsoTime;
}

/** GET /api/orgs */
export interface ListOrgsResponse {
  items: Org[];
}

/** POST /api/orgs. The creator gets an org-scope Org admin binding in the new org. */
export interface CreateOrgRequest {
  name: string;
  slug?: string;
}
export type CreateOrgResponse = Org;

export interface Project {
  id: Id;
  orgId: Id;
  name: string;
  tier: SizeTier;
  /** Only the keys the customer changed; effective = TIER_DEFAULTS[tier] + overrides. */
  tierOverrides: Partial<TierSettings>;
  /**
   * What to scan: an https git URL (shallow clone, no hooks) or, only when the server allows it,
   * a local path under a configured root. Validated server-side on create/update.
   */
  target: string;
  /** Free text owner shown on Org home, e.g. "Payments · A. Chen". */
  owner: string | null;
  createdAt: IsoTime;
  updatedAt: IsoTime;
}

/** One row on Org home / Projects. */
export interface ProjectRow extends Project {
  lastScan: ScanRef | null;
  /** From the latest succeeded scan; zeros when there is none. */
  assets: number;
  components: number;
  counts: Record<RiskLevel, number>;
  /** critical + high per succeeded scan, oldest first, up to 12 points. */
  trend: number[];
  /** Findings with status "new" in the latest succeeded scan. */
  toReview: number;
}

/** GET /api/projects?org= (org defaults to the session's org) */
export type ListProjectsResponse = Page<ProjectRow>;

/**
 * GET /api/me/projects: id and name of every project in the working org where the caller holds
 * any permission (all of them with any org-scope permission, else those with a project binding).
 * Any signed-in member may call it; it is what the nav and project switcher use.
 */
export interface ListMyProjectsResponse {
  items: ProjectRef[];
}

/** POST /api/projects */
export interface CreateProjectRequest {
  name: string;
  tier: SizeTier;
  target: string;
  owner?: string | null;
  tierOverrides?: Partial<TierSettings>;
}
export type CreateProjectResponse = Project;

/** GET /api/projects/:id */
export type GetProjectResponse = ProjectRow;

/** PATCH /api/projects/:id (all fields optional) */
export type UpdateProjectRequest = Partial<CreateProjectRequest>;
export type UpdateProjectResponse = Project;

/** GET /api/home */
export interface OrgHomeResponse {
  org: Org;
  totals: { projects: number; assets: number; components: number; counts: Record<RiskLevel, number>; toReview: number };
  projects: ProjectRow[];
  recentScans: ScanRef[];
}

// ---------------------------------------------------------------------------
// Scans
// ---------------------------------------------------------------------------

export const SCAN_STATUSES = ['queued', 'running', 'succeeded', 'failed'] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];

export interface ScanRef {
  id: Id;
  projectId: Id;
  status: ScanStatus;
  createdAt: IsoTime;
  finishedAt: IsoTime | null;
}

export interface ScanSummary {
  inventory: InventorySummary;
  counts: Record<RiskLevel, number>;
  findings: number;
  /** Components with upkeep signals only (noise rule; not findings). Absent on scans stored before it. */
  health?: number;
  outbound: number;
  warnings: string[];
}

export interface Scan extends ScanRef {
  /** Target as scanned (copied from the project at queue time). */
  target: string;
  /** Resolved commit sha when the target was a git URL. */
  commit: string | null;
  offline: boolean;
  requestedBy: Id;
  startedAt: IsoTime | null;
  /** Safe one-line reason when status is "failed". */
  error: string | null;
  /** Present when status is "succeeded". */
  summary: ScanSummary | null;
  /** Engine schema version of the stored ScanResult. */
  schemaVersion: '1' | null;
  /** Last state change: the latest of createdAt, startedAt and finishedAt. Always sent by the server. */
  updatedAt?: IsoTime;
}

/** POST /api/projects/:id/scans -> 202 */
export interface CreateScanRequest {
  /** Use recorded fixtures only, no network (default false; forced true in tests). */
  offline?: boolean;
  /** Git ref to check out for git targets (branch or tag). Default: remote HEAD. */
  ref?: string;
}
export type CreateScanResponse = Scan;

/**
 * GET /api/projects/:id/scans?limit=&cursor=&updatedSince=
 *
 * Without `updatedSince`: every scan, newest first, paged. With `updatedSince` (ISO time):
 * only scans whose `updatedAt` is at or after it (new, started or finished since), still newest
 * first and paged with `cursor`. To poll without dropping already-loaded pages, pass the
 * previous response's `serverTime` as `updatedSince` and merge the rows by id (a row changed
 * exactly at `serverTime` can come back twice).
 */
export interface ListScansQuery extends PageQuery {
  updatedSince?: IsoTime;
}
export type ListScansResponse = Page<Scan> & {
  /** Server clock when the list was read: the next poll's `updatedSince`. */
  serverTime: IsoTime;
};

/** GET /api/scans/:id */
export type GetScanResponse = Scan;

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

/**
 * Finding life cycle (docs/UX.md §5): new (shown as Open) → reviewed (Triaged) → fixing →
 * resolved, plus accepted_risk (needs a reason and an expiry date). Stored ids are kept from
 * Phase 4a, so older clients and data stay valid.
 */
export const FINDING_STATUSES = ['new', 'reviewed', 'fixing', 'resolved', 'accepted_risk'] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];
/** Statuses that still need work ("open" in counts and tiles). */
export const OPEN_FINDING_STATUSES: readonly FindingStatus[] = ['new', 'reviewed', 'fixing'];

/** A member a finding can be assigned to. */
export interface PersonRef {
  id: Id;
  name: string;
}

/** Compact row for the Findings table. */
export interface FindingRow {
  /** Stable within a scan. */
  id: Id;
  scanId: Id;
  projectId: Id;
  purl: PurlString;
  name: string;
  version: string;
  ecosystem: Ecosystem;
  score: number;
  level: RiskLevel;
  /** reasons[0] of the engine Finding, or null. */
  mainReason: { factor: string; detail: string } | null;
  /** Reason factor ids, in engine order. */
  factors: string[];
  reach: { assets: number; prodAssets: number; paths: number };
  /** Reach in plain words, e.g. "Brought in by event-stream · used by api (production)". */
  reachText: string;
  blastScore: number;
  /** Last entity in the chain (e.g. an incident or funder), if any. */
  behind: { entityId: string; relation: EntityChainEntry['relation']; confidence: number } | null;
  status: FindingStatus;
  /** First scan of this project in which the same purl had a finding. */
  firstSeenAt: IsoTime;
  /** Who is handling it (per project and package, like status). Null = unassigned. */
  owner: PersonRef | null;
  /** Set while the status is accepted_risk: when the acceptance runs out. */
  riskExpiresAt: IsoTime | null;
}

/** Who brings a package in: a direct dependency, and/or the direct dependencies that pull it in. */
export interface IntroducedBy {
  direct: boolean;
  /** Package names of the direct dependencies on the shortest paths first (at most 5). */
  via: string[];
}

/** A row of the org-wide findings list: a FindingRow with its project and spread. */
export interface OrgFindingRow extends FindingRow {
  projectName: string;
  introducedBy: IntroducedBy;
  /** Projects (among those listed) whose latest scan has this same package version, and how many reach production. */
  spread: { projects: number; prodProjects: number };
}

/**
 * GET /api/findings without `project`: the latest scan of every project the caller may read
 * findings in. Every filter is a comma-separated list (OR within, AND across).
 */
export interface ListOrgFindingsQuery extends PageQuery {
  /** Project ids; absent = every visible project. Ids the caller cannot see are ignored. */
  projects?: string;
  /** "prod": reaches production; "dev": does not. */
  env?: 'prod' | 'dev';
  level?: string;
  status?: string;
  /** User ids, or "none" for unassigned. */
  owner?: string;
  /** ISO time: first seen at or after. */
  since?: IsoTime;
  q?: string;
  sort?: OrgFindingSort;
}
export const ORG_FINDING_SORTS = ['-score', 'score', 'name', 'reach', '-firstSeen', 'firstSeen'] as const;
export type OrgFindingSort = (typeof ORG_FINDING_SORTS)[number];
export type ListOrgFindingsResponse = Page<OrgFindingRow> & { scannedProjects: number };

/** GET /api/findings/packages: the same filters, one row per package version. */
export interface PackageFindingGroup {
  purl: PurlString;
  name: string;
  version: string;
  ecosystem: Ecosystem;
  /** The worst level and the highest score among its findings. */
  level: RiskLevel;
  score: number;
  mainReason: { factor: string; detail: string } | null;
  introducedBy: IntroducedBy;
  firstSeenAt: IsoTime;
  projects: number;
  prodProjects: number;
  /** Every matching finding (one per project), production first. */
  findings: { id: Id; projectId: Id; projectName: string; production: boolean; status: FindingStatus; owner: PersonRef | null }[];
}
export type ListPackageFindingsResponse = Page<PackageFindingGroup> & { scannedProjects: number };

/** GET /api/findings?project=&scan=&level=&status=&q=&sort=&limit=&cursor= */
export interface ListFindingsQuery extends PageQuery {
  project: Id;
  /** Defaults to the project's latest succeeded scan. */
  scan?: Id;
  /** Comma-separated RiskLevel list, e.g. "critical,high". */
  level?: string;
  /** Comma-separated FindingStatus list. */
  status?: string;
  /** Case-insensitive substring of name, purl or reason detail. */
  q?: string;
  sort?: 'score' | '-score' | 'name' | 'reach';
}
export type ListFindingsResponse = Page<FindingRow> & { scan: ScanRef | null };

export interface AssetPathView {
  assetId: string;
  assetName: string;
  kind: AssetKind;
  environment: Environment;
  criticality: Criticality;
  exposure: number;
  /** Each path is [assetId, purl, ..., purl] as in AssetExposure. */
  paths: string[][];
}

export interface StatusChange {
  at: IsoTime;
  by: Id;
  from: FindingStatus;
  to: FindingStatus;
  note: string | null;
  /** Display name of `by`, when the user still exists. */
  byName?: string;
}

/** GET /api/findings/:id */
export interface FindingDetail extends FindingRow {
  /** Reasons with evidence URLs, as scored. */
  reasons: Reason[];
  /** Affected assets with every path (engine blastRadius.assets, joined with asset metadata). */
  assets: AssetPathView[];
  entityChain: EntityChainEntry[];
  /** Who is behind the package, incident or not (engine Finding.behind). */
  ownership: EntityChainEntry[];
  /** The untouched engine object, for export and for screens that need more. */
  finding: Finding;
  /** Same purl across this project's previous scans, newest first. */
  history: { scanId: Id; at: IsoTime; score: number; level: RiskLevel }[];
  statusHistory: StatusChange[];
  projectName?: string;
  introducedBy?: IntroducedBy;
  /** Alerts recorded for this package in this project (advisory id and publish time). */
  alerts?: { advisoryId: string; advisoryPublished: IsoTime | null; createdAt: IsoTime }[];
  /** Projects the caller may read whose latest scan has this same package version. */
  spread?: { projects: number; prodProjects: number };
}
export type GetFindingResponse = FindingDetail;

/**
 * PATCH /api/findings/:id. Status "new", "reviewed", "fixing" and "resolved" and any owner change
 * need `review`; moving into or out of "accepted_risk" needs `accept_risk`. At least one of
 * `status` or `ownerId` is required.
 */
export interface UpdateFindingStatusRequest {
  status?: FindingStatus;
  note?: string;
  /** For accepted_risk: when the acceptance runs out (ISO date or time, in the future). */
  expiresAt?: IsoTime;
  /** Assign (a member id) or unassign (null). */
  ownerId?: Id | null;
}
export type UpdateFindingStatusResponse = FindingRow;

/**
 * POST /api/findings/bulk: one change to many findings, all or nothing. Every finding must be in
 * the caller's org (else 404) and the caller needs the permission in each finding's project
 * (else 403). accepted_risk needs both `note` (the reason) and `expiresAt`.
 */
export interface BulkUpdateFindingsRequest extends UpdateFindingStatusRequest {
  ids: Id[];
}
export interface BulkUpdateFindingsResponse {
  updated: number;
  items: FindingRow[];
}

/** GET /api/assignees: members a finding can be assigned to (any reader of findings). */
export interface ListAssigneesResponse {
  items: PersonRef[];
}

/** GET /api/overview?projects=&env=&range=: the Overview page, from the latest scans. */
export interface OverviewQuery {
  projects?: string;
  env?: 'prod' | 'dev';
  range?: '7d' | '30d' | '90d' | 'all';
}
export interface OverviewResponse {
  /** When these numbers were computed. */
  at: IsoTime;
  /** Start of the range (null for "all"). */
  since: IsoTime | null;
  /** Projects in scope, and how many have a succeeded scan. */
  projects: number;
  scannedProjects: number;
  attention: {
    criticalOpen: number;
    criticalOpenProd: number;
    highUnassigned: number;
    /** First seen time of the oldest unassigned open high finding. */
    highUnassignedOldest: IsoTime | null;
    newThisWeek: number;
    newThisWeekProjects: number;
    /** Projects whose latest scan failed, or that were never scanned successfully. */
    sourcesToCheck: { projectId: Id; projectName: string; problem: 'failed' | 'never_scanned'; detail: string | null }[];
  };
  /** Open findings per level, and how many of them were first seen inside the range. */
  bySeverity: { level: RiskLevel; open: number; newInRange: number | null }[];
  /** Open packages found in the most projects. */
  topPackages: {
    purl: PurlString;
    name: string;
    version: string;
    level: RiskLevel;
    reason: string | null;
    projects: number;
    prodProjects: number;
  }[];
  /** The newest alert in the range, for the incident banner. */
  incident: {
    advisoryId: string;
    purl: PurlString;
    name: string;
    version: string;
    projects: number;
    production: number;
    detectedAt: IsoTime;
  } | null;
}

// ---------------------------------------------------------------------------
// Exposure matrix
// ---------------------------------------------------------------------------

/** GET /api/exposure?project=&minLevel=  (no project: rows are projects, org-wide) */
export interface ExposureQuery {
  project?: Id;
  /** Default "medium". */
  minLevel?: RiskLevel;
  /** Max columns (components), default 50. */
  limit?: number;
}

export interface ExposureColumn {
  findingId: Id;
  projectId: Id;
  purl: PurlString;
  name: string;
  version: string;
  level: RiskLevel;
  score: number;
  /** Rows this component reaches. */
  reach: number;
}

export interface ExposureRow {
  /** Asset id when `axis` is "asset"; project id when "project". */
  key: string;
  label: string;
  projectId: Id;
  environment: Environment | null;
  criticality: Criticality | null;
  /** Sum of exposure × column score across the row, for sorting. */
  blastScore: number;
  /** Org-wide rows: a column's package reaches production in this project. */
  production?: boolean;
}

/** Sparse: only non-zero cells are listed. */
export interface ExposureCell {
  row: number;
  col: number;
  /** 0–1, max exposure over the row's assets (AssetExposure.exposure). */
  exposure: number;
  pathCount: number;
  /** Org-wide cells: this project's own finding for the package, its level and reach. */
  findingId?: Id;
  level?: RiskLevel;
  production?: boolean;
}

export interface ExposureMatrixResponse {
  axis: 'asset' | 'project';
  rows: ExposureRow[];
  columns: ExposureColumn[];
  cells: ExposureCell[];
  /** True when columns or rows were cut by limits. */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Changes between two scans
// ---------------------------------------------------------------------------

export const CHANGE_TYPES = [
  'new_finding', // purl has a finding in `to` but not in `from`
  'resolved', // finding in `from` gone in `to`
  'risk_up', // level went up
  'risk_down', // level went down
  'new_reason', // same level, new reason factor (e.g. maintainer_change, malware, vuln)
] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];

export interface ChangeRow {
  /** Deterministic: `${type}:${purl}` (unique within one from/to pair). */
  id: string;
  type: ChangeType;
  purl: PurlString;
  name: string;
  version: string;
  from: { score: number; level: RiskLevel } | null;
  to: { score: number; level: RiskLevel } | null;
  /** Factors present in `to` and absent in `from`. */
  addedFactors: string[];
  /** Short factual sentence. Untrusted parts already plain text; escape when rendering. */
  detail: string;
  reach: { assets: number; prodAssets: number };
  /** Finding in the `to` scan (null for resolved). */
  findingId: Id | null;
}

/** GET /api/changes?project=&from=&to=  (defaults: the two latest succeeded scans) */
export interface ChangesQuery {
  project: Id;
  from?: Id;
  to?: Id;
}

export interface ChangesResponse {
  projectId: Id;
  /** null when the project has only one succeeded scan: every finding is then "new_finding". */
  fromScan: ScanRef | null;
  toScan: ScanRef | null;
  items: ChangeRow[];
  counts: Record<ChangeType, number>;
}

// ---------------------------------------------------------------------------
// Investigate (scoped graph, never estate-wide)
// ---------------------------------------------------------------------------

export type GraphNodeKind = 'asset' | 'component' | 'entity' | 'incident' | 'group';

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  level?: RiskLevel;
  entityType?: EntityType;
  /** For kind "group": how many nodes it stands for. */
  size?: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  /** DepScope for dependency edges, EntityChainEntry relation for entity edges. */
  relation: string;
  confidence?: number;
  reviewed?: boolean;
  evidence?: string[];
}

/** GET /api/graph?finding=:id  or  GET /api/graph?project=&node=<purl|entityId> */
export interface GraphResponse {
  centre: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** The project tier's graphNodeCap applied. */
  cap: number;
  truncated: boolean;
}

/** GET /api/investigate/search?project=&q= */
export interface InvestigateSearchResponse {
  items: { kind: 'component' | 'entity' | 'incident'; id: string; label: string; meta: string }[];
}

/** GET /api/investigate/node?project=&id=<purl|entityId|incidentId> */
export interface InvestigateNodeResponse {
  id: string;
  kind: 'component' | 'entity' | 'incident';
  label: string;
  /** Findings in the latest scan(s) this node appears in (via the purl or the entity chain). */
  appearances: { projectId: Id; projectName: string; findingId: Id; purl: PurlString; via: string; assets: number; level: RiskLevel; score: number }[];
  /** Links touching this node, each with confidence and sources. */
  links: (EntityChainEntry & { from: string })[];
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export const REPORT_FORMATS = ['html', 'json', 'sarif'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

export interface ReportRow {
  scanId: Id;
  project: ProjectRef;
  createdAt: IsoTime;
  counts: Record<RiskLevel, number>;
  /** Download paths, e.g. "/api/reports/scan_ab12.html". */
  downloads: Record<ReportFormat, string>;
  /**
   * SHA-256 hex of the exact bytes of the JSON download (`downloads.json`), so
   * `sha256sum blastradius-<scanId>.json` prints the same value.
   */
  sha256: string;
}

/** GET /api/reports?project= : one row per succeeded scan, newest first */
export type ListReportsResponse = Page<ReportRow>;

/**
 * GET /api/reports/:scanId.{html,json,sarif}: the engine report body, generated from the stored
 * ScanResult by src/report. Content-Disposition: attachment. HTML is served with a strict CSP.
 */
export type ReportDownload = string;

// ---------------------------------------------------------------------------
// Integrations (read-only in 4a)
// ---------------------------------------------------------------------------

export interface Integration {
  id: Id;
  kind: 'github' | 'webhook' | 'api';
  name: string;
  status: 'not_configured' | 'ok' | 'error';
  detail: string;
}

/** GET /api/integrations */
export interface ListIntegrationsResponse {
  items: Integration[];
}

// ---------------------------------------------------------------------------
// Roles, bindings, members, audit
// ---------------------------------------------------------------------------

export interface RoleRef {
  id: Id;
  name: string;
}

export interface Role extends RoleRef {
  orgId: Id;
  description: string;
  /** True for org_admin, appsec, developer, auditor (editable, not deletable). */
  builtIn: boolean;
  /** Template the role was created from (built-in id), or null for a blank role. */
  template: string | null;
  /** Catalogue order. org_admin always lists every permission. */
  permissions: Permission[];
  updatedAt: IsoTime;
}

/** GET /api/roles */
export interface ListRolesResponse {
  items: Role[];
  catalogue: { pages: PagePermission[]; actions: ActionPermission[]; labels: Record<Permission, string> };
}

/** POST /api/roles */
export interface CreateRoleRequest {
  name: string;
  description?: string;
  /** Built-in id to copy permissions from; ignored when `permissions` is given. */
  template?: string;
  permissions?: Permission[];
}
export type CreateRoleResponse = Role;

/** PATCH /api/roles/:id. Changing org_admin's permissions is a no-op (always everything). */
export interface UpdateRoleRequest {
  name?: string;
  description?: string;
  permissions?: Permission[];
}
export type UpdateRoleResponse = Role;

/** POST /api/roles/:id/reset : built-in roles only, back to the template */
export type ResetRoleResponse = Role;

export interface RoleBinding {
  id: Id;
  orgId: Id;
  roleId: Id;
  subject: BindingSubject;
  scope: BindingScope;
  createdAt: IsoTime;
  createdBy: Id;
}

/** GET /api/bindings?project= */
export interface ListBindingsResponse {
  items: (RoleBinding & { subjectLabel: string; roleName: string; scopeLabel: string })[];
}

/** POST /api/bindings */
export interface CreateBindingRequest {
  roleId: Id;
  subject: BindingSubject;
  scope: BindingScope;
}
export type CreateBindingResponse = RoleBinding;

export type Member = User & { bindings: RoleBinding[] };

/** GET /api/members : users in the org with their bindings */
export interface ListMembersResponse {
  items: Member[];
}

/**
 * POST /api/members (manage_members): add a user to the working org by email with one or more
 * initial role bindings. Each binding follows the POST /api/bindings rules (only roles whose
 * permissions the caller holds; only an Org admin grants Org admin).
 */
export interface InviteMemberRequest {
  email: string;
  name: string;
  /** 1–20 bindings for the invited user. */
  bindings: { roleId: Id; scope: BindingScope }[];
}

/**
 * POST /api/members -> 201. Secrets appear in this response only, once; never in logs or audit.
 *
 * Outside dev mode the answer is always a pending `invite`, worded the same whether or not the
 * email already has an account: nothing is granted until the invitee accepts, and an existing
 * account must confirm with its own password. Inviting the same email again replaces its earlier
 * unaccepted invites (that is how an expired invite is re-sent). 409 only when the email is
 * already a member of this org.
 */
export interface InviteMemberResponse {
  /** Dev mode, email without an account: the member, created and bound straight away. */
  member?: Member;
  /** Dev mode, with `member`: a generated password to hand over. Shown once. */
  oneTimePassword?: string;
  /** Every other case: a single-use invite for POST /api/auth/accept-invite (web: /accept-invite#token=...). */
  invite?: { token: string; expiresAt: IsoTime; email: string; name: string };
}

/**
 * POST /api/auth/accept-invite (public): join the invite's org, then sign in. With no account for
 * the invited email, `password` (12+ characters) becomes the new account's password; with an
 * existing account it must be that account's current password. Failures answer 400 with one
 * generic message; attempts count against the sign-in rate limits.
 */
export interface AcceptInviteRequest {
  token: string;
  password: string;
}
/** Sets the session cookie, like login. */
export type AcceptInviteResponse = MeResponse;

export interface AuditEntry {
  id: Id;
  at: IsoTime;
  actor: Id;
  /** e.g. "role.update", "binding.create", "project.create", "scan.create", "finding.status". */
  action: string;
  target: string;
  /** JSON-safe before/after snapshot; never contains secrets. */
  detail: Record<string, unknown>;
}

/** GET /api/audit */
export type ListAuditResponse = Page<AuditEntry>;

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

/** GET /api/health (no auth) */
export interface HealthResponse {
  ok: true;
  version: string;
}

/** Re-exported engine types the web app needs, so it imports from one place. */
export type { AssetExposure, Finding, OutboundFinding, Reason, RiskLevel, EntityChainEntry, Environment, Criticality, Ecosystem };

/** GET /api/projects/:id/health: upkeep-only signals from the latest succeeded scan (not findings). */
export interface HealthItem {
  purl: string;
  name: string;
  version: string;
  /** What the upkeep signals together would score (0–100); for ordering only. */
  score: number;
  signals: { factor: string; detail: string }[];
}
export interface ProjectHealthResponse {
  scanId: string | null;
  items: HealthItem[];
}

/** Org-wide incident mode. */
export interface ExposureHitRow {
  projectId: string;
  projectName: string;
  purl: string;
  name: string;
  version: string;
  production: boolean;
  /** e.g. "Brought in by npm-run-all · used by a11ymap (dev/test dependencies only)". */
  reachText: string;
}
/** GET /api/search/exposure?q=name or name@version: "is X anywhere?" across visible projects. */
export interface SearchExposureResponse {
  query: { name: string; version: string | null };
  projectsSearched: number;
  items: ExposureHitRow[];
}
export interface AlertItem {
  id: string;
  projectId: string;
  projectName: string;
  purl: string;
  advisoryId: string;
  advisoryPublished: string | null;
  production: boolean;
  reachText: string;
  createdAt: string;
  /** The advisory's rating, else the finding's level; null when neither is known. */
  level?: RiskLevel | null;
  summary?: string | null;
  /** First fixed version the advisory names. */
  fixedIn?: string | null;
}
/** GET /api/alerts */
export interface ListAlertsResponse {
  items: AlertItem[];
}
/** POST /api/alerts/check { advisories?: OSV records }: without a body the knowledge pack is used. */
export interface CheckAlertsResponse {
  source: 'advisories' | 'pack';
  projectsChecked: number;
  ms: number;
  created: AlertItem[];
}

// ---------------------------------------------------------------------------
// Sources (repo connectors, docs/CONNECTORS.md)
// ---------------------------------------------------------------------------

export const SOURCE_HOSTS = ['github'] as const;
export type SourceHostName = (typeof SOURCE_HOSTS)[number];

/** pending: install started, not finished · connected · access_lost: revoked, suspended or 401 · disconnected: by a user. */
export const SOURCE_STATUSES = ['pending', 'connected', 'access_lost', 'disconnected'] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

/**
 * discovering: being listed · watching: scanned, re-scanned on relevant pushes · scanning: a scan
 * is queued or running · no_lockfile: no manifest, lockfile or workflow found (nothing to scan) ·
 * unsupported: only yarn.lock / pnpm-lock.yaml (package.json pins and workflows are still read),
 * or the tree is too large for the API (not scanned) · access_lost · removed: taken out of the
 * installation (history kept) · not_watched: turned off.
 */
export const SOURCE_REPO_STATUSES = ['discovering', 'watching', 'scanning', 'no_lockfile', 'unsupported', 'access_lost', 'removed', 'not_watched'] as const;
export type SourceRepoStatus = (typeof SOURCE_REPO_STATUSES)[number];

export interface SourceDeliveryRef {
  at: IsoTime;
  event: string;
  outcome: string;
}

export interface Source {
  id: Id;
  host: SourceHostName;
  /** GitHub org or user login (null until the install is finished). */
  account: string | null;
  accountType: string | null;
  installationId: string | null;
  /** all: every repo, new ones included · selected: the repos picked on GitHub. */
  repositorySelection: 'all' | 'selected' | null;
  /** Start watching repos as they are discovered (new ones included). */
  autoWatch: boolean;
  status: SourceStatus;
  /** Why the source is not healthy (safe text), or null. */
  health: string | null;
  healthCheckedAt: IsoTime | null;
  repos: { total: number; watching: number; accessLost: number };
  lastDelivery: SourceDeliveryRef | null;
  createdAt: IsoTime;
  createdBy: Id;
  updatedAt: IsoTime;
}

/** GET /api/sources (manage_projects) */
export interface ListSourcesResponse {
  /** Hosts whose App is configured on this server. */
  configured: Record<SourceHostName, boolean>;
  items: Source[];
  /** Webhook deliveries dropped since start (bad or missing signature). */
  webhooks: { rejected: number };
}

/** POST /api/sources */
export interface StartSourceInstallRequest {
  host: SourceHostName;
  autoWatch?: boolean;
}
export interface StartSourceInstallResponse {
  source: Source;
  /** Send the browser here; GitHub returns to /api/sources/github/callback. */
  installUrl: string;
  expiresAt: IsoTime;
}

export type GetSourceResponse = Source;

/** PATCH /api/sources/:id */
export interface UpdateSourceRequest {
  autoWatch?: boolean;
}

export interface SourceRepo {
  id: Id;
  sourceId: Id;
  /** The host's repository id. */
  repoId: string;
  fullName: string;
  defaultBranch: string | null;
  private: boolean;
  htmlUrl: string | null;
  /** Lockfiles found (every workspace root), yarn/pnpm included. */
  lockfiles: string[];
  /** Exactly the files read for the inventory at the last discovery. */
  filesRead: string[];
  watching: boolean;
  status: SourceRepoStatus;
  statusDetail: string | null;
  /** The project findings, alerts and blast radius live under. */
  projectId: Id | null;
  lastCommit: string | null;
  lastDeliveryAt: IsoTime | null;
  lastDeliveryOutcome: string | null;
  lastScanAt: IsoTime | null;
  lastScanId: Id | null;
  createdAt: IsoTime;
  updatedAt: IsoTime;
}

/** GET /api/sources/:id/repos */
export interface ListSourceReposResponse {
  items: SourceRepo[];
}

/** PATCH /api/sources/:id/repos/:repoId */
export interface UpdateSourceRepoRequest {
  watching: boolean;
}
export type UpdateSourceRepoResponse = SourceRepo;

/** POST /api/hooks/github → 202 (200 for a duplicate delivery) */
export interface WebhookAcceptedResponse {
  ok: true;
  duplicate: boolean;
  outcome: string;
}
