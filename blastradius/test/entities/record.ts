/**
 * Records the Tier 0 entity fixture from a real scan (needs network; docs/WHO-BEHIND-PLAN.md
 * "Tier 0"):
 *
 *   npx tsx test/entities/record.ts <parse-server checkout at the pinned commit> <out dir>
 *
 * Runs the real pipeline (all report formats, no git history), then writes
 * test/fixtures/entities/parse-server-facts.json.gz: the facts entity resolution reads
 * (maintainers, publisher, repo, repo_owner, funding, org_profile), with e-mail addresses removed.
 * The pinned target is in scans/target-commits.txt of the teardown and in the fixture header.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { scan } from '../../src/pipeline.js';
import type { Fact } from '../../src/core/types.js';

const KINDS = new Set(['maintainers', 'publisher', 'repo', 'repo_owner', 'funding', 'org_profile']);

/** Entity facts without e-mail addresses (resolution only uses their domain for unreviewed candidates). */
export function trimFact(f: Fact): Fact {
  if (f.kind === 'maintainers') return { ...f, value: { ...f.value, maintainers: f.value.maintainers.map((m) => ({ name: m.name })) } };
  if (f.kind === 'publisher') {
    const { email: _e, ...rest } = f.value as typeof f.value & { email?: string };
    return { ...f, value: rest };
  }
  return f;
}

async function main(): Promise<void> {
  const [target, outDir] = process.argv.slice(2);
  if (!target || !outDir) throw new Error('usage: record.ts <target> <outDir>');
  const commit = execFileSync('git', ['-C', target, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const started = Date.now();
  const { result, facts, files } = await scan({ target, outDir, offline: false, formats: ['json', 'html', 'sarif', 'cyclonedx', 'spdx'], log: (m) => process.stderr.write(`… ${m}\n`) });
  const kept = facts.filter((f) => KINDS.has(f.kind)).map(trimFact);
  const fixture = {
    target: 'https://github.com/parse-community/parse-server',
    commit,
    recordedAt: new Date().toISOString(),
    note: 'Real facts from blastradius scan (no --history) of the pinned commit; e-mail addresses removed. GitHub API answered 403 in the recording session, so no repo_owner facts.',
    facts: kept,
  };
  const dir = path.join(import.meta.dirname, '..', 'fixtures', 'entities');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'parse-server-facts.json.gz'), gzipSync(JSON.stringify(fixture)));
  process.stderr.write(`recorded ${kept.length} of ${facts.length} facts from ${commit} in ${Math.round((Date.now() - started) / 1000)} s; wrote ${files.join(', ')}; ${result.findings.length} findings\n`);
}

await main();
