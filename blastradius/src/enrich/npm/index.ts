/**
 * npm registry enricher.
 *
 * For every npm component: GET https://registry.npmjs.org/{name} (full
 * packument, once per package) and derive, for the scanned version:
 *   maintainers (package), publisher, publisher_change, maintainer_change,
 *   install_script, provenance, release_age, repo (package), funding (package).
 * See packument.ts for the derivation rules.
 *
 * Snapshots: when enabled, a summary of each packument is stored under
 * `<user cache dir>/snapshots/npm/` (see core/paths.ts) and compared with the previous snapshot
 * to emit a snapshot-based `maintainer_change`. By default snapshots are only
 * used online, so offline/backtest runs never mix fixture data with real history; historical
 * runs (ctx.historical) never read or record snapshots, even with an explicitly supplied store.
 */
import { OfflineMissError, SkippedHosts } from '../../core/http.js';
import type { EnrichContext, Enricher } from '../../core/plugin.js';
import { makeFact, npmPurl } from '../../core/types.js';
import type { Component, Fact, Inventory } from '../../core/types.js';
import { firstPublishedMs, markYoungDependencies, packumentFacts, summarizePackument } from './packument.js';
import { NPM_REGISTRY, fetchPackument, isValidNpmName, npmPackagePage } from './registry.js';
import { NpmSnapshotStore, diffSnapshots } from './snapshots.js';
import type { NpmMaintainerChangeValue, Packument } from './types.js';
import { errorMessage, mapLimit } from './util.js';

export { analyzeInstallScripts, scriptFlags, INSTALL_HOOKS } from './scripts.js';
export { fundingFromManifestField, fundingSourceFromUrl, parseRepoUrl, repoFromManifestField } from './repo.js';
export {
  addedDependencies,
  deriveMaintainerChanges,
  deriveProvenance,
  derivePublisherChange,
  deriveReleaseAge,
  isPatchBump,
  markYoungDependencies,
  firstPublishedMs,
  packumentFacts,
  parseMaintainers,
  summarizePackument,
  versionHistory,
} from './packument.js';
export type { PackumentFactOptions, PackumentSummary } from './packument.js';
export { NPM_REGISTRY, fetchPackument, isValidNpmName, packumentUrl, npmPackagePage } from './registry.js';
export { DEFAULT_SNAPSHOT_DIR, NpmSnapshotStore, diffSnapshots } from './snapshots.js';
export type { NpmSnapshot, SnapshotChange } from './snapshots.js';
export type * from './types.js';
export { errorMessage, mapLimit } from './util.js';

export interface NpmEnricherOptions {
  /** Registry base URL (default https://registry.npmjs.org). */
  registry?: string;
  /** Parallel packument fetches (default 12; HttpClient also rate-limits per host). */
  concurrency?: number;
  /** Change window in days for publisher/maintainer changes (default 365). */
  changeWindowDays?: number;
  /** Keep public registry e-mail addresses in facts (default false). */
  includeEmails?: boolean;
  /**
   * Snapshot store. 'auto' (default) = enabled only when ctx.offline is false;
   * true = always; false = never; or pass a store instance. Whatever the setting, snapshots are
   * neither read nor recorded when ctx.historical is true (backtests / --as-of replays).
   */
  snapshots?: 'auto' | boolean | NpmSnapshotStore;
  /** Snapshot directory for 'auto' / true (default <user cache dir>/snapshots). */
  snapshotDir?: string;
}

const SOURCE = 'npm';

export function createNpmEnricher(opts: NpmEnricherOptions = {}): Enricher {
  const registry = opts.registry ?? NPM_REGISTRY;
  const concurrency = Math.max(1, opts.concurrency ?? 12);

  return {
    name: SOURCE,
    async enrich(inv: Inventory, ctx: EnrichContext): Promise<Fact[]> {
      const store = resolveStore(opts, ctx);
      const byName = new Map<string, Component[]>();
      for (const c of inv.components) {
        if (c.ecosystem !== 'npm') continue;
        if (!isValidNpmName(c.name)) {
          ctx.warn?.(`npm: skipping component with invalid package name ${JSON.stringify(c.name.slice(0, 100))}`);
          continue;
        }
        const list = byName.get(c.name) ?? [];
        list.push(c);
        byName.set(c.name, list);
      }

      const facts: Fact[] = [];
      const names = [...byName.keys()].sort();
      const offlineMisses: string[] = [];
      const skipped = new SkippedHosts();
      // First release per package (null: none by ctx.now), for dependency_added.
      const firstPublished = new Map<string, number | null>();
      await mapLimit(names, concurrency, async (name) => {
        let packument: Packument | null;
        try {
          packument = await fetchPackument(ctx.http, name, registry);
        } catch (err) {
          if (skipped.add(err)) return;
          if (err instanceof OfflineMissError) offlineMisses.push(name);
          else ctx.warn?.(`npm: could not fetch packument for ${name}: ${errorMessage(err)}`);
          return;
        }
        if (!packument) {
          ctx.warn?.(`npm: package ${name} not found in registry (404)`);
          return;
        }
        firstPublished.set(name, firstPublishedMs(packument, ctx.now) ?? null);
        const seen = new Set<string>();
        for (const c of byName.get(name)!) {
          if (seen.has(c.version)) continue;
          seen.add(c.version);
          const vf = packumentFacts(packument, name, c.version, {
            now: ctx.now,
            changeWindowDays: opts.changeWindowDays,
            includeEmails: opts.includeEmails,
          });
          if (!hasVersion(packument, c.version)) {
            ctx.warn?.(`npm: ${name}@${c.version} not present in registry metadata (unpublished or removed)`);
          }
          for (const f of vf) {
            // Package-level facts are emitted once per package.
            if (f.subject === npmPurl(name) && facts.some((g) => g.kind === f.kind && g.subject === f.subject)) continue;
            facts.push(f);
          }
        }
        if (store) facts.push(...(await snapshotFacts(store, packument, name, ctx)));
      });
      // Added dependencies are usually in the inventory already; fetch the few that are not.
      const missing = [
        ...new Set(facts.flatMap((f) => (f.kind === 'dependency_added' ? f.value.added : [])).filter((n) => !firstPublished.has(n) && isValidNpmName(n))),
      ]
        .sort()
        .slice(0, 50);
      await mapLimit(missing, concurrency, async (name) => {
        try {
          const p = await fetchPackument(ctx.http, name, registry);
          firstPublished.set(name, p ? (firstPublishedMs(p, ctx.now) ?? null) : null);
        } catch (err) {
          skipped.add(err); // unknown: never counted as young
        }
      });
      markYoungDependencies(facts, (n) => firstPublished.get(n));
      skipped.flush('npm', ctx.warn);
      if (offlineMisses.length > 0) {
        const shown = offlineMisses.sort().slice(0, 10).map((n) => n.slice(0, 100));
        ctx.warn?.(
          `npm: ${offlineMisses.length} packument(s) missing from fixtures/cache in offline mode: ${shown.join(', ')}${offlineMisses.length > 10 ? ', …' : ''}`,
        );
      }
      return dedupe(facts);
    },
  };
}

function hasVersion(p: Packument, version: string): boolean {
  return typeof p.versions === 'object' && p.versions !== null && Object.hasOwn(p.versions, version);
}

/**
 * Historical replays (ctx.historical, e.g. --as-of) never use snapshots, even with an explicitly
 * supplied store: today's registry state must not be recorded as history dated in the past, and
 * a snapshot taken later must not produce a maintainer_change for an earlier reference time.
 */
function resolveStore(opts: NpmEnricherOptions, ctx: EnrichContext): NpmSnapshotStore | undefined {
  if (ctx.historical) return undefined;
  const s = opts.snapshots ?? 'auto';
  if (s instanceof NpmSnapshotStore) return s;
  if (s === false || (s === 'auto' && ctx.offline)) return undefined;
  return new NpmSnapshotStore(opts.snapshotDir);
}

async function snapshotFacts(store: NpmSnapshotStore, p: Packument, name: string, ctx: EnrichContext): Promise<Fact[]> {
  const summary = summarizePackument(p, name);
  const facts: Fact[] = [];
  try {
    const previous = await store.latestBefore(name, ctx.now);
    const change = previous ? diffSnapshots(previous, summary) : undefined;
    if (change) {
      const value: NpmMaintainerChangeValue = {
        added: change.added,
        removed: change.removed,
        changedAt: ctx.now.toISOString(),
        via: 'snapshot',
        previousSnapshotAt: change.previousSnapshotAt,
      };
      facts.push(makeFact('maintainer_change', npmPurl(name), value, { source: SOURCE, fetchedAt: ctx.now, evidence: [npmPackagePage(name)] }));
    }
    await store.record({ ...summary, name, takenAt: ctx.now.toISOString() });
  } catch (err) {
    ctx.warn?.(`npm: snapshot store error for ${name}: ${errorMessage(err)}`);
  }
  return facts;
}

/** Stable order and no exact duplicates (same subject/kind/value). */
function dedupe(facts: Fact[]): Fact[] {
  const seen = new Set<string>();
  const out: Fact[] = [];
  for (const f of facts) {
    const key = `${f.subject}\u0000${f.kind}\u0000${JSON.stringify(f.value)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out.sort((a, b) => (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
}
