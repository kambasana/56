/**
 * Subset of the OSV API schema we read (https://google.github.io/osv.dev/api/,
 * https://ossf.github.io/osv-schema/). Everything is optional because the data
 * is untrusted; parse defensively.
 */

export interface OsvQuery {
  package: { name: string; ecosystem: string };
  version: string;
  page_token?: string;
}

export interface OsvBatchRequest {
  queries: OsvQuery[];
}

export interface OsvBatchResult {
  vulns?: { id?: string; modified?: string }[];
  next_page_token?: string;
}

export interface OsvBatchResponse {
  results?: OsvBatchResult[];
}

export interface OsvEvent {
  introduced?: string;
  fixed?: string;
  last_affected?: string;
  limit?: string;
}

export interface OsvAffected {
  package?: { ecosystem?: string; name?: string; purl?: string };
  ranges?: { type?: string; repo?: string; events?: OsvEvent[] }[];
  versions?: string[];
  ecosystem_specific?: Record<string, unknown>;
  database_specific?: Record<string, unknown>;
}

export interface OsvSeverity {
  type?: string; // CVSS_V2 | CVSS_V3 | CVSS_V4 | Ubuntu
  score?: string;
}

export interface OsvVuln {
  schema_version?: string;
  id?: string;
  modified?: string;
  published?: string;
  withdrawn?: string;
  aliases?: string[];
  related?: string[];
  summary?: string;
  details?: string;
  severity?: OsvSeverity[];
  affected?: OsvAffected[];
  references?: { type?: string; url?: string }[];
  credits?: { name?: string; type?: string; contact?: string[] }[];
  database_specific?: Record<string, unknown>;
}
