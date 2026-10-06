/** Normalise source-repository references (untrusted) into a RepoValue-like shape. */
import type { RepoValue } from '../../core/types.js';

const HOSTS: Record<string, RepoValue['host']> = {
  'github.com': 'github',
  'gitlab.com': 'gitlab',
  'bitbucket.org': 'bitbucket',
};
const SEGMENT = /^[A-Za-z0-9_.-]{1,100}$/;

export interface NormalizedRepo {
  url: string;
  host: RepoValue['host'];
  owner?: string;
  name?: string;
  /** "github.com/owner/repo" for known hosts. */
  projectId?: string;
}

/**
 * Accepts "github.com/o/r" (deps.dev project ids), "https://github.com/o/r(.git)(/tree/..)",
 * "git+https://…", "git://…", "git+ssh://git@github.com/o/r.git" and "git@github.com:o/r.git".
 * Returns undefined for anything that is not a plausible http(s) repository URL.
 */
export function normalizeRepoUrl(input: unknown): NormalizedRepo | undefined {
  if (typeof input !== 'string') return undefined;
  let s = input.trim();
  if (!s || s.length > 500) return undefined;
  s = s.replace(/^git\+/, '');
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(s); // git@github.com:o/r.git
  if (scp) s = `https://${scp[1]}/${scp[2]}`;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return undefined;
  }
  if (!['https:', 'http:', 'git:', 'ssh:'].includes(u.protocol)) return undefined;
  const hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  const host = HOSTS[hostname];
  if (!host) {
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
    if (!hostname.includes('.')) return undefined;
    return { url: `https://${hostname}${u.pathname.replace(/\.git$/, '').replace(/\/+$/, '')}`, host: 'other' };
  }
  const [owner, rawName] = u.pathname.split('/').filter(Boolean);
  const name = rawName?.replace(/\.git$/, '');
  if (!owner || !name || !SEGMENT.test(owner) || !SEGMENT.test(name)) return undefined;
  return { url: `https://${hostname}/${owner}/${name}`, host, owner, name, projectId: `${hostname}/${owner}/${name}`.toLowerCase() };
}
