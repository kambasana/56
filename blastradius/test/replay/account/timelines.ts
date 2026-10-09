/**
 * On-disk encoding of the recorded package timelines (data/timelines.json). Lossless; it only
 * stores each distinct maintainer list once and each version as a tuple:
 *   [version, publishTime, publisher ('' when the manifest is gone), maintainerSetIndex (-1: none), gone (0|1)]
 */
import type { PackageTimeline } from '../../../src/watch/account.js';

export interface EncodedTimelines {
  format: 'timelines/v1';
  maintainerSets: string[][];
  packages: { n: string; missing?: true; v: [string, string, string, number, 0 | 1][] }[];
}

export function encodeTimelines(tls: readonly PackageTimeline[]): EncodedTimelines {
  const sets: string[][] = [];
  const index = new Map<string, number>();
  const ref = (m: string[] | undefined) => {
    if (!m) return -1;
    const k = JSON.stringify(m);
    let i = index.get(k);
    if (i === undefined) {
      i = sets.length;
      sets.push(m);
      index.set(k, i);
    }
    return i;
  };
  return {
    format: 'timelines/v1',
    maintainerSets: sets,
    packages: tls.map((t) => ({ n: t.name, ...(t.missing ? { missing: true as const } : {}), v: t.versions.map((e) => [e.v, e.t, e.u ?? '', ref(e.m), e.gone ? 1 : 0] as [string, string, string, number, 0 | 1]) })),
  };
}

export function decodeTimelines(enc: EncodedTimelines): PackageTimeline[] {
  return enc.packages.map((p) => ({
    name: p.n,
    ...(p.missing ? { missing: true as const } : {}),
    versions: p.v.map(([v, t, u, mi, gone]) => ({ v, t, ...(u ? { u } : {}), ...(mi >= 0 ? { m: enc.maintainerSets[mi]! } : {}), ...(gone ? { gone: true as const } : {}) })),
  }));
}
