/**
 * Scoring weights and constants (PLAN §3.6). These are starting guesses meant to be
 * calibrated against the backtest set (PLAN §6); keep every tunable number here.
 */
import { RISKY_INSTALL_SCRIPT_FLAGS } from '../core/install-flags.js';
import type { DepScope, Environment, IncidentSeverity, IncidentStatus, IncidentType } from '../core/types.js';

/** Intrinsic factor weights wᵢ for the noisy-OR (PLAN §3.6 step 1). */
export interface FactorWeights {
  /** Malware is an override (intrinsic → 1.0); the weight is reported as 1. */
  malware: number;
  vuln: number;
  /** Recent publisher / maintainer / repo-owner change. */
  ownership_change: number;
  install_script: number;
  weak_posture: number;
  no_provenance: number;
  /** Provenance present on the previous release, missing on this one. */
  provenance_dropped: number;
  /** A patch release added a runtime dependency the previous release did not have. */
  dependency_added: number;
  single_maintainer: number;
  abandoned: number;
}

export const DEFAULT_WEIGHTS: Readonly<FactorWeights> = Object.freeze({
  malware: 1,
  vuln: 0.6,
  ownership_change: 0.5,
  install_script: 0.3,
  weak_posture: 0.3,
  no_provenance: 0.15,
  provenance_dropped: 0.5,
  dependency_added: 0.4,
  single_maintainer: 0.15,
  abandoned: 0.2,
});

/**
 * dependency_added: a brand-new dependency with at least this many npm downloads a week today has
 * become a common building block (has-tostringtag ~190M), not an attack vehicle (peacenotwar ~4k).
 */
export const ESTABLISHED_WEEKLY_DOWNLOADS = 100_000;

/** Vulnerability factor tuning. */
export const VULN = Object.freeze({
  /** Base value when no CVSS score is known, by severity label. */
  severityBase: { critical: 0.95, high: 0.8, medium: 0.5, low: 0.2, unknown: 0.3 } as Record<string, number>,
  /** Exploitability used when EPSS is unknown. */
  defaultExploitability: 0.7,
  /** Exploitability = epssFloor + (1 − epssFloor) · epss when EPSS is known. */
  epssFloor: 0.4,
  /** Multiplier when the vuln is in CISA KEV (KEV also sets exploitability to 1). */
  kevMultiplier: 1.5,
});

/** Ownership-change factor: linear decay to 0 over this many days. */
export const OWNERSHIP_DECAY_DAYS = 90;
/** A publisher change to an account that had published this package before counts this much. */
export const KNOWN_PUBLISHER_FACTOR = 0.5;
/**
 * Repository moved to another owner, but the date of the move is unknown (GitHub only tells us
 * that the declared URL redirects today). Renames and transfers years ago look the same, so this
 * is a weak constant hint instead of a fresh, decaying ownership change.
 */
export const REPO_TRANSFER_UNDATED_VALUE = 0.2;

/** Install-script factor: base value, and value when risky static flags are present. */
export const INSTALL_SCRIPT = Object.freeze({
  base: 0.5,
  flagged: 1,
  /** Shared with the npm enricher (core/install-flags.ts) so the names always match. */
  riskyFlags: RISKY_INSTALL_SCRIPT_FLAGS as readonly string[],
});

/** Abandonment: days without a release before a package is considered stale. */
export const ABANDONED_DAYS = 730;
export const ABANDONED_VALUES = Object.freeze({
  /** Stale or archived AND has known vulns (the PLAN definition). */
  withVulns: 1,
  /** Repository explicitly archived, no known vulns. */
  archivedOnly: 0.5,
  /**
   * Stale (no release in ABANDONED_DAYS), no known vulns. PLAN §3.6 defines "abandoned" as stale
   * AND vulnerable, so staleness alone is reported for information only and adds no risk
   * (small, finished packages such as `once` or `inherits` are not risky for being stable).
   */
  staleOnly: 0,
});

/** Entity-risk parameters (PLAN §3.6 step 2). */
export const SEVERITY_WEIGHT: Readonly<Record<IncidentSeverity, number>> = Object.freeze({
  critical: 1,
  high: 0.75,
  medium: 0.5,
  low: 0.25,
});
export const STATUS_WEIGHT: Readonly<Record<IncidentStatus, number>> = Object.freeze({
  confirmed: 1,
  alleged: 0.4,
  disputed: 0,
  retracted: 0,
});
/** hop_decay by number of links: index 0 = the package itself is affected, 1 = direct maintainer, … */
export const HOP_DECAY: readonly number[] = Object.freeze([1, 1, 0.5, 0.25]);
export const MAX_ENTITY_HOPS = 3;
export const INCIDENT_HALF_LIFE_YEARS = 3;
/** Probabilistic links below this confidence must be reviewed before scoring uses them. */
export const REVIEW_CONFIDENCE_THRESHOLD = 0.8;

/**
 * Incident types that mean the affected release itself shipped compromised code. A confirmed
 * incident of one of these types that names the exact version triggers the malware override.
 */
export const COMPROMISED_RELEASE_TYPES: readonly IncidentType[] = Object.freeze([
  'malware_publish',
  'account_takeover',
  'maintainer_sabotage',
  'maintainer_infiltration',
  'malicious_handover',
  'ci_compromise',
  'domain_or_name_takeover',
  'typosquat',
]);

/** Inbound blast radius (PLAN §3.6 step 4). `peer` is treated as runtime. */
export const SCOPE_EXPOSURE: Readonly<Record<DepScope, number>> = Object.freeze({
  runtime: 1,
  peer: 1,
  build: 0.8,
  dev: 0.3,
  optional: 0.2,
});
export const INSTALL_SCRIPT_EXPOSURE = 0.9;
export const ENVIRONMENT_WEIGHT: Readonly<Record<Environment, number>> = Object.freeze({
  prod: 1,
  ci: 0.9,
  staging: 0.5,
  dev: 0.3,
});
export const REACH_MULTIPLIER = Object.freeze({ privilegedCi: 1.2, pinnedByHash: 0.7 });

/** Graph traversal bounds for inbound paths. */
export const PATH_LIMITS = Object.freeze({
  /** Max paths kept per (asset, component) pair. */
  maxPathsPerPair: 5,
  /** Max edges in a single path. */
  maxDepth: 25,
  /** Max DFS steps per (asset, component) pair before giving up. */
  maxStepsPerPair: 20_000,
});

/** Outbound blast radius (PLAN §3.6 step 5). */
export const OUTBOUND_WEIGHTS = Object.freeze({
  privileged_trigger: 0.4,
  pr_head_checkout: 0.8,
  unpinned_actions: 0.3,
  write_permissions: 0.3,
  undeclared_permissions: 0.15,
  oidc: 0.2,
});
export const PUBLISH_REACH = Object.freeze({ publishes: 1, deployCapable: 0.6, none: 0.3 });
