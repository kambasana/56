/**
 * Normalise package.json `repository` and `funding` fields (untrusted input).
 */
import type { FundingSource, RepoValue } from '../../core/types.js';
import { isObject } from './registry.js';

const MAX_URL = 2048;
const SEGMENT_RE = /^[A-Za-z0-9_.-]{1,100}$/;

const HOSTS: Record<string, RepoValue['host']> = {
  'github.com': 'github',
  'www.github.com': 'github',
  'gitlab.com': 'gitlab',
  'www.gitlab.com': 'gitlab',
  'bitbucket.org': 'bitbucket',
  'www.bitbucket.org': 'bitbucket',
};

const SHORTCUT_HOSTS: Record<string, string> = { github: 'github.com', gitlab: 'gitlab.com', bitbucket: 'bitbucket.org' };

/**
 * Parse a repository reference into a RepoValue (without `via`).
 * Accepts the forms npm accepts: "git+https://github.com/o/r.git", "git://github.com/o/r",
 * "git@github.com:o/r.git", "github:o/r", "o/r" (GitHub shorthand), "https://github.com/o/r/tree/main/pkg".
 * Returns undefined for anything that is not a recognisable http(s) repo URL.
 */
export function parseRepoUrl(input: string): Omit<RepoValue, 'via'> | undefined {
  let s = input.trim();
  if (!s || s.length > MAX_URL) return undefined;

  const shortcut = /^(github|gitlab|bitbucket):([^/\s]+)\/([^/\s#]+)/.exec(s);
  if (shortcut) s = `https://${SHORTCUT_HOSTS[shortcut[1]!]}/${shortcut[2]}/${shortcut[3]}`;
  else if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s)) s = `https://github.com/${s}`;

  // scp-like "git@host:owner/repo.git"
  const scp = /^(?:[\w.-]+@)?([\w.-]+\.[a-z]{2,}):(?!\/\/)(.+)$/i.exec(s);
  if (scp && !/^[a-z+]+:\/\//i.test(s)) s = `https://${scp[1]}/${scp[2]}`;

  s = s.replace(/^git\+/, '').replace(/^(git|ssh|git\+ssh):\/\//, 'https://');

  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
  const hostname = u.hostname.toLowerCase();
  const host = HOSTS[hostname] ?? 'other';
  const parts = u.pathname.split('/').filter(Boolean).map(safeDecode);

  if (host === 'other') {
    if (parts.length === 0) return undefined;
    return { url: `https://${hostname}/${parts.slice(0, 2).join('/').replace(/\.git$/, '')}`, host };
  }
  const owner = parts[0];
  const name = parts[1]?.replace(/\.git$/, '');
  if (!owner || !name || !SEGMENT_RE.test(owner) || !SEGMENT_RE.test(name)) return undefined;
  const canonicalHost = hostname.replace(/^www\./, '');
  const out: Omit<RepoValue, 'via'> = { url: `https://${canonicalHost}/${owner}/${name}`, host, owner, name };
  // ".../tree/<branch>/<dir>" carries a monorepo directory.
  if ((parts[2] === 'tree' || parts[2] === 'blob') && parts.length > 4) out.directory = parts.slice(4).join('/');
  return out;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** package.json `repository`: a string or `{ type, url, directory }`. */
export function repoFromManifestField(field: unknown): Omit<RepoValue, 'via'> | undefined {
  let url: unknown = field;
  let directory: unknown;
  if (isObject(field)) {
    url = field.url;
    directory = field.directory;
  }
  if (typeof url !== 'string') return undefined;
  const parsed = parseRepoUrl(url);
  if (!parsed) return undefined;
  if (typeof directory === 'string' && directory.length > 0 && directory.length <= 300 && !directory.includes('..')) {
    parsed.directory = directory.replace(/^\.?\/+/, '').replace(/\/+$/, '');
  }
  return parsed;
}

const FUNDING_HOSTS: [RegExp, string][] = [
  [/^(www\.)?github\.com$/, 'github'],
  [/^(www\.)?opencollective\.com$/, 'open_collective'],
  [/^(www\.)?patreon\.com$/, 'patreon'],
  [/^(www\.)?tidelift\.com$/, 'tidelift'],
  [/^(www\.)?ko-fi\.com$/, 'ko_fi'],
  [/^(www\.)?buymeacoffee\.com$/, 'buy_me_a_coffee'],
  [/^(www\.)?liberapay\.com$/, 'liberapay'],
  [/^(www\.)?polar\.sh$/, 'polar'],
  [/^(www\.)?thanks\.dev$/, 'thanks_dev'],
  [/^(www\.)?paypal\.(me|com)$/, 'paypal'],
];

const HANDLE_RE = /^[A-Za-z0-9_.-]{1,100}$/;

/** Classify a funding URL: platform + handle where the URL shape makes it unambiguous. */
export function fundingSourceFromUrl(rawUrl: string, declaredType?: string): FundingSource | undefined {
  if (rawUrl.length > MAX_URL) return undefined;
  let u: URL;
  try {
    u = new URL(rawUrl.trim());
  } catch {
    return undefined;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);
  const platform = FUNDING_HOSTS.find(([re]) => re.test(host))?.[1];
  const url = u.toString();
  if (!platform) {
    const t = declaredType && HANDLE_RE.test(declaredType) ? declaredType.toLowerCase() : 'custom';
    return { platform: t === 'individual' ? 'custom' : t, url };
  }
  let handle: string | undefined;
  if (platform === 'github') {
    // github.com/sponsors/<login>, or github.com/<owner>/<repo>?sponsor=1 (owner is the sponsorable account)
    handle = parts[0] === 'sponsors' ? parts[1] : parts[0];
  } else if (platform === 'tidelift') {
    // tidelift.com/funding/github/npm/<pkg> — no account handle
    handle = undefined;
  } else {
    handle = parts[0];
  }
  const src: FundingSource = { platform, url };
  if (handle && HANDLE_RE.test(handle)) src.handle = handle;
  return src;
}

/** package.json `funding`: string | { type, url } | array of those. */
export function fundingFromManifestField(field: unknown, max = 20): FundingSource[] {
  const items = Array.isArray(field) ? field.slice(0, max) : field === undefined ? [] : [field];
  const out: FundingSource[] = [];
  for (const item of items) {
    let url: unknown = item;
    let type: unknown;
    if (isObject(item)) {
      url = item.url;
      type = item.type;
    }
    if (typeof url !== 'string') continue;
    const src = fundingSourceFromUrl(url, typeof type === 'string' ? type : undefined);
    if (src && !out.some((o) => o.url === src.url)) out.push(src);
  }
  return out;
}
