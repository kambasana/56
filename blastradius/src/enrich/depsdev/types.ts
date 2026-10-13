/**
 * Subset of the deps.dev v3 / v3alpha and OpenSSF Scorecard API response
 * shapes we read (https://docs.deps.dev/api/v3/, https://api.securityscorecards.dev).
 * All fields optional: the data is untrusted and parsed defensively.
 */

export interface DepsDevVersionKey {
  system?: string; // "NPM"
  name?: string;
  version?: string;
}

export interface DepsDevLink {
  label?: string; // SOURCE_REPO | HOMEPAGE | ISSUE_TRACKER | ORIGIN | DOCUMENTATION
  url?: string;
}

export interface DepsDevSlsaProvenance {
  sourceRepository?: string;
  commit?: string;
  url?: string;
  verified?: boolean;
}

export interface DepsDevAttestation {
  type?: string;
  url?: string;
  verified?: boolean;
  sourceRepository?: string;
  commit?: string;
}

export interface DepsDevRelatedProject {
  projectKey?: { id?: string };
  /** UNVERIFIED_METADATA | SLSA_ATTESTATION | ... */
  relationProvenance?: string;
  /** SOURCE_REPO | ISSUE_TRACKER | ... */
  relationType?: string;
}

/** GET /v3/systems/{system}/packages/{name}/versions/{version} */
export interface DepsDevVersion {
  versionKey?: DepsDevVersionKey;
  publishedAt?: string;
  isDefault?: boolean;
  licenses?: string[];
  advisoryKeys?: { id?: string }[];
  links?: DepsDevLink[];
  slsaProvenances?: DepsDevSlsaProvenance[];
  attestations?: DepsDevAttestation[];
  registries?: string[];
  relatedProjects?: DepsDevRelatedProject[];
}

export interface ScorecardCheck {
  name?: string;
  documentation?: { shortDescription?: string; url?: string };
  score?: number;
  reason?: string;
  details?: string[];
}

/** GET /v3/projects/{id} */
export interface DepsDevProject {
  projectKey?: { id?: string };
  openIssuesCount?: string | number;
  starsCount?: string | number;
  forksCount?: string | number;
  license?: string;
  description?: string;
  homepage?: string;
  scorecard?: {
    date?: string;
    repository?: { name?: string; commit?: string };
    scorecard?: { version?: string; commit?: string };
    checks?: ScorecardCheck[];
    overallScore?: number;
    metadata?: string[];
  };
}

/** GET /v3alpha/systems/{system}/packages/{name}/versions/{version}:dependents */
export interface DepsDevDependents {
  dependentCount?: string | number;
  directDependentCount?: string | number;
  indirectDependentCount?: string | number;
}

/** GET https://api.securityscorecards.dev/projects/{host}/{owner}/{repo} */
export interface ScorecardApiResult {
  date?: string;
  repo?: { name?: string; commit?: string };
  scorecard?: { version?: string; commit?: string };
  score?: number;
  checks?: ScorecardCheck[];
}
