/**
 * Account-level blast radius (test/replay/account/PREREGISTRATION.md).
 *
 * - AccountIndex: which npm packages an account can publish as of time T, from recorded per-version
 *   `maintainers` (the latest version published at or before T decides).
 * - accountExposure: "account X is compromised" → every (project, package) in the stored
 *   inventories that X could publish at T, without re-scanning.
 * - burstWarnings: an account publishing new versions of ≥ N distinct packages within W.
 *
 * Deleted versions (npm removes malicious releases) keep their publish time but lose `_npmUser`.
 * Their publisher is attributed only when the previous version had exactly one maintainer; it is
 * otherwise left unknown, never guessed.
 */
import { searchExposure, type ExposureHit, type StoredInventory } from './match.js';

export interface VersionEntry {
  v: string;
  /** Publish time (ISO). */
  t: string;
  /** `_npmUser.name`, absent for deleted versions. */
  u?: string;
  /** Maintainer names recorded on this version. */
  m?: string[];
  /** The version was deleted from the registry (time survives, manifest does not). */
  gone?: true;
}

export interface PackageTimeline {
  name: string;
  missing?: true;
  versions: VersionEntry[];
}

export interface PublishEvent {
  account: string;
  name: string;
  version: string;
  at: number;
  attribution: 'npmUser' | 'sole-maintainer';
}

export class AccountIndex {
  private readonly byName = new Map<string, PackageTimeline>();
  /** account → package names whose recorded maintainers ever include it (candidates). */
  private readonly candidates = new Map<string, Set<string>>();

  constructor(timelines: Iterable<PackageTimeline>) {
    for (const tl of timelines) {
      const sorted = { ...tl, versions: [...tl.versions].sort((a, b) => Date.parse(a.t) - Date.parse(b.t)) };
      this.byName.set(tl.name, sorted);
      for (const e of sorted.versions) for (const m of e.m ?? []) (this.candidates.get(m) ?? this.candidates.set(m, new Set()).get(m)!).add(tl.name);
    }
  }

  timeline(name: string): PackageTimeline | undefined {
    return this.byName.get(name);
  }

  /** Maintainers of `name` as of `at`: those on the latest version (with a maintainer list) published at or before `at`. */
  maintainersAt(name: string, at: number): string[] | undefined {
    const tl = this.byName.get(name);
    if (!tl) return undefined;
    let found: string[] | undefined;
    for (const e of tl.versions) {
      if (Date.parse(e.t) > at) break;
      if (e.m) found = e.m;
    }
    return found;
  }

  /** Packages `account` can publish as of `at` (sorted). */
  packagesOf(account: string, at: number): string[] {
    return [...(this.candidates.get(account) ?? [])].filter((n) => this.maintainersAt(n, at)?.includes(account)).sort();
  }

  /** Publisher of one version: `_npmUser`, or the sole maintainer of the previous version. */
  publisherOf(name: string, version: string): { account: string; attribution: PublishEvent['attribution'] } | undefined {
    const tl = this.byName.get(name);
    const i = tl?.versions.findIndex((e) => e.v === version) ?? -1;
    if (!tl || i < 0) return undefined;
    const e = tl.versions[i]!;
    if (e.u) return { account: e.u, attribution: 'npmUser' };
    const prev = tl.versions.slice(0, i).reverse().find((x) => x.m);
    return prev?.m?.length === 1 ? { account: prev.m[0]!, attribution: 'sole-maintainer' } : undefined;
  }

  /** Every version published in [from, to], with its publisher when known. */
  publishEvents(from: number, to: number, names?: Iterable<string>): { events: PublishEvent[]; unattributed: number } {
    const events: PublishEvent[] = [];
    let unattributed = 0;
    for (const name of names ?? this.byName.keys()) {
      for (const e of this.byName.get(name)?.versions ?? []) {
        const at = Date.parse(e.t);
        if (at < from || at > to) continue;
        const p = this.publisherOf(name, e.v);
        if (p) events.push({ account: p.account, name, version: e.v, at, attribution: p.attribution });
        else unattributed++;
      }
    }
    return { events: events.sort((a, b) => a.at - b.at || a.name.localeCompare(b.name)), unattributed };
  }
}

/** "Account X is compromised": every (project, package) in stored inventories that X could publish at `at`. */
export function accountExposure(inventories: readonly StoredInventory[], index: AccountIndex, account: string, at: number): { packages: string[]; hits: ExposureHit[] } {
  const packages = index.packagesOf(account, at);
  const present = new Set<string>();
  for (const s of inventories) for (const c of s.inventory.components) if (c.ecosystem === 'npm') present.add(c.name);
  const hits = packages.filter((n) => present.has(n)).flatMap((n) => searchExposure(inventories, { name: n }));
  return { packages, hits };
}

export interface BurstEpisode {
  account: string;
  /** When the rule first fired (publish time of the release that reached N packages). */
  firedAt: number;
  /** Last firing merged into this episode. */
  lastAt: number;
  /** Distinct packages in the triggering window. */
  packages: string[];
}

/**
 * Burst rule: fires at t when the account published new versions of ≥ n distinct packages within
 * (t − windowMs, t]. Firings less than `episodeGapMs` apart are one episode.
 */
export function burstWarnings(events: readonly PublishEvent[], opts: { n: number; windowMs: number; episodeGapMs?: number }): BurstEpisode[] {
  const gap = opts.episodeGapMs ?? 24 * 3600_000;
  const byAccount = new Map<string, PublishEvent[]>();
  for (const e of events) (byAccount.get(e.account) ?? byAccount.set(e.account, []).get(e.account)!).push(e);
  const out: BurstEpisode[] = [];
  for (const [account, list] of byAccount) {
    list.sort((a, b) => a.at - b.at);
    let start = 0;
    let current: BurstEpisode | undefined;
    for (let i = 0; i < list.length; i++) {
      const t = list[i]!.at;
      while (list[start]!.at <= t - opts.windowMs) start++;
      const pkgs = new Set(list.slice(start, i + 1).map((e) => e.name));
      if (pkgs.size < opts.n) continue;
      if (current && t - current.lastAt < gap) {
        current.lastAt = t;
        continue;
      }
      current = { account, firedAt: t, lastAt: t, packages: [...pkgs].sort() };
      out.push(current);
    }
  }
  return out.sort((a, b) => a.firedAt - b.firedAt || a.account.localeCompare(b.account));
}
