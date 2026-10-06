/**
 * Enricher plugin interface (PLAN §3.2).
 *
 * An enricher reads the Inventory and returns Facts. It must:
 * - do all network I/O through `ctx.http` (cache, rate limit, offline fixtures);
 * - never execute code from scanned content;
 * - skip components of ecosystems it does not handle;
 * - not throw for a single bad component: skip it (optionally report via ctx.warn);
 * - be deterministic given the same responses and `ctx.now`.
 */
import type { HttpClient } from './http.js';
import type { Fact, Inventory } from './types.js';

export interface EnrichContext {
  http: HttpClient;
  /** Reference time for age calculations (release_age, decay). Fixed per scan. */
  now: Date;
  /** True when no live network is allowed (fixtures/cache only). */
  offline: boolean;
  /**
   * True for replays (--as-of in the past). Enrichers must not report present-day state
   * (e.g. a repository's current owner) as if it had been observed at `now`.
   */
  historical?: boolean;
  /** Optional sink for non-fatal problems; they end up in ScanResult.warnings. */
  warn?: (message: string) => void;
}

export interface Enricher {
  /** Stable id, also used as Fact.source by convention: "osv", "depsdev", "npm", "github". */
  name: string;
  enrich(inv: Inventory, ctx: EnrichContext): Promise<Fact[]>;
}

/** Run enrichers sequentially; an enricher that throws becomes a warning, not a failed scan. */
export async function runEnrichers(enrichers: readonly Enricher[], inv: Inventory, ctx: EnrichContext): Promise<Fact[]> {
  const out: Fact[] = [];
  for (const e of enrichers) {
    try {
      out.push(...(await e.enrich(inv, ctx)));
    } catch (err) {
      ctx.warn?.(`enricher ${e.name} failed: ${(err as Error).message}`);
    }
  }
  return out;
}
