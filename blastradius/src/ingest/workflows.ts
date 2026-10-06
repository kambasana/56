/**
 * Static GitHub Actions workflow parser.
 *
 * Extracts `uses:` references (actions, sub-path actions, reusable workflows,
 * docker:// images), job containers/services, triggers and permissions. The
 * YAML is untrusted: it is parsed with alias limits and never evaluated.
 */
import { parseDocument } from 'yaml';
import { formatPurl, type Asset, type Component, type DepEdge, type Purl } from '../core/types.js';
import { parseImageRef, imageComponent } from './docker.js';
import { cap, isRecord, own } from './fs.js';

export type ActionPinning = 'sha' | 'tag' | 'branch' | 'unpinned';

export interface ActionRef {
  /** Raw `uses:` value (capped). */
  uses: string;
  kind: 'action' | 'reusable_workflow' | 'docker' | 'local';
  /** Component purl; absent for local (`./…`) references. */
  purl?: string;
  owner?: string;
  repo?: string;
  /** Sub-path inside the repo (sub-path action or reusable workflow file). */
  path?: string;
  ref?: string;
  pinning: ActionPinning | 'digest';
  /** Job id the reference appears in. */
  job: string;
  /** Step index within the job, absent for job-level `uses:` / containers. */
  step?: number;
}

export type PermissionLevel = 'read' | 'write' | 'none';
/** `permissions:` value: 'read-all' | 'write-all' | {} | per-scope map. Undefined when not declared. */
export type PermissionsSpec = 'read-all' | 'write-all' | Record<string, PermissionLevel>;

export interface WorkflowJobInfo {
  id: string;
  permissions?: PermissionsSpec;
  /** Job-level reusable workflow call. */
  uses?: string;
  /** Secrets the job references (`secrets.X`), names only. */
  secrets: string[];
  /** actions/checkout of the PR head in a privileged trigger context. */
  checksOutPrHead: boolean;
  publishes: boolean;
}

/** Workflow facts used by the outbound score (PLAN §3.6 step 5). */
export interface WorkflowInfo {
  assetId: string;
  path: string;
  name?: string;
  triggers: string[];
  /** Triggers that run with a privileged token on untrusted input: pull_request_target, workflow_run. */
  privilegedTriggers: string[];
  /** Top-level permissions, undefined if not declared (repository default applies). */
  permissions?: PermissionsSpec;
  /** True when no `permissions:` key is set at workflow level nor on every job. */
  permissionsUndeclared: boolean;
  jobs: WorkflowJobInfo[];
  /** Union of scopes granted `write` anywhere (or ['*'] for write-all). */
  writeScopes: string[];
  hasWriteTokens: boolean;
  hasOidc: boolean;
  publishes: boolean;
  /** Secret names referenced anywhere (names only, never values). */
  secrets: string[];
  actions: ActionRef[];
  /** Untrusted PR head checked out under a privileged trigger. */
  checksOutPrHead: boolean;
}

export interface ParsedWorkflow {
  asset: Asset;
  components: Component[];
  edges: DepEdge[];
  info: WorkflowInfo;
  warnings: string[];
}

const SHA_RE = /^[0-9a-f]{40}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/i;
const TAG_RE = /^v?\d+(?:\.\d+)*(?:[-+.][0-9A-Za-z.-]+)?$/;
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/;

/** Classify an action ref: full commit SHA, version-like tag, or anything else (a branch or moving ref). */
export function classifyActionRef(ref: string | undefined): ActionPinning {
  if (!ref) return 'unpinned';
  if (SHA_RE.test(ref) || SHA256_RE.test(ref)) return 'sha';
  if (TAG_RE.test(ref)) return 'tag';
  return 'branch';
}

/**
 * Parse a `uses:` value. Returns null for malformed values.
 * - `owner/repo@ref`, `owner/repo/sub/path@ref` → action
 * - `owner/repo/.github/workflows/x.yml@ref` → reusable_workflow
 * - `docker://image:tag` → docker
 * - `./path` → local
 */
export function parseUses(uses: string, job: string, step?: number): ActionRef | null {
  const raw = cap(uses.trim(), 512);
  const base = { uses: raw, job, ...(step !== undefined ? { step } : {}) };
  if (raw.startsWith('./') || raw.startsWith('../')) return { ...base, kind: 'local', pinning: 'unpinned' };
  if (raw.toLowerCase().startsWith('docker://')) {
    const img = parseImageRef(raw.slice('docker://'.length));
    if (!img) return null;
    return { ...base, kind: 'docker', purl: img.purl, pinning: img.pinning === 'digest' ? 'digest' : img.pinning, ...(img.reference ? { ref: img.reference } : {}) };
  }
  const at = raw.lastIndexOf('@');
  const target = at >= 0 ? raw.slice(0, at) : raw;
  const ref = at >= 0 ? raw.slice(at + 1) : undefined;
  const parts = target.split('/');
  if (parts.length < 2) return null;
  const [owner, repo, ...rest] = parts;
  if (!owner || !repo || !OWNER_RE.test(owner) || !OWNER_RE.test(repo)) return null;
  if (rest.some((p) => p === '' || p === '.' || p === '..')) return null;
  if (ref !== undefined && (ref === '' || /[\s]/.test(ref))) return null;
  const sub = rest.length > 0 ? rest.join('/') : undefined;
  const isReusable = !!sub && /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(sub);
  const p: Purl = { type: 'githubactions', namespace: owner.toLowerCase(), name: repo.toLowerCase() };
  if (ref) p.version = ref;
  if (sub) p.subpath = sub;
  return {
    ...base,
    kind: isReusable ? 'reusable_workflow' : 'action',
    purl: formatPurl(p),
    owner: owner.toLowerCase(),
    repo: repo.toLowerCase(),
    ...(sub ? { path: sub } : {}),
    ...(ref ? { ref } : {}),
    pinning: classifyActionRef(ref),
  };
}

function parsePermissions(v: unknown): PermissionsSpec | undefined {
  if (v === undefined || v === null) return undefined;
  if (v === 'read-all' || v === 'write-all') return v;
  if (isRecord(v)) {
    const out: Record<string, PermissionLevel> = {};
    for (const [k, val] of Object.entries(v)) {
      if (val === 'read' || val === 'write' || val === 'none') out[cap(k, 64)] = val;
    }
    return out;
  }
  return undefined;
}

function writeScopesOf(p: PermissionsSpec | undefined): string[] {
  if (!p) return [];
  if (p === 'write-all') return ['*'];
  if (p === 'read-all') return [];
  return Object.entries(p)
    .filter(([, lvl]) => lvl === 'write')
    .map(([k]) => k);
}

function parseTriggers(on: unknown): string[] {
  if (typeof on === 'string') return [cap(on, 64)];
  if (Array.isArray(on)) return on.filter((x): x is string => typeof x === 'string').map((x) => cap(x, 64));
  if (isRecord(on)) return Object.keys(on).map((x) => cap(x, 64));
  return [];
}

const PRIVILEGED_TRIGGERS = new Set(['pull_request_target', 'workflow_run']);

/** Commands / actions that publish packages, images or releases. Heuristic, never executed. */
const PUBLISH_RUN_RE = /\b(?:npm|pnpm|yarn)\s+(?:publish|npm\s+publish)\b|\bdocker\s+(?:image\s+)?push\b|\btwine\s+upload\b|\bcargo\s+publish\b|\bgh\s+release\s+(?:create|upload)\b|\bsemantic-release\b|\blerna\s+publish\b|\bchangeset\s+publish\b|\bvsce\s+publish\b/i;
const PUBLISH_ACTIONS = new Set([
  'js-devtools/npm-publish',
  'pypa/gh-action-pypi-publish',
  'docker/build-push-action',
  'changesets/action',
  'softprops/action-gh-release',
  'ncipollo/release-action',
  'goreleaser/goreleaser-action',
  'cycjimmy/semantic-release-action',
]);
const PUBLISH_SECRET_RE = /^(?:NPM_TOKEN|NODE_AUTH_TOKEN|NPM_AUTH_TOKEN|PYPI_[A-Z_]*TOKEN|PYPI_API_TOKEN|DOCKER(?:HUB)?_(?:PASSWORD|TOKEN)|CARGO_REGISTRY_TOKEN|GH_PAT|RELEASE_TOKEN|VSCE_PAT)$/i;

const SECRET_REF_RE = /\bsecrets\.([A-Za-z_][A-Za-z0-9_]{0,99})\b|\bsecrets\[\s*['"]([A-Za-z_][A-Za-z0-9_]{0,99})['"]\s*\]/g;
const PR_HEAD_RE = /github\.event\.pull_request\.head\.(?:sha|ref)|github\.head_ref|refs\/pull\/|github\.event\.workflow_run\.head_(?:sha|branch)/;

/** Collect every string leaf under `v` (bounded). */
function strings(v: unknown, out: string[] = [], budget = { n: 20_000 }): string[] {
  if (budget.n-- <= 0) return out;
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out, budget);
  else if (isRecord(v)) for (const x of Object.values(v)) strings(x, out, budget);
  return out;
}

function secretNames(v: unknown): string[] {
  const names = new Set<string>();
  for (const s of strings(v)) {
    for (const m of s.matchAll(SECRET_REF_RE)) names.add((m[1] ?? m[2])!);
  }
  return [...names].sort();
}

function imageFrom(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  const img = own(v, 'image');
  return typeof img === 'string' ? img : undefined;
}

export interface ParseWorkflowOptions {
  /** Criticality for the workflow asset (default 3). */
  criticality?: Asset['criticality'];
}

/** Parse a workflow file. `relPath` is relative to the scan root. Throws on unparseable YAML. */
export function parseWorkflow(text: string, relPath: string, opts: ParseWorkflowOptions = {}): ParsedWorkflow {
  const doc = parseDocument(text, { uniqueKeys: false, prettyErrors: false });
  if (doc.errors.length > 0) throw new Error(`invalid YAML: ${cap(doc.errors[0]!.message, 200)}`);
  const wf: unknown = doc.toJS({ maxAliasCount: 100 });
  if (!isRecord(wf)) throw new Error('workflow is not a mapping');
  const warnings: string[] = [];
  const assetId = `workflow:${relPath}`;

  const nameRaw = own(wf, 'name');
  const name = typeof nameRaw === 'string' ? cap(nameRaw, 200) : undefined;
  // YAML 1.1 parsers turn `on` into `true`; accept both.
  const triggers = parseTriggers(own(wf, 'on') ?? own(wf, 'true'));
  const privilegedTriggers = triggers.filter((t) => PRIVILEGED_TRIGGERS.has(t));
  const permissions = parsePermissions(own(wf, 'permissions'));
  const workflowSecrets = new Set(secretNames(wf));

  const actions: ActionRef[] = [];
  const jobs: WorkflowJobInfo[] = [];
  const containerImages: { image: string; job: string }[] = [];
  const jobsObj = own(wf, 'jobs');
  let allJobsHavePermissions = true;

  if (isRecord(jobsObj)) {
    for (const jobId of Object.keys(jobsObj)) {
      const job = jobsObj[jobId];
      if (!isRecord(job)) continue;
      const jid = cap(jobId, 100);
      const jobPerms = parsePermissions(own(job, 'permissions'));
      if (jobPerms === undefined) allJobsHavePermissions = false;
      const info: WorkflowJobInfo = { id: jid, secrets: secretNames(job), checksOutPrHead: false, publishes: false };
      if (jobPerms !== undefined) info.permissions = jobPerms;

      const jobUses = own(job, 'uses');
      if (typeof jobUses === 'string') {
        info.uses = cap(jobUses, 512);
        const ref = parseUses(jobUses, jid);
        if (ref) actions.push(ref);
        else warnings.push(`${relPath}: job ${jid}: unrecognised uses "${cap(jobUses, 100)}"`);
        if (own(job, 'secrets') === 'inherit') info.secrets = [...new Set([...info.secrets, '*inherit*'])];
      }

      const container = imageFrom(own(job, 'container'));
      if (container) containerImages.push({ image: container, job: jid });
      const services = own(job, 'services');
      if (isRecord(services)) {
        for (const svc of Object.values(services)) {
          const img = imageFrom(svc);
          if (img) containerImages.push({ image: img, job: jid });
        }
      }

      const steps = own(job, 'steps');
      if (Array.isArray(steps)) {
        steps.forEach((step, i) => {
          const uses = own(step, 'uses');
          if (typeof uses === 'string') {
            const ref = parseUses(uses, jid, i);
            if (ref) {
              actions.push(ref);
              const slug = ref.owner && ref.repo ? `${ref.owner}/${ref.repo}` : '';
              if (PUBLISH_ACTIONS.has(slug)) {
                // docker/build-push-action only publishes with push: true
                const push = own(own(step, 'with'), 'push');
                if (slug !== 'docker/build-push-action' || push === true || push === 'true' || (typeof push === 'string' && push.includes('${{'))) {
                  info.publishes = true;
                }
              }
              if (slug === 'actions/checkout' && privilegedTriggers.length > 0) {
                const withRef = own(own(step, 'with'), 'ref');
                if (typeof withRef === 'string' && PR_HEAD_RE.test(withRef)) info.checksOutPrHead = true;
              }
            } else {
              warnings.push(`${relPath}: job ${jid} step ${i}: unrecognised uses "${cap(uses, 100)}"`);
            }
          }
          const run = own(step, 'run');
          if (typeof run === 'string' && PUBLISH_RUN_RE.test(run)) info.publishes = true;
        });
      }
      if (info.secrets.some((s) => PUBLISH_SECRET_RE.test(s))) info.publishes = true;
      jobs.push(info);
    }
  }
  for (const s of jobs.flatMap((j) => j.secrets)) workflowSecrets.add(s);

  // Job containers / services become docker components too.
  for (const { image, job } of containerImages) {
    if (image.includes('${{')) {
      warnings.push(`${relPath}: job ${job}: container image uses an expression; skipped`);
      continue;
    }
    const img = parseImageRef(image);
    if (img) actions.push({ uses: cap(image, 512), kind: 'docker', job, purl: img.purl, pinning: img.pinning === 'digest' ? 'digest' : img.pinning, ...(img.reference ? { ref: img.reference } : {}) });
  }

  const writeScopes = [...new Set([...writeScopesOf(permissions), ...jobs.flatMap((j) => writeScopesOf(j.permissions))])].sort();
  const hasOidc = writeScopes.includes('*') || writeScopes.includes('id-token');
  const hasWriteTokens = writeScopes.some((s) => s !== 'id-token');
  const publishes = jobs.some((j) => j.publishes);
  const checksOutPrHead = jobs.some((j) => j.checksOutPrHead);

  const info: WorkflowInfo = {
    assetId,
    path: relPath,
    ...(name ? { name } : {}),
    triggers,
    privilegedTriggers,
    ...(permissions !== undefined ? { permissions } : {}),
    permissionsUndeclared: permissions === undefined && !(jobs.length > 0 && allJobsHavePermissions),
    jobs,
    writeScopes,
    hasWriteTokens,
    hasOidc,
    publishes,
    secrets: [...workflowSecrets].sort(),
    actions,
    checksOutPrHead,
  };

  const asset: Asset = {
    id: assetId,
    kind: 'workflow',
    name: name ?? relPath.split('/').pop() ?? relPath,
    environment: 'ci',
    criticality: opts.criticality ?? 3,
    sourceFile: relPath,
    ci: { hasWriteTokens, hasOidc, publishes },
  };

  const components = new Map<string, Component>();
  const edges = new Map<string, DepEdge>();
  for (const a of actions) {
    if (!a.purl) continue;
    if (!components.has(a.purl)) {
      if (a.kind === 'docker') {
        const img = parseImageRef(a.uses.replace(/^docker:\/\//i, ''));
        if (img) components.set(a.purl, imageComponent(img));
      } else {
        components.set(a.purl, {
          purl: a.purl,
          ecosystem: 'githubactions',
          name: `${a.owner}/${a.repo}`,
          version: a.ref ?? '',
          pinning: a.pinning,
        });
      }
    }
    edges.set(a.purl, { from: assetId, to: a.purl, scope: 'build', direct: true });
  }

  return { asset, components: [...components.values()], edges: [...edges.values()], info, warnings };
}
