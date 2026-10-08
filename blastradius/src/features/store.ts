/**
 * Packument store for the bootstrap and the backtest: slimmed packuments on disk (one JSON file per
 * package, `@scope/name` → `@scope__name.json`), optionally overlaid with recorded/reconstructed
 * manifests (the replay dataset) for releases npm has since unpublished. The live `time` map keeps
 * unpublished versions, their manifests are gone; the overlay puts back the ones we can cite.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Packument } from '../enrich/npm/types.js';
import { isObject } from '../enrich/npm/registry.js';

export function packumentFile(dir: string, name: string): string {
  return join(dir, `${name.replace('/', '__')}.json`);
}

export interface PackumentStore {
  get(name: string): Packument | undefined;
  /** Where each loaded packument came from ('cache', 'overlay', 'cache+overlay'). */
  origin(name: string): string | undefined;
  /** First release (ms) of `name` at or before `asOf`; null when none by then, undefined when unknown. */
  firstPublished(name: string, asOf: number): number | null | undefined;
}

function readJson(file: string): Packument | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const p = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return isObject(p) ? (p as Packument) : undefined;
  } catch {
    return undefined;
  }
}

/** A manifest the replay dataset rebuilt from an advisory (not recorded from the registry). */
export function isReconstructed(m: unknown): boolean {
  return isObject(m) && isObject(m._replay) && m._replay.reconstructed === true;
}

/**
 * Live packument plus overlay releases missing from it. Overlay `time` entries fill gaps only.
 * With `dropReconstructed`, a manifest rebuilt from an advisory is not used (its `time` entry still
 * is): advisories rarely state the publisher, maintainers, scripts or dependencies, so those fields
 * are partly guesses and must not become training features.
 */
export function mergeOverlay(live: Packument | undefined, overlay: Packument | undefined, opts: { dropReconstructed?: boolean } = {}): Packument | undefined {
  if (!overlay) return live;
  const versions = { ...(live && isObject(live.versions) ? live.versions : {}) };
  const time = { ...(live && isObject(live.time) ? live.time : {}) };
  const ov = isObject(overlay.versions) ? overlay.versions : {};
  const ot = isObject(overlay.time) ? overlay.time : {};
  if (!live && !opts.dropReconstructed) return overlay;
  if (!live) Object.assign(time, ot);
  for (const [v, m] of Object.entries(ov)) {
    if (Object.hasOwn(versions, v)) continue;
    if (!Object.hasOwn(time, v) && Object.hasOwn(ot, v)) time[v] = ot[v];
    if (opts.dropReconstructed && isReconstructed(m)) continue;
    versions[v] = m;
  }
  return { ...(live ?? overlay), versions, time };
}

/** Packuments kept in memory at once (least recently used are dropped; a dataset run reads tens of thousands). */
const MEMO_MAX = 4000;

export function openStore(opts: { cacheDir?: string; overlayDir?: string; dropReconstructed?: boolean }): PackumentStore {
  const memo = new Map<string, { p: Packument | undefined; origin?: string }>();
  const load = (name: string) => {
    let hit = memo.get(name);
    if (hit) {
      memo.delete(name);
      memo.set(name, hit);
    } else {
      if (memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value!);
      const live = opts.cacheDir ? readJson(packumentFile(opts.cacheDir, name)) : undefined;
      const over = opts.overlayDir ? readJson(packumentFile(opts.overlayDir, name)) : undefined;
      const p = mergeOverlay(live, over, { dropReconstructed: opts.dropReconstructed === true });
      hit = { p, ...(p ? { origin: live && over ? 'cache+overlay' : live ? 'cache' : 'overlay' } : {}) };
      memo.set(name, hit);
    }
    return hit;
  };
  return {
    get: (name) => load(name).p,
    origin: (name) => load(name).origin,
    firstPublished(name, asOf) {
      const p = load(name).p;
      if (!p) return undefined;
      let first: number | null = null;
      for (const [k, t] of Object.entries(isObject(p.time) ? p.time : {})) {
        if (k === 'created' || k === 'modified' || k === 'unpublished' || typeof t !== 'string') continue;
        const ms = Date.parse(t);
        if (Number.isFinite(ms) && ms <= asOf && (first === null || ms < first)) first = ms;
      }
      return first;
    },
  };
}
