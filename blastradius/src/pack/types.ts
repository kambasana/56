/**
 * Knowledge pack (docs/DATA-ML.md): a small, versioned file built once by the bootstrap job
 * (`npm run pack:build`) and read at scan time. Version 1 carries the known-bad layer: npm
 * malware from the OSV bulk export and curated supply-chain incidents. Later versions add the
 * maintainer → org → funder graph, features and the model.
 */
export const PACK_SCHEMA = 1;

export interface PackSource {
  name: string;
  url: string;
  licence: string;
  /** When the source was read (ISO date). */
  snapshot: string;
  records: number;
}

/** One malicious-package record, by OSV id. */
export interface PackMalwareRef {
  id: string;
  /** GHSA and other aliases. */
  aliases?: string[];
  /** When the advisory was first published (ISO); as-of replays ignore later ones. */
  published?: string;
}

export interface PackIncident {
  /** Source id, e.g. "ironworm-npm". */
  id: string;
  title: string;
  /** e.g. compromised_account_credentials, maintainer_sabotage. */
  cause: string | null;
  startDate: string | null;
  endDate: string | null;
  /** Who or what was targeted (e.g. a maintainer account). */
  target: { name: string; kind: string } | null;
  packages: { name: string; versions: string[] }[];
  /** Where the record came from (always a public URL). */
  source: string;
  /** Imported records are allegations until a person reviews them into the incident KB. */
  status: 'alleged';
}

export interface KnowledgePack {
  schema: typeof PACK_SCHEMA;
  builtAt: string;
  sources: PackSource[];
  malware: {
    /** Packages malicious in every version (typosquats, spam): name → refs. */
    packages: Record<string, PackMalwareRef[]>;
    /** Specific bad releases of packages that also had good ones: name → version → refs. */
    versions: Record<string, Record<string, PackMalwareRef[]>>;
  };
  incidents: PackIncident[];
  counts: { malwarePackages: number; compromisedPackages: number; compromisedVersions: number; incidents: number };
}
