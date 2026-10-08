/**
 * Web API contract for incidents, package reach, "who's behind it" and alert rules
 * (docs/WEB-API.md, docs/UX.md §8 flows 3 and 5, §10). Same conventions as api-types.ts: type
 * imports and constant tables only, so the web app imports it through the @server alias.
 * Values that came from scanned repos, registries or advisories are untrusted text.
 */
import type { DepScope, EntityChainEntry, Environment, RiskLevel } from '../core/types.js';
import type { Id, IsoTime } from './api-types.js';

// ---------------------------------------------------------------------------
// Incidents: one advisory that hit at least one project
// ---------------------------------------------------------------------------

export const INCIDENT_STATUSES = ['investigating', 'fixing', 'monitoring', 'closed'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export interface IncidentPackage {
  purl: string;
  name: string;
  version: string | null;
}

/** One row of GET /api/incidents. `id` is the advisory id. */
export interface IncidentRow {
  id: string;
  advisoryId: string;
  /** When the advisory was published, if it says. */
  advisoryPublished: IsoTime | null;
  summary: string | null;
  /** The advisory's rating, else the worst finding level among its alerts; null when unknown. */
  level: RiskLevel | null;
  status: IncidentStatus;
  packages: IncidentPackage[];
  /** First alert of this advisory. */
  openedAt: IsoTime;
  /** When the status became Closed, else null. */
  closedAt: IsoTime | null;
  /** Projects with an alert (visible to the caller). */
  affected: number;
  /** Of those, projects where it reaches production. */
  production: number;
  /** Of those, projects whose latest scan no longer has the package version. */
  fixed: number;
  /** Affected project names, production first. */
  projects: string[];
}

/** GET /api/incidents */
export interface ListIncidentsResponse {
  items: IncidentRow[];
}

/** One affected project on the Incident page ("Where it is"). */
export interface IncidentHit {
  alertId: Id;
  projectId: Id;
  projectName: string;
  /** Free-text owner from the project settings. */
  owner: string | null;
  purl: string;
  name: string;
  version: string;
  production: boolean;
  reachText: string;
  /** Direct dependencies that bring it in ("event-stream@3.3.6"); empty when it is direct or gone. */
  broughtInBy: string[];
  /** True when it is a direct dependency of the project. */
  direct: boolean;
  /** The project's finding for this package in its latest scan, if any. */
  findingId: Id | null;
  /** The latest scan no longer has this package version. */
  fixed: boolean;
  alertedAt: IsoTime;
}

export type IncidentEventKind = 'alert' | 'check' | 'status' | 'notified';

export interface IncidentEvent {
  at: IsoTime;
  kind: IncidentEventKind;
  title: string;
  detail: string;
  /** For a status change. */
  from?: string | null;
  to?: string | null;
}

/** An action the page offers, with the honest reason it is off. */
export interface IncidentAction {
  available: boolean;
  reason: string | null;
}

/** GET /api/incidents/:id */
export interface IncidentDetail extends IncidentRow {
  hits: IncidentHit[];
  /** Production first, oldest first within each. */
  timeline: IncidentEvent[];
  /** The latest org-wide check of stored inventories. */
  checked: { projects: number; at: IsoTime | null; source: 'pack' | 'advisories' | null };
  /** Distinct owners of the affected projects that are not fixed yet. */
  owners: string[];
  actions: {
    /** Re-check all projects against the knowledge pack (POST /api/alerts/check). */
    recheck: IncidentAction;
    /** Post the incident and its owners to the Slack webhook. */
    notify: IncidentAction;
  };
}

/** PATCH /api/incidents/:id (needs `review`). */
export interface UpdateIncidentRequest {
  status: IncidentStatus;
}
export type UpdateIncidentResponse = IncidentDetail;

/** POST /api/incidents/:id/notify (needs `send_to_destinations` or `manage_alert_rules`). */
export interface NotifyIncidentResponse {
  sent: true;
  owners: string[];
  detail: IncidentDetail;
}

// ---------------------------------------------------------------------------
// Package reach: how far one package spreads across projects
// ---------------------------------------------------------------------------

export interface ReachPathNode {
  /** Asset id or versioned purl. */
  id: string;
  label: string;
  kind: 'asset' | 'package';
}

/** One dependency path from a project's asset to the package. */
export interface ReachPath {
  projectId: Id;
  projectName: string;
  assetId: string;
  assetName: string;
  environment: Environment;
  /** A production asset reaches it through runtime-like edges only. */
  production: boolean;
  /** [asset, direct dependency, ..., the package]. */
  nodes: ReachPathNode[];
  /** Scope of each edge, nodes[i] → nodes[i + 1]. */
  scopes: DepScope[];
}

/** One ribbon of the Sankey: package → brought in by → project → environment. */
export interface ReachFlow {
  projectId: Id;
  projectName: string;
  /** Direct dependency that brings it in ("event-stream@3.3.6"), or "(direct)". */
  via: string;
  production: boolean;
  /** Assets reached through this flow. */
  assets: number;
  paths: number;
}

export interface ReachProject {
  projectId: Id;
  projectName: string;
  production: boolean;
  assets: number;
  paths: number;
  via: string[];
  reachText: string;
  /** Versions of the package in this project. */
  versions: string[];
  findingId: Id | null;
  level: RiskLevel | null;
}

/** GET /api/packages/reach?name=&version= */
export interface PackageReachResponse {
  query: { name: string; version: string | null };
  projectsSearched: number;
  /** Worst finding level or advisory rating for this package; null when nothing rates it. */
  level: RiskLevel | null;
  /** Advisories (incidents) naming it, from stored alerts. */
  advisories: { id: string; published: IsoTime | null; status: IncidentStatus; fixedIn: string | null }[];
  /** Only the phases the stored data knows; absent fields are unknown. */
  lifecycle: {
    /** First scan that flagged it in any project (earliest finding first-seen). */
    firstWarning: IsoTime | null;
    /** Earliest advisory publication. */
    advisory: { id: string; at: IsoTime } | null;
    /** Projects with an alert whose latest scan no longer has it. */
    fixed: { fixed: number; of: number } | null;
  };
  projects: ReachProject[];
  flows: ReachFlow[];
  /** Production paths first, then shortest. Capped at 200. */
  paths: ReachPath[];
  totalPaths: number;
}

// ---------------------------------------------------------------------------
// Who's behind a package
// ---------------------------------------------------------------------------

/** GET /api/packages/behind?name= */
export interface PackageBehindResponse {
  name: string;
  /** Projects whose latest scan has the package (any version). */
  usedIn: number;
  /** Merged, de-duplicated links from findings' `behind` and `entityChain` (incident hops left out). */
  links: Required<Pick<EntityChainEntry, 'from' | 'entityId' | 'relation' | 'confidence' | 'evidence' | 'method' | 'reviewed'>>[];
  /** Incident ids the entity chain ends at, if any. */
  incidents: string[];
  /** Other packages (in your scans) each entity is linked to, by entity id. */
  alsoLinked: Record<string, string[]>;
}

// ---------------------------------------------------------------------------
// Alert rules
// ---------------------------------------------------------------------------

export interface AlertRule {
  id: Id;
  name: string;
  /** WHEN a new alert's severity is at least this… */
  minLevel: RiskLevel;
  /** …and (optionally) it reaches production… */
  productionOnly: boolean;
  /** …THEN post to this Slack channel (named in the message; the webhook decides delivery). */
  channel: string;
  /** Also email the owners (needs an email sender; none ships yet). */
  emailOwners: boolean;
  enabled: boolean;
  createdAt: IsoTime;
  updatedAt: IsoTime;
  /** Alerts in the last 30 days this rule would have sent. */
  lastThirtyDays: number;
}

/** GET /api/alert-rules */
export interface ListAlertRulesResponse {
  items: AlertRule[];
  /** True while no rule is stored: every new alert is posted (the built-in default). */
  usingDefault: boolean;
  webhook: { configured: boolean };
  email: { configured: boolean };
}

/** POST /api/alert-rules (needs `manage_alert_rules`). */
export interface CreateAlertRuleRequest {
  name: string;
  minLevel: RiskLevel;
  productionOnly?: boolean;
  channel: string;
  emailOwners?: boolean;
  enabled?: boolean;
}
export type UpdateAlertRuleRequest = Partial<CreateAlertRuleRequest>;

/** POST /api/alert-rules/preview: what a rule would have sent in the last 30 days. */
export interface PreviewAlertRuleRequest {
  minLevel: RiskLevel;
  productionOnly?: boolean;
}
export interface PreviewAlertRuleResponse {
  days: 30;
  count: number;
  mostRecent: { purl: string; projectName: string; advisoryId: string; createdAt: IsoTime } | null;
}

/** POST /api/alert-rules/test { channel }: one message through the webhook. */
export interface TestAlertRuleRequest {
  channel: string;
}
