/**
 * npm registry "packument" shapes (GET https://registry.npmjs.org/{name}).
 * Documented at https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md.
 *
 * Everything here is untrusted input: every field is optional and may have the
 * wrong type. Code reading it goes through the guards in `packument.ts`.
 */
import type {
  InstallHook,
  InstallScriptValue,
  MaintainerChangeValue,
  PublisherChangeValue,
} from '../../core/types.js';

export interface NpmPerson {
  name?: unknown;
  email?: unknown;
  /** Present when the version was published via npm trusted publishing (OIDC). */
  trustedPublisher?: unknown;
}

export interface NpmDist {
  tarball?: unknown;
  shasum?: unknown;
  integrity?: unknown;
  attestations?: { url?: unknown; provenance?: { predicateType?: unknown } };
}

export interface NpmVersionManifest {
  name?: unknown;
  version?: unknown;
  _npmUser?: NpmPerson;
  maintainers?: unknown;
  scripts?: unknown;
  dependencies?: unknown;
  optionalDependencies?: unknown;
  repository?: unknown;
  funding?: unknown;
  deprecated?: unknown;
  gypfile?: unknown;
  hasInstallScript?: unknown;
  dist?: NpmDist;
}

export interface Packument {
  _id?: unknown;
  name?: unknown;
  'dist-tags'?: Record<string, unknown>;
  versions?: Record<string, NpmVersionManifest>;
  /** version → ISO timestamp, plus "created"/"modified"/"unpublished". */
  time?: Record<string, unknown>;
  maintainers?: unknown;
  repository?: unknown;
}

/** One version of the publish history, with validated fields. */
export interface VersionRecord {
  version: string;
  /** ISO timestamp from `time[version]`. */
  publishedAt: string;
  publishedMs: number;
  publisher?: string;
  trustedPublisher: boolean;
  /** Maintainer handles at publish time; undefined when the manifest lacks the field. */
  maintainers?: string[];
}

/**
 * `publisher_change` with extra history context. A structural subtype of the
 * contract's PublisherChangeValue (extra fields are additive).
 */
export interface NpmPublisherChangeValue extends PublisherChangeValue {
  /** Version being scanned (the fact subject). */
  scannedVersion: string;
  /** First version the new publisher published (same as `version`). */
  firstSeenVersion: string;
  /** Days between firstSeenVersion and the scanned version (0 when they are the same). */
  daysBeforeRelease: number;
  /** Distinct accounts that published versions before firstSeenVersion, oldest first. */
  previousPublishers: string[];
  /** Runtime/optional dependency names in the scanned version that `previousVersion` did not have. */
  addedDependencies: string[];
}

/** `maintainer_change` with where the change came from. */
export interface NpmMaintainerChangeValue extends MaintainerChangeValue {
  via: 'version-history' | 'snapshot';
  /** For snapshot-derived changes: when the earlier snapshot was taken. */
  previousSnapshotAt?: string;
}

/** `install_script` plus static, non-executing measurements of the script text. */
export interface NpmInstallScriptValue extends InstallScriptValue {
  /** Untruncated length of each hook's command string. */
  lengths: Partial<Record<InstallHook, number>>;
}
