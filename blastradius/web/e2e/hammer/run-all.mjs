#!/usr/bin/env node
/**
 * Run the Playwright hammer suite against every API server the scenario runner left running
 * (`npm run hammer -- --keep-servers` in blastradius/), one server after another, then merge
 * all results into e2e/hammer/out/report.md.
 *
 * The scenario runner starts one server per reference date (the API has no per-scan --as-of),
 * and lists them in blastradius/test/hammer/out/results.json with the admin credentials file.
 *
 *   node e2e/hammer/run-all.mjs                 # every live server
 *   HAMMER_SERVERS=now,2018-11-27 node e2e/hammer/run-all.mjs
 *   node e2e/hammer/run-all.mjs -- --grep crawl # extra Playwright args after --
 *
 * Exit code: 0 only when every server's run passed.
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..', '..');
const resultsFile = process.env.HAMMER_RUNNER_RESULTS ?? join(webRoot, '..', 'test', 'hammer', 'out', 'results.json');
if (!existsSync(resultsFile)) {
  console.error(`No ${resultsFile}: run the scenario runner first (cd blastradius && npm run hammer -- --keep-servers).`);
  process.exit(2);
}
const runner = JSON.parse(readFileSync(resultsFile, 'utf8'));
const only = process.env.HAMMER_SERVERS ? new Set(process.env.HAMMER_SERVERS.split(',').map((s) => s.trim())) : null;
const extra = process.argv.includes('--') ? process.argv.slice(process.argv.indexOf('--') + 1) : [];

// Fresh merged report for this run-all. With HAMMER_SERVERS only the named servers' results are
// replaced, so servers can be run in several batches and still merge into one report.
if (only) {
  for (const name of only) {
    rmSync(join(here, 'out', 'results', name), { recursive: true, force: true });
    rmSync(join(here, 'out', `state-${name}.json`), { force: true });
  }
} else {
  rmSync(join(here, 'out', 'results'), { recursive: true, force: true });
  if (existsSync(join(here, 'out'))) for (const f of readdirSync(join(here, 'out'))) if (/^state-.*\.json$/.test(f)) rmSync(join(here, 'out', f), { force: true });
}

/**
 * Run Playwright and stream its output. Seen in practice: after the final summary and the global
 * teardown (report written), the Playwright runner sometimes never exits, its idle workers waiting
 * on the runner. Once both have been printed, allow a grace period, then stop it. The verdict is
 * taken from Playwright's own summary ("N failed" or a missing "N passed" fails), never assumed.
 */
function runPlaywright(args, env) {
  return new Promise((resolve) => {
    const child = spawn('npx', ['playwright', 'test', ...args], { cwd: webRoot, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = '';
    let watchdog = null;
    let hung = false;
    const onData = (stream) => (d) => {
      stream.write(d);
      out += d.toString('utf8');
      if (out.length > 4_000_000) out = out.slice(-2_000_000);
      if (!watchdog && /hammer report: /.test(out) && /^\s+\d+ (passed|failed)/m.test(out)) {
        watchdog = setTimeout(() => {
          hung = true;
          console.error('\nplaywright finished (summary and report written) but did not exit within 120 s: stopping it');
          try { process.kill(-child.pid, 'SIGTERM'); } catch {}
          setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 10_000).unref();
        }, 120_000);
      }
    };
    // detached (own process group, so the whole tree can be stopped): forward Ctrl-C / SIGTERM.
    const stop = (sig) => () => { try { process.kill(-child.pid, sig); } catch {} };
    process.once('SIGINT', stop('SIGINT'));
    process.once('SIGTERM', stop('SIGTERM'));
    child.stdout.on('data', onData(process.stdout));
    child.stderr.on('data', onData(process.stderr));
    child.on('close', (code) => {
      if (watchdog) clearTimeout(watchdog);
      const plain = out.replace(/\x1b\[[0-9;]*m/g, '');
      const failedN = Number((/^\s+(\d+) failed/m.exec(plain) ?? [])[1] ?? 0);
      const passed = /^\s+\d+ passed/m.test(plain);
      const status = hung ? (failedN > 0 || !passed ? 1 : 0) : code ?? 1;
      resolve({ status, hung });
    });
  });
}

let failed = 0;
const ran = [];
for (const s of runner.servers ?? []) {
  if (only && !only.has(s.name)) continue;
  let up = false;
  try {
    up = (await fetch(`${s.url}/api/health`, { signal: AbortSignal.timeout(5000) })).ok;
  } catch {
    up = false;
  }
  if (!up) {
    console.error(`server ${s.name} (${s.url}) is not answering; skipped (start the runner with --keep-servers)`);
    failed++;
    continue;
  }
  console.log(`\n=== hammer e2e against server ${s.name} (${s.url}, as of ${s.asOf}) ===`);
  const env = {
    ...process.env,
    HAMMER_BASE_URL: s.url,
    HAMMER_ADMIN_FILE: s.credentialsFile,
    HAMMER_SERVER_NAME: s.name,
    HAMMER_SERVER_ASOF: s.asOf,
    HAMMER_KEEP_RESULTS: '1',
  };
  // Quick mode (HAMMER_MODE unset or quick): the dated servers only hold the historical incident
  // scenarios, so run just the scenario suite there; every feature suite runs once, on "now".
  const quickDated = process.env.HAMMER_MODE !== 'full' && s.asOf !== 'now';
  const grep = quickDated && !extra.includes('--grep') ? ['--grep', 'scenarios\\.hammer\\.ts'] : [];
  const r = await runPlaywright(['-c', join(here, 'hammer.config.ts'), ...grep, ...extra], env);
  ran.push(`${s.name}: exit ${r.status}${r.hung ? ' (runner hung after finishing; stopped)' : ''}`);
  if (r.status !== 0) failed++;
}
console.log(`\n${ran.join('\n')}`);
console.log(`merged report: ${join(here, 'out', 'report.md')}`);
process.exit(failed ? 1 : 0);
