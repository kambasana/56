/**
 * Repo connectors (docs/CONNECTORS.md): one host-neutral interface, one adapter per code host.
 *
 * `scope` is what the host grants access through: a GitHub App installation id, a GitLab group
 * token, and so on. Adapters only read; nothing they return is ever executed.
 */
import type { InventoryFileKind } from '../../ingest/select.js';

export type SourceHost = 'github';

export interface SourceRepoInfo {
  /** The host's stable repository id (survives renames and transfers). */
  id: string;
  /** owner/name */
  fullName: string;
  defaultBranch: string;
  private: boolean;
  archived: boolean;
  /** Browser URL of the repository (also the project target). */
  htmlUrl: string;
}

export interface InventoryFileRef {
  path: string;
  kind: InventoryFileKind;
  /** Bytes, from the tree listing. */
  size: number;
}

export interface RepoInventoryFiles {
  /** The commit the listing was taken at (every later read uses it, so the snapshot is consistent). */
  commit: string;
  files: InventoryFileRef[];
  /** The host cut the tree listing short: the file list may be incomplete. */
  truncated: boolean;
}

/** Raw request, as received: the body bytes exactly as signed. */
export interface WebhookRequest {
  headers: { get(name: string): string | null };
  body: Uint8Array;
}

export interface PushInfo {
  repoId: string;
  fullName: string;
  /** Full ref, e.g. refs/heads/main. */
  ref: string;
  /** Commit after the push (null when the ref was deleted). */
  after: string | null;
  deleted: boolean;
  /** Paths added, modified or removed by the pushed commits. */
  changedPaths: string[];
  /** The event did not list every commit or file: treat as touching everything. */
  incomplete: boolean;
}

export interface SourceAdapter {
  readonly host: SourceHost;
  /** Repositories the scope can read. */
  listRepos(scope: string): Promise<SourceRepoInfo[]>;
  /** One repository, or null when the scope cannot see it. */
  getRepo(scope: string, fullName: string): Promise<SourceRepoInfo | null>;
  defaultBranch(scope: string, fullName: string): Promise<string>;
  /** Manifests, lockfiles (every workspace root) and workflows at `ref`, from the host's tree API. */
  findLockfiles(scope: string, fullName: string, ref: string): Promise<RepoInventoryFiles>;
  /** File contents at `ref` (a commit sha from findLockfiles), keyed by path. */
  readFiles(scope: string, fullName: string, ref: string, paths: readonly string[]): Promise<Map<string, Uint8Array>>;
  /** True only when the delivery carries a valid signature for this host's webhook secret. */
  verifyWebhook(req: WebhookRequest): boolean;
  /** The push in host-neutral terms, or null when the payload is not a usable push. */
  parsePush(payload: unknown): PushInfo | null;
}

/**
 * The scope (or the repository) can no longer be read: a revoked or suspended installation, an
 * expired token, a removed repository. Sources and repos are marked "access lost"; nothing is deleted.
 */
export class SourceAccessError extends Error {
  constructor(
    message: string,
    /** 'scope': the whole installation or token; 'repo': this repository only. */
    readonly level: 'scope' | 'repo',
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SourceAccessError';
  }
}
