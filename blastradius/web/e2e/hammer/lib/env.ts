/**
 * Hammer suite environment: where the server is, who the admin is, where outputs go, and the
 * real-world scenarios (blastradius/test/hammer/scenarios.json) the server was populated with.
 *
 * Nothing here is mocked. The suite runs against a live `blastradius serve` that the scenario
 * runner already filled with scans of real public repositories at pinned commits.
 */
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = fileURLToPath(new URL('..', import.meta.url));
export const WEB_ROOT = join(HERE, '..', '..');
export const PKG_ROOT = join(WEB_ROOT, '..');
export const OUT_DIR = process.env.HAMMER_OUT_DIR ?? join(HERE, 'out');
export const SHOTS_DIR = process.env.HAMMER_SHOTS_DIR ?? join(HERE, 'shots');
/**
 * The scenario runner starts one API server per reference date; run-all.mjs runs this suite
 * once per server and names it here. Results, sessions and state are kept per server, and the
 * report merges them. Screenshots keep shots/<role>/<theme>/<viewport>/ with a "<server>~" prefix.
 */
export const SERVER = process.env.HAMMER_SERVER_NAME ?? 'default';
export const SHOT_PREFIX = process.env.HAMMER_SERVER_NAME ? `${process.env.HAMMER_SERVER_NAME}~` : '';
/** Reference date of this server ("now" or an ISO time), when run-all.mjs knows it. */
export const SERVER_AS_OF = process.env.HAMMER_SERVER_ASOF ?? null;
export const RESULTS_ROOT = join(OUT_DIR, 'results');
export const RESULTS_DIR = join(RESULTS_ROOT, SERVER);
export const AUTH_DIR = join(OUT_DIR, 'auth', SERVER);
export const DOWNLOADS_DIR = join(OUT_DIR, 'downloads', SERVER);
export const STATE_FILE = join(OUT_DIR, `state-${SERVER}.json`);
export const SCENARIOS_FILE = process.env.HAMMER_SCENARIOS ?? join(PKG_ROOT, 'test', 'hammer', 'scenarios.json');

export const BASE_URL = (process.env.HAMMER_BASE_URL ?? 'http://127.0.0.1:8000').replace(/\/$/, '');

export function ensureDirs(): void {
  for (const d of [OUT_DIR, SHOTS_DIR, RESULTS_DIR, AUTH_DIR, DOWNLOADS_DIR]) mkdirSync(d, { recursive: true });
}

export type Role = 'admin' | 'appsec' | 'developer' | 'auditor';
export const ROLES: readonly Role[] = ['admin', 'appsec', 'developer', 'auditor'];
export type Theme = 'light' | 'dark';
export const THEMES: readonly Theme[] = ['light', 'dark'];
export interface Viewport {
  name: 'desktop' | 'mobile';
  width: number;
  height: number;
}
export const VIEWPORTS: readonly Viewport[] = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

/**
 * HAMMER_MODE=quick (default) checks every page once per role (light, desktop), plus one dark and
 * one mobile pass, on the first 3 projects, and crawls only the "now" server. HAMMER_MODE=full
 * crawls every role x theme x viewport on every project of every server (several times longer).
 */
export const FULL = process.env.HAMMER_MODE === 'full';
export interface Combo {
  role: Role;
  theme: Theme;
  vp: Viewport;
}
const vpBy = (n: Viewport['name']): Viewport => VIEWPORTS.find((v) => v.name === n)!;
export const CRAWL_COMBOS: readonly Combo[] = FULL
  ? ROLES.flatMap((role) => THEMES.flatMap((theme) => VIEWPORTS.map((vp) => ({ role, theme, vp }))))
  : [...ROLES.map((role): Combo => ({ role, theme: 'light', vp: vpBy('desktop') })), { role: 'admin', theme: 'dark', vp: vpBy('desktop') }, { role: 'developer', theme: 'dark', vp: vpBy('mobile') }];
export const SIGNED_OUT_COMBOS: readonly Omit<Combo, 'role'>[] = FULL
  ? THEMES.flatMap((theme) => VIEWPORTS.map((vp) => ({ theme, vp })))
  : [{ theme: 'light', vp: vpBy('desktop') }, { theme: 'dark', vp: vpBy('mobile') }];
/** Quick mode crawls only the "now" server; the dated servers still run the scenario and feature suites. */
export const CRAWL_THIS_SERVER = FULL || !process.env.HAMMER_SERVER_ASOF || process.env.HAMMER_SERVER_ASOF === 'now';
/** Projects crawled per combo: all in full mode, the first 3 in quick mode (HAMMER_PROJECT_LIMIT overrides). */
export const PROJECT_LIMIT = Number(process.env.HAMMER_PROJECT_LIMIT ?? (FULL ? 0 : 3));

/** Built-in role id for each hammer role (PLAN §12 default templates). */
export const ROLE_IDS: Record<Role, string> = { admin: 'org_admin', appsec: 'appsec', developer: 'developer', auditor: 'auditor' };

export interface ScenarioExpect {
  purl: string;
  level: string;
  note?: string;
}
export interface Scenario {
  id: string;
  repo: string;
  commit: string;
  lockfile?: string;
  subdir?: string;
  asOf?: string;
  why: string;
  sources: string[];
  expect: ScenarioExpect[];
  expectAbsent?: string[];
}

export function loadScenarios(): Scenario[] {
  const raw = JSON.parse(readFileSync(SCENARIOS_FILE, 'utf8')) as { scenarios: Scenario[] } | Scenario[];
  return Array.isArray(raw) ? raw : raw.scenarios;
}

/** Discovered at global setup and shared with every worker through out/state.json. */
export interface HammerProject {
  id: string;
  name: string;
  target: string;
  scenarioId: string | null;
  lastScanStatus: string | null;
  findings: number;
  critical: number;
  /** Highest-scored finding of the latest succeeded scan (for the Finding and graph pages). */
  topFindingId: string | null;
  topFindingPurl: string | null;
}
export interface HammerUser {
  role: Role;
  email: string;
  /** Only in out/auth/users.json (git-ignored); never logged. */
  password: string;
  userId: string;
  storageState: string;
  /** How the account was made: dev-mode one-time password or an accepted invite link. */
  via: 'invite-otp' | 'invite-link' | 'admin';
}
export interface HammerState {
  server: string;
  asOf: string | null;
  startedAt: string;
  runId: string;
  baseURL: string;
  devMode: boolean;
  orgId: string;
  orgName: string;
  projects: HammerProject[];
  /** Scenario id -> project id, or null when the scenario runner did not create it. */
  scenarioProjects: Record<string, string | null>;
  /** Host -> reachable from this container. */
  sources: Record<string, boolean>;
  users: Omit<HammerUser, 'password'>[];
  /** web/dist/index.html mtime at setup: the server serves web/dist from disk, so a rebuild mid-run mixes builds. */
  webBuildMtimeMs?: number | null;
}

export const WEB_INDEX = join(WEB_ROOT, 'dist', 'index.html');
export function webBuildMtimeMs(): number | null {
  try {
    return statSync(WEB_INDEX).mtimeMs;
  } catch {
    return null;
  }
}

/** Scenarios this server is expected to hold (all of them unless run-all.mjs named a reference date). */
export function scenariosForServer(all: Scenario[]): Scenario[] {
  // Quick mode: the runner is started with --skip-scale, so scale-* and hostile-* are not scanned.
  const wanted = FULL ? all : all.filter((s) => !s.id.startsWith('scale-') && !s.id.startsWith('hostile-'));
  if (!SERVER_AS_OF) return wanted;
  return wanted.filter((s) => (s.asOf ?? 'now') === SERVER_AS_OF);
}

export function readState(): HammerState {
  if (!existsSync(STATE_FILE)) throw new Error(`No ${STATE_FILE}: global setup did not run`);
  return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as HammerState;
}

export function readUsers(): HammerUser[] {
  return JSON.parse(readFileSync(join(AUTH_DIR, 'users.json'), 'utf8')) as HammerUser[];
}

export function userFor(role: Role): HammerUser {
  const u = readUsers().find((x) => x.role === role);
  if (!u) throw new Error(`No hammer user for role ${role}`);
  return u;
}

/** The hosts a scenario depends on that are blocked right now. */
export function blockedSources(state: HammerState, sources: readonly string[]): string[] {
  return sources.filter((h) => state.sources[h] === false);
}
