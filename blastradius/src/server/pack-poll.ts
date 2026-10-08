/**
 * Pack polling (docs/FEEDS-AND-DETECTORS.md §2.3, step 2): read the feeds `listing.json` with
 * If-None-Match, download a newer pack only, verify its SHA-256 and that it loads, then swap the
 * file atomically (write + rename). The AlertWatcher reloads the pack when the file changes, and
 * `onSwap` asks it to re-check every org at once. Freshness: the listing's newestModified.
 *
 *   BLASTRADIUS_PACK=/var/lib/blastradius/pack.json.gz
 *   BLASTRADIUS_PACK_LISTING_URL=https://.../listing.json   (https only, except loopback)
 *   BLASTRADIUS_PACK_POLL_MINUTES=30
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { loadPack } from '../pack/load.js';
import { webhookAllowed } from './watch.js';

export interface PackPollerOptions {
  listingUrl: string;
  packPath: string;
  fetchImpl?: typeof fetch;
  log?: (m: string) => void;
  /** Called after a new pack is in place (e.g. AlertWatcher.checkAll). */
  onSwap?: (info: { version: string; sha256: string; newestModified: string | null }) => unknown;
  /** Packs above this size are refused (default 256 MB). */
  maxBytes?: number;
}

export type PollResult = 'not-modified' | 'same' | 'swapped';

export class PackPoller {
  private etag: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (m: string) => void;

  constructor(private readonly opts: PackPollerOptions) {
    // Same rule as webhooks: https anywhere, plain http only on this machine; no credentials in URLs.
    if (!webhookAllowed(opts.listingUrl)) throw new Error('pack listing URL must be https (http only to localhost) without credentials');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.log ?? (() => {});
  }

  async poll(): Promise<PollResult> {
    const headers: Record<string, string> = {};
    if (this.etag) headers['if-none-match'] = this.etag;
    const res = await this.fetchImpl(this.opts.listingUrl, { headers, signal: AbortSignal.timeout(30_000) });
    if (res.status === 304) return 'not-modified';
    if (!res.ok) throw new Error(`listing: HTTP ${res.status}`);
    const listing = JSON.parse(await res.text()) as { version?: unknown; url?: unknown; sha256?: unknown; bytes?: unknown; newestModified?: unknown };
    if (typeof listing.url !== 'string' || typeof listing.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(listing.sha256)) throw new Error('listing: missing url or sha256');
    const etag = res.headers.get('etag');
    const current = existsSync(this.opts.packPath) ? createHash('sha256').update(await readFile(this.opts.packPath)).digest('hex') : null;
    if (current === listing.sha256) {
      this.etag = etag;
      return 'same';
    }
    const packUrl = new URL(listing.url, this.opts.listingUrl).toString();
    if (!webhookAllowed(packUrl)) throw new Error('listing: pack URL must be https (http only to localhost)');
    const pr = await this.fetchImpl(packUrl, { signal: AbortSignal.timeout(300_000) });
    if (!pr.ok) throw new Error(`pack: HTTP ${pr.status}`);
    const bytes = Buffer.from(await pr.arrayBuffer());
    if (bytes.length > (this.opts.maxBytes ?? 256 * 1024 * 1024)) throw new Error('pack: too large');
    const sha = createHash('sha256').update(bytes).digest('hex');
    if (sha !== listing.sha256) throw new Error(`pack: SHA-256 ${sha} does not match the listing (${listing.sha256})`);
    const tmp = `${this.opts.packPath}.tmp-${process.pid}`;
    await writeFile(tmp, bytes);
    try {
      await loadPack(tmp, sha); // schema check before it replaces a working pack
      await rename(tmp, this.opts.packPath);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
    this.etag = etag;
    const info = { version: String(listing.version ?? ''), sha256: sha, newestModified: typeof listing.newestModified === 'string' ? listing.newestModified : null };
    this.log(`pack: ${info.version} in place (sha256 ${sha.slice(0, 12)}…, newest record ${info.newestModified ?? 'unknown'})`);
    await this.opts.onSwap?.(info);
    return 'swapped';
  }

  start(intervalMinutes: number): void {
    const tick = () => void this.poll().catch((e) => this.log(`pack poll failed: ${(e as Error).message}`));
    tick();
    this.timer = setInterval(tick, intervalMinutes * 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
