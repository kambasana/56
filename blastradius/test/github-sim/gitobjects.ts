/**
 * Real git object ids for the simulator: blobs, trees and commits are hashed exactly as git
 * hashes them, so a commit the simulator makes has the id git would give the same content, and
 * the sub-tree ids of a recorded tree can be recomputed (and checked) from its blob ids.
 */
import { createHash } from 'node:crypto';
import { gitBlobSha, type TreeEntry } from '../../src/server/sources/testing.js';

export { gitBlobSha, type TreeEntry };

/** A file in a commit: a blob (regular, executable or symlink) or a submodule link. */
export interface FileEntry {
  path: string;
  /** 100644, 100755, 120000 (symlink) or 160000 (submodule). */
  mode: string;
  sha: string;
  size?: number;
}

function hashObject(kind: 'tree' | 'commit', body: Buffer): string {
  return createHash('sha1').update(`${kind} ${body.byteLength}\0`).update(body).digest('hex');
}

interface Dir {
  files: Map<string, FileEntry>;
  dirs: Map<string, Dir>;
}

/**
 * The full recursive listing (GitHub's `git/trees/{sha}?recursive=1` order: git's path order,
 * directories as their own `tree` entries) and the root tree id, from the files of a commit.
 */
export function buildTree(files: readonly FileEntry[]): { rootSha: string; entries: TreeEntry[] } {
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const f of files) {
    const parts = f.path.split('/');
    let d = root;
    for (const seg of parts.slice(0, -1)) {
      let next = d.dirs.get(seg);
      if (!next) {
        next = { files: new Map(), dirs: new Map() };
        d.dirs.set(seg, next);
      }
      d = next;
    }
    d.files.set(parts[parts.length - 1]!, f);
  }
  const entries: TreeEntry[] = [];
  const walk = (d: Dir, prefix: string): string => {
    // git sorts tree entries by name, comparing a directory as if its name ended in '/'.
    const names = [...[...d.files.keys()].map((n) => ({ n, key: n, dir: false })), ...[...d.dirs.keys()].map((n) => ({ n, key: `${n}/`, dir: true }))].sort((a, b) =>
      Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)),
    );
    const chunks: Buffer[] = [];
    for (const { n, dir } of names) {
      const path = prefix ? `${prefix}/${n}` : n;
      if (dir) {
        const at = entries.length;
        entries.push({ path, mode: '040000', type: 'tree', sha: '' });
        const sha = walk(d.dirs.get(n)!, path);
        entries[at]!.sha = sha;
        chunks.push(Buffer.from(`40000 ${n}\0`), Buffer.from(sha, 'hex'));
      } else {
        const f = d.files.get(n)!;
        const type = f.mode === '160000' ? 'commit' : 'blob';
        entries.push({ path, mode: f.mode, type, sha: f.sha, ...(type === 'blob' && f.size !== undefined ? { size: f.size } : {}) });
        chunks.push(Buffer.from(`${f.mode} ${n}\0`), Buffer.from(f.sha, 'hex'));
      }
    }
    return hashObject('tree', Buffer.concat(chunks));
  };
  const rootSha = walk(root, '');
  return { rootSha, entries };
}

export interface CommitIdentity {
  name: string;
  email: string;
  /** Unix seconds. */
  time: number;
}

/** The commit id git gives a commit object with these fields (UTC, no signature). */
export function commitSha(c: { tree: string; parents: readonly string[]; author: CommitIdentity; committer: CommitIdentity; message: string }): string {
  const who = (i: CommitIdentity) => `${i.name} <${i.email}> ${i.time} +0000`;
  const body = [`tree ${c.tree}`, ...c.parents.map((p) => `parent ${p}`), `author ${who(c.author)}`, `committer ${who(c.committer)}`, '', c.message.endsWith('\n') ? c.message : `${c.message}\n`].join('\n');
  return hashObject('commit', Buffer.from(body, 'utf8'));
}
