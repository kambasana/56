/**
 * Parse GitHub FUNDING.yml (untrusted text).
 * Format: https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/displaying-a-sponsor-button-in-your-repository
 */
import { parse } from 'yaml';
import type { FundingSource } from '../../core/types.js';

export const MAX_FUNDING_YML_BYTES = 16 * 1024;
const MAX_PER_KEY = 20;
const HANDLE_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const TIDELIFT_RE = /^[a-z]{2,20}\/(?:@[a-z0-9._~-]+\/)?[A-Za-z0-9._~-]{1,214}$/;

/** Platform key → profile URL builder. Keys are the documented FUNDING.yml keys. */
const PLATFORMS: Record<string, (handle: string) => string> = {
  github: (h) => `https://github.com/sponsors/${h}`,
  patreon: (h) => `https://www.patreon.com/${h}`,
  open_collective: (h) => `https://opencollective.com/${h}`,
  ko_fi: (h) => `https://ko-fi.com/${h}`,
  tidelift: (h) => `https://tidelift.com/funding/github/${h}`,
  community_bridge: (h) => `https://funding.communitybridge.org/projects/${h}`,
  liberapay: (h) => `https://liberapay.com/${h}`,
  issuehunt: (h) => `https://issuehunt.io/r/${h}`,
  lfx_crowdfunding: (h) => `https://crowdfunding.lfx.linuxfoundation.org/projects/${h}`,
  polar: (h) => `https://polar.sh/${h}`,
  buy_me_a_coffee: (h) => `https://buymeacoffee.com/${h}`,
  thanks_dev: (h) => `https://thanks.dev/${h}`,
  otechie: (h) => `https://otechie.com/${h}`,
};

function asList(v: unknown): string[] {
  const items = Array.isArray(v) ? v : [v];
  return items
    .slice(0, MAX_PER_KEY)
    .filter((x): x is string | number => typeof x === 'string' || typeof x === 'number')
    .map((x) => String(x).trim())
    .filter(Boolean);
}

function safeHttpUrl(s: string): string | undefined {
  if (s.length > 2048) return undefined;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parse FUNDING.yml into funding sources. Unknown keys and malformed values are
 * ignored; invalid YAML yields []. Never throws.
 */
export function parseFundingYml(text: string): FundingSource[] {
  if (text.length > MAX_FUNDING_YML_BYTES) text = text.slice(0, MAX_FUNDING_YML_BYTES);
  let doc: unknown;
  try {
    doc = parse(text, { maxAliasCount: 10, prettyErrors: false, uniqueKeys: false });
  } catch {
    return [];
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return [];
  const out: FundingSource[] = [];
  for (const [key, raw] of Object.entries(doc as Record<string, unknown>)) {
    if (raw === null || raw === undefined) continue;
    const platform = key.toLowerCase();
    if (platform === 'custom') {
      for (const s of asList(raw)) {
        const url = safeHttpUrl(s);
        if (url) out.push({ platform: 'custom', url });
      }
      continue;
    }
    const build = Object.hasOwn(PLATFORMS, platform) ? PLATFORMS[platform] : undefined;
    if (!build) continue;
    for (const handle of asList(raw)) {
      const ok = platform === 'tidelift' ? TIDELIFT_RE.test(handle) : HANDLE_RE.test(handle);
      if (ok) out.push({ platform, handle, url: build(handle) });
    }
  }
  return out;
}
