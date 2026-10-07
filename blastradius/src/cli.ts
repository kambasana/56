#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, InvalidArgumentError, Option } from 'commander';
import { defaultCacheDir } from './core/paths.js';
import { installEnvProxy } from './core/proxy.js';
import type { RiskLevel } from './core/types.js';
import { DEFAULT_KB_DIR, OUTPUT_FORMATS, scan, validateKb, type OutputFormat, type ScanOptions } from './pipeline.js';
import { failsThreshold, formatSummary } from './summary.js';

/** Exit code when --fail-on matches (distinct from 1 = error). */
export const EXIT_POLICY = 2;

export function parseFormats(value: string): OutputFormat[] {
  const parts = value
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 1 && parts[0] === 'all') return [...OUTPUT_FORMATS];
  const out: OutputFormat[] = [];
  for (const p of parts) {
    if (!(OUTPUT_FORMATS as readonly string[]).includes(p)) {
      throw new InvalidArgumentError(`unknown format "${p}" (allowed: ${OUTPUT_FORMATS.join(', ')}, all)`);
    }
    if (!out.includes(p as OutputFormat)) out.push(p as OutputFormat);
  }
  if (out.length === 0) throw new InvalidArgumentError('no format given');
  return out;
}

export function parseAsOf(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/.test(value)) {
    throw new InvalidArgumentError('expected an ISO date, e.g. 2018-11-27 or 2018-11-27T00:00:00Z');
  }
  const d = new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(d.getTime())) throw new InvalidArgumentError(`invalid date "${value}"`);
  return d;
}

interface ScanCliOptions {
  format: OutputFormat[];
  out: string;
  offline: boolean;
  fixtures?: string;
  cache: boolean;
  asOf?: Date;
  kb: string;
  review?: string;
  syft: boolean;
  failOn?: RiskLevel;
  top: string;
}

export interface ProgramIo {
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

export function buildProgram(io: ProgramIo = {}): Command {
  const out = io.stdout ?? ((s: string) => void process.stdout.write(s));
  const err = io.stderr ?? ((s: string) => void process.stderr.write(s));
  const program = new Command();
  program
    .name('blastradius')
    .description('Supply-chain blast-radius auditor. Parses manifests statically; never runs code from scanned repos.')
    .version('0.1.0');

  program
    .command('scan')
    .description('Scan a local directory or git URL and report risky dependencies and their blast radius')
    .argument('<target>', 'local path or git repository URL (https/ssh; cloned with --depth 1)')
    .option('--format <formats>', 'comma-separated report formats: json, sarif, html, or all', parseFormats, [...OUTPUT_FORMATS])
    .option('--out <dir>', 'output directory for report files', 'out')
    .option('--offline', 'no network: answer from fixtures/cache only', false)
    .option('--fixtures <dir>', 'directory of recorded API responses (implies --offline)')
    .option(
      '--no-cache',
      `disable the on-disk HTTP cache (per-user cache dir ${defaultCacheDir()}: $BLASTRADIUS_CACHE_DIR, else $XDG_CACHE_HOME/blastradius, else ~/.cache/blastradius)`,
    )
    .option('--as-of <date>', 'reference time for decay and registry history (backtests), ISO date', parseAsOf)
    .option('--kb <dir>', 'incident knowledge base directory', DEFAULT_KB_DIR)
    .option('--review <file>', 'entity-link review decisions (JSON)')
    .option('--syft', 'also import a Syft SBOM when syft is on PATH', false)
    .addOption(new Option('--fail-on <level>', `exit with code ${EXIT_POLICY} if any finding (including outbound workflow findings) is at or above this level`).choices(['critical', 'high']))
    .option('--top <n>', 'findings to list in the terminal summary', '5')
    .action(async (target: string, o: ScanCliOptions) => {
      const offline = o.offline || o.fixtures !== undefined || process.env.BLASTRADIUS_OFFLINE === '1';
      const opts: ScanOptions = {
        target,
        formats: o.format,
        outDir: o.out,
        offline,
        kbDir: o.kb,
        syft: o.syft,
        log: (m) => err(`… ${m}\n`),
      };
      if (o.fixtures !== undefined) opts.fixturesDir = o.fixtures;
      if (!o.cache) opts.cacheDir = false;
      if (o.asOf) opts.now = o.asOf;
      if (o.review) opts.reviewFile = o.review;
      const { result, files } = await scan(opts);
      const top = Math.max(0, Math.min(100, Number.parseInt(o.top, 10) || 5));
      out(formatSummary(result, { top, files }));
      if (o.failOn && failsThreshold(result, o.failOn)) {
        err(`blastradius: findings at or above "${o.failOn}" (--fail-on)\n`);
        process.exitCode = EXIT_POLICY;
      }
    });

  const kb = program.command('kb').description('Incident knowledge base tools');
  kb.command('validate')
    .description('Validate incident YAML files')
    .argument('[dir]', 'directory of incident YAML files', DEFAULT_KB_DIR)
    .action(async (dir: string) => {
      const res = await validateKb(dir);
      for (const e of res.errors) err(`${e.file}: ${e.message}\n`);
      out(`${res.files} file(s) checked, ${res.errors.length} error(s)\n`);
      if (!res.ok) process.exitCode = 1;
    });

  program
    .command('serve')
    .description('Start the web app and API (binds to 127.0.0.1 by default). Scans never execute repository code.')
    .option('--port <port>', 'port to listen on', parsePort, 8000)
    .option('--host <host>', 'interface to bind (use 0.0.0.0 only behind TLS)', '127.0.0.1')
    .option('--db <path>', 'SQLite database file (default: in memory, lost on exit)')
    .option('--dev', 'dev mode: seeded users and the role switcher', false)
    .option('--dev-seed', 'dev mode plus a demo project scanned offline from test/fixtures (implies --dev)', false)
    .option('--offline', 'no network for scans: answer from fixtures/cache only', false)
    .option('--fixtures <dir>', 'directory of recorded API responses for offline scans (implies --offline)')
    .option('--as-of <date>', 'reference time for every scan (offline demos), ISO date', parseAsOf)
    .option('--allow-local-root <dir>', 'root under which local paths may be scanned (repeatable; default: $BLASTRADIUS_SCAN_ROOT or the cwd)', collect, [])
    .option('--web <dir>', 'built web app directory (default: web/dist next to the package)')
    .option('--concurrency <n>', 'scans run at once (1-4)', parseConcurrency, 2)
    .option(
      '--trust-proxy <ips>',
      'comma-separated reverse proxy addresses whose X-Forwarded-For / X-Forwarded-Proto are honoured (default: $BLASTRADIUS_TRUST_PROXY, else none)',
      parseAddressList,
    )
    .action(async (o: ServeCliOptions) => {
      const { serve } = await import('./server/serve.js');
      const offline = o.offline || o.fixtures !== undefined || process.env.BLASTRADIUS_OFFLINE === '1';
      const trustProxy = o.trustProxy ?? parseAddressList(process.env.BLASTRADIUS_TRUST_PROXY ?? '');
      await serve({
        port: o.port,
        host: o.host,
        ...(o.db !== undefined ? { dbPath: o.db } : {}),
        devMode: o.dev || o.devSeed,
        devSeed: o.devSeed,
        offline,
        ...(o.fixtures !== undefined ? { fixturesDir: resolvePath(o.fixtures) } : {}),
        ...(o.asOf ? { asOf: o.asOf } : {}),
        ...(o.allowLocalRoot.length > 0 ? { localRoots: o.allowLocalRoot.map((d) => resolvePath(d)) } : {}),
        ...(o.web !== undefined ? { webDir: resolvePath(o.web) } : {}),
        concurrency: o.concurrency,
        ...(trustProxy.length > 0 ? { trustProxy } : {}),
        log: (m) => err(`${m}\n`),
      });
    });

  return program;
}

interface ServeCliOptions {
  port: number;
  host: string;
  db?: string;
  dev: boolean;
  devSeed: boolean;
  offline: boolean;
  fixtures?: string;
  asOf?: Date;
  allowLocalRoot: string[];
  web?: string;
  concurrency: number;
  trustProxy?: string[];
}

/** Comma-separated address list (--trust-proxy, $BLASTRADIUS_TRUST_PROXY). */
export function parseAddressList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parsePort(value: string): number {
  const n = Number(value);
  if (!/^\d{1,5}$/.test(value) || n < 0 || n > 65535) throw new InvalidArgumentError('expected a port number 0-65535');
  return n;
}

function parseConcurrency(value: string): number {
  const n = Number(value);
  if (!/^\d$/.test(value) || n < 1 || n > 4) throw new InvalidArgumentError('expected 1-4');
  return n;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function isMain(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  // Node's fetch ignores HTTPS_PROXY/HTTP_PROXY on its own; route it through them (NO_PROXY respected).
  installEnvProxy()
    .catch((e: unknown) => {
      process.stderr.write(`blastradius: could not set up the HTTPS_PROXY/HTTP_PROXY dispatcher: ${(e as Error).message}\n`);
      return false;
    })
    .then(() => buildProgram().parseAsync(process.argv))
    .catch((e: unknown) => {
      process.stderr.write(`blastradius: ${(e as Error).message}\n`);
      process.exitCode = 1;
    });
}
