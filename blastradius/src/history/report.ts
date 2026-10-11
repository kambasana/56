/**
 * ScanResult.history from the git enricher's facts: one entry per repository, with the packages
 * that declare it. Undefined when the scan collected no history.
 */
import type { Fact, HistoryReport, HistoryReportRepo, PurlString } from '../core/types.js';

export function buildHistoryReport(facts: readonly Fact[]): HistoryReport | undefined {
  const byRepo = new Map<string, HistoryReportRepo>();
  const contributors = new Map<PurlString, Extract<Fact, { kind: 'contributors' }>>();
  for (const f of facts) if (f.kind === 'contributors') contributors.set(f.subject, f);
  for (const f of facts) {
    if (f.kind !== 'commit_history') continue;
    const c = contributors.get(f.subject);
    if (!c) continue;
    let r = byRepo.get(f.value.repo);
    if (!r) byRepo.set(f.value.repo, (r = { repo: f.value.repo, packages: [], contributors: c.value, history: f.value, fetchedAt: f.fetchedAt }));
    if (!r.packages.includes(f.subject)) r.packages.push(f.subject);
  }
  if (byRepo.size === 0) return undefined;
  const repos = [...byRepo.values()].sort((a, b) => a.repo.localeCompare(b.repo));
  for (const r of repos) r.packages.sort();
  return { repos };
}
