/**
 * npm provenance: which repository's CI built a release (Tier 0.6).
 *
 * npm stores the attestations of a provenance-published version at
 * https://registry.npmjs.org/-/npm/v1/attestations/<name>@<version>
 * (https://docs.npmjs.com/generating-provenance-statements). The SLSA provenance statement
 * (predicateType https://slsa.dev/provenance/v1) names the workflow that built the package:
 * `predicate.buildDefinition.externalParameters.workflow` {repository, path, ref}. npm checks the
 * statement's Sigstore signature against GitHub's OIDC identity when the version is published, so a
 * release with it was built and published by that repository's CI, not from someone's laptop with
 * a stolen token. Read only for the few releases a release-continuity (S5a) observation names.
 */
import type { HttpClient } from '../../core/http.js';

export const NPM_ATTESTATIONS_URL = 'https://registry.npmjs.org/-/npm/v1/attestations/';

export interface ProvenanceSource {
  /** https URL of the repository whose workflow built the release. */
  repository: string;
  /** Workflow file, e.g. ".github/workflows/release.yml". */
  workflow?: string;
  ref?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The SLSA provenance's source repository and workflow from an attestations response; undefined when absent or unreadable. */
export function parseProvenanceAttestations(body: unknown): ProvenanceSource | undefined {
  const list = isObj(body) && Array.isArray(body.attestations) ? body.attestations : [];
  for (const a of list) {
    if (!isObj(a) || typeof a.predicateType !== 'string' || !/^https:\/\/slsa\.dev\/provenance\/v1$/.test(a.predicateType)) continue;
    const payload = isObj(a.bundle) && isObj(a.bundle.dsseEnvelope) ? a.bundle.dsseEnvelope.payload : undefined;
    if (typeof payload !== 'string' || payload.length > 1_000_000) continue;
    let statement: unknown;
    try {
      statement = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    } catch {
      continue;
    }
    const wf = isObj(statement) && isObj(statement.predicate) && isObj(statement.predicate.buildDefinition) && isObj(statement.predicate.buildDefinition.externalParameters) ? statement.predicate.buildDefinition.externalParameters.workflow : undefined;
    if (!isObj(wf) || typeof wf.repository !== 'string' || !/^https:\/\/[^\s]{1,300}$/.test(wf.repository)) continue;
    return {
      repository: wf.repository.replace(/\.git$/, '').replace(/\/+$/, ''),
      ...(typeof wf.path === 'string' && wf.path.length <= 300 ? { workflow: wf.path } : {}),
      ...(typeof wf.ref === 'string' && wf.ref.length <= 300 ? { ref: wf.ref } : {}),
    };
  }
  return undefined;
}

/** Network: the provenance source of one npm release (undefined: none, or unreadable). */
export async function fetchProvenanceSource(http: HttpClient, name: string, version: string): Promise<ProvenanceSource | undefined> {
  const url = `${NPM_ATTESTATIONS_URL}${name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name)}@${encodeURIComponent(version)}`;
  return parseProvenanceAttestations(await http.fetchJsonOrNull(url));
}
