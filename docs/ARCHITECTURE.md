# Blastradius architecture: plugins, adapters and a staged refactor

Measured on `origin/docs/blast-radius-plan` at `ed0690c` (2026-10-13), the same commit as the `.claude/worktrees/t06` HEAD. Uncommitted edits in t06 (`src/history`, `src/stability` and others) are not counted.

Line counts include comments. Test counts are the `it(`/`test(` call sites in each file. Parametrised tests expand at run time, so the runner reports more (ROADMAP §1.2 says 996 at 6e71412).

---

## 1. The current state, measured

### 1.1 Module map (`blastradius/src`, non-test `.ts`)

| Module | Files | Lines | Colocated tests (files / cases) | Tests in `test/` (files / cases) | Notes |
|---|---|---|---|---|---|
| server | 57 | 12,991 | 21 / 223 | – | routes 11, store 22, api-types 4 |
| enrich | 27 | 4,711 | 7 / 84 | – | osv, depsdev, npm, github have tests. **pypi, licenses, history, agentic have none.** |
| licenses | 8 | 3,480 | 1 / 16 | 1 / 16 | 2,616 lines are generated data (`data/scancode-categories.ts`) |
| ingest | 11 | 3,263 | 7 / 74 | – | |
| core | 10 | 3,040 | 6 / 54 | – | `types.ts` 1,683 |
| agentic | 10 | 2,459 | 2 / 20 | 7 / 51 | |
| stability | 10 | 1,839 | 1 / 30 | 3 / 51 | `label.ts` 640 (674 in t06) |
| history | 12 | 1,798 | 1 / 30 | 1 / 18 | |
| scoring | 8 | 1,557 | 1 / 26 | – | |
| report | 9 | 1,259 | 3 / 19 | – | |
| entities | 4 | 802 | 1 / 19 | 2 / 18 | |
| root (`cli`, `pipeline`, `summary`) | 3 | 792 | 2 / 23 | e2e 1 / 11 | |
| incidents | 4 | 582 | 1 / 17 | – | |
| watch | 2 | 415 | 2 / 8 | – | |
| pack | 5 | 328 | 1 / 7 | – | |
| accounts | 1 | 124 | **0** | – | tested only through server tests |
| **Total** | **181** | **≈39,400** | **57 / 650** | **24 / 242** | plus backtest 5, replay 26, tier0 24, tier05 22 |

- **Web** (`blastradius/web/src`): 67 page files, 91 component files, 9 lib files, and API clients `api.ts`, `api-accounts.ts`, `api-agentic.ts` and `api-incidents.ts`. There are 40 unit test files (272 cases), plus `e2e/app.spec.ts` and the hammer suite.
  - The largest files are `components/ui/sidebar.tsx` 726, `pages/Investigate.tsx` 648, `e-parts/SettingsParts.tsx` 644, `components/DataTable.tsx` 618 and `pages/Findings.tsx` 575.
  - The web already imports server types through the `@server/*` alias. But URLs and methods are hand-written strings in `api.ts`, so nothing checks them against the routes.
- **Recorded data:** `test/fixtures` has 272 files. The largest is about 1.2 MB. The tier05 replays hold real responses for parse-server, jitsi-meet and superset (`test/fixtures/tier05/*.json.gz`). Flask is in `test/fixtures/tier0/flask` plus `stability/recorded/tier05-pypi-flask.json.gz`.
- **Tooling:** there is no ESLint, no dependency-cruiser and no boundary tooling. CI is `.github/workflows/blastradius.yml` (typecheck, test, build, KB validate, one offline e2e scan, then the web job).

### 1.2 Import graph between top-level modules (counts are import statements)

```
root(pipeline,cli) → core 11, ingest 4, licenses 3, report 3, pack 2, every enricher 1, entities, history,
                     incidents, scoring, stability
server  → core 31, watch 7, report 5, licenses 4, enrich/npm 4, stability 4, accounts 3, ingest 3,
          scoring 3, enrich/history 2, root(pipeline) 2, agentic, history, incidents, pack
enrich/npm      → core 14, stability 3, history 2
enrich/github   → core 7, enrich/npm 3, stability 1
enrich/history  → history 10, core 4, stability 2, enrich/depsdev, enrich/npm
enrich/licenses → core 5, licenses 3, enrich/depsdev, enrich/npm
enrich/pypi     → core 2, enrich/depsdev, history, ingest, stability
enrich/osv      → core 5, ingest 1
enrich/depsdev  → core 6, ingest 1
enrich/agentic  → core 4, agentic 3
agentic  → core 10, enrich/depsdev, enrich/github, enrich/npm, incidents
stability→ core 9, history 3, enrich/pypi 1
history  → core 5, ingest 1
scoring  → core 14, history 1
entities → core 3, scoring 1
incidents→ core 4, scoring 2
report   → core 13, licenses 7, ingest 2, scoring 1
watch    → core 4, pack 2, ingest, report, scoring
accounts → enrich/npm 4, watch 1
pack     → core 4
core     → enrich/npm 1      ← core is not a leaf
```

### 1.3 Problems found

**Cycles (module level)**
1. `core ↔ enrich/npm`: `core/osv-range.ts:8` imports `compareVersions` from `enrich/npm/packument.ts`.
2. `stability ↔ enrich/pypi`: `stability/label.ts:30` imports `pypiProjectPage`, and `enrich/pypi` imports `stability/cadence`.
3. A three-way loop through (1): `enrich/npm → stability → core → enrich/npm`.

**God files**
- By size:
  - `core/types.ts` 1,683: every fact shape of every source, plus purl, entity, incident and result types.
  - `server/api-types.ts` 1,151.
  - `server/accounts.ts` 792.
  - `agentic/tasks.ts` 741: every task spec in one file.
  - `core/http.ts` 672.
  - `stability/label.ts` 640.
  - `server/store/findings.ts` 618.
  - `enrich/npm/packument.ts` 606: parsing, cadence, publishers and version compare.
  - `ingest/index.ts` 525.
  - `pipeline.ts` 424.
- By imports:
  - `core/types` 102;
  - `server/api-types` 37;
  - `server/store/index` and `server/store/db` 21 each;
  - `enrich/npm/registry` 15, which is a plugin used as a shared library;
  - `core/http` 15;
  - `core/scope` and `core/agentic-types` 13 each;
  - `scoring/weights` 9, whose constants are read by entities and incidents.

**Cross-layer leaks**
- **Collectors import rules.**
  - `enrich/npm` imports `stability/cadence` and `stability/rules`.
  - `enrich/github` and `enrich/history` import `stability/priority`.
  - `enrich/history` imports `stability/repo`.
  - `enrich/pypi` imports `stability/cadence` and `history/continuity`.
  - `enrich/npm/packument` imports `history/bots` and `history/aggregate`.
- **Rules import a collector:** `stability/label → enrich/pypi`.
- **Collectors import an ingestor for ecosystem helpers:** `enrich/osv`, `enrich/depsdev`, `enrich/pypi` and `watch/match` import `ingest/python`.
- **Collectors import other collectors:**
  - github → npm (registry, repo, util);
  - history → npm, depsdev;
  - licenses → npm, depsdev;
  - pypi → depsdev util;
  - agentic → depsdev, github (opencollective), npm.
- **Scoring constants leak:** `entities/review` and `incidents` import `scoring/weights`.
- **Report reaches into other modules:**
  - `report/sarif` → `scoring` (`isPostureReason`), `ingest/manifests`;
  - `report/html` and `sbom` → licenses internals.
  - There is no report → server import, which is good.
- **The git sandbox lives in ingest:** `history/git` and `server/targets` import `ingest/git` (`cloneEnv`, `checkGitUrl`).
- **The server calls collector internals directly:**
  - `server/accounts.ts`, `server/incidents.ts` and `server/store/accounts.ts` import `enrich/npm/registry` and fetch live npm data on the request path.
  - The server also imports `scoring/blast`, `watch/*` and `pipeline`.
- **Test support in the production path:** `server/jobs.ts:11` imports `history/fixture.js` (recorded histories) for demo/offline mode.

**Duplicated logic**
- **Repo URL normalisation**, about six implementations:
  - `core/repo-url.ts`;
  - `enrich/npm/repo.ts` `parseRepoUrl`;
  - `enrich/depsdev/repo.ts` `normalizeRepoUrl`;
  - `stability/repo.ts` `repoKey`/`sameRepo`;
  - `history/repo-url.ts`;
  - ad hoc `github.com` regexes in 25 files (`history/bots` 12, `enrich/github` 7, `entities/resolve` 4, `agentic/tasks` `canonicalProfileUrl`, …).
- **Identity:**
  - `history/identity.ts` (salted ids, `normaliseEmail`/`normaliseName`), `history/merge.ts`, `entities/resolve.ts`;
  - npm accounts in both `accounts/registry.ts` and `watch/account.ts`;
  - `server/store/auth.ts` `normalizeEmail`.
- **Package names and versions:**
  - `normalizePypiName` lives in an ingestor;
  - `compareVersions` lives in the npm enricher;
  - `isPrereleaseVersion` lives in `history/continuity`.
- **Small helpers:**
  - `mapLimit` ×3 (`enrich/osv/util`, `enrich/depsdev/util`, `enrich/npm/util`);
  - `errorMessage` ×3;
  - `isObject` ×2 plus `ingest/fs.isRecord`;
  - `addMonths` exported from `history/aggregate` and used by stability and npm;
  - `daysBetween` in `packument`.
- **Caching**, four disk caches with different rules:
  - the `core/http` cache;
  - the agentic result cache (`agentic/pipeline.ts`);
  - the git clone cache with a disk budget (`history/git.ts`);
  - the pack cache in `pipeline.ts`.
  - PyPI opts out of the disk cache by hand.
- **Scope** is mostly centralised in `core/scope.ts` (good). But `DepScope` in `types.ts` still has `'build'`. And the comment in `stability/production.ts` says optional and peer are not production, which contradicts Tier 0.5 in `scope.ts`.
- **The pipeline hard-codes plugin knowledge:**
  - `e.name === 'osv'` decides `osvComplete`;
  - `SECURITY_SOURCES = {osv, pack}`;
  - history, pack and agentic are appended ad hoc;
  - `addHistory()` repeats the history enricher setup.

**Where tests are integration-only**
- `enrich/pypi`, `enrich/licenses`, `enrich/history` and `enrich/agentic` are covered only by `test/stability`, `test/licenses`, `test/history` and `test/agentic` replays.
- `accounts` is covered only by `server/accounts.test.ts`.
- `stability/label.ts` (640 lines) has one colocated file. Most coverage is tier0/tier05 replays.
- Most of the server's 223 cases are app-level Hono request tests: they test store and routes together.
- Scoring has 26 cases for 1,557 lines.

**Authz shape.** Guards are imperative calls inside handlers (`requireSession`, `requireOrgPerm`, `requireProjectPerm` in `server/context.ts`). Nothing proves statically that every route has one. Per file, routes vs guard calls: accounts 4/1, alerts 3/1, triage 4/1. Some guards may sit in helpers, so this needs checking, not assuming.

**Strengths to keep**
- All network I/O already goes through `ctx.http` (only `core/http.ts` calls `fetch`). It has per-host rate limits, a circuit breaker, fixtures, `maxBytes` and manual redirects.
- Subprocesses run in only three places: `ingest/git.ts`, `history/git.ts` and `ingest/syft.ts`, plus `server/targets.ts`.
- `server/targets.ts` already allow-lists git hosts and checks local roots with realpath.
- CSRF middleware exists.
- The agentic verification gate and the privacy screen exist.
- Coverage per source already exists (`sourceCoverage`).

---

## 2. Target architecture

### 2.1 Layers (imports only point downwards)

```
 apps/      cli · server (routes, store, auth, jobs) · mcp · action        ← may import engine + core
 engine/    orchestrator · registry · lifecycle · lineage · invariants ·  ← may import core (+ plugins/index)
            query API (exposure, reach, account) · learning hooks
 plugins/   ingest/* · collect/* · resolve/* · rules/* · score/* ·        ← may import core ONLY
            output/* · gapfill/* · notify/*
 core/      types+facts (zod) · ids (purl, repo, names, versions) ·       ← imports nothing above
            scope · http (egress policy) · cache · sandbox (git, syft) ·
            identity (salted ids) · config · util · plugin contracts ·
            domain (pure: spdx/licence classes, time windows) · testing kits
```

- "Rules" from the brief is a phase, not a separate import layer. RuleSets and Scorers are plugins that the engine runs after collectors and resolvers. Outputs run last.
- Pure shared knowledge that several plugins need goes to `core/domain/*`, never to another plugin. Examples:
  - SPDX parsing and licence categories;
  - version comparison per ecosystem;
  - cadence maths;
  - release-bot detection;
  - `addMonths`.

### 2.2 Plugin kinds and interfaces (sketch)

```ts
// core/plugin/manifest.ts
export type PluginKind = 'ingestor'|'collector'|'resolver'|'ruleset'|'scorer'|'output'|'gapfill'|'notifier';
export type PrivacyClass = 'none' | 'org' | 'person-public' | 'person-derived';
export interface HostRule { host: string; pathPrefix?: string; methods?: ('GET'|'POST')[]; secret?: SecretId }

export interface PluginManifest<C = unknown> {
  id: string;                 // 'collect.osv' — also Fact.source (keep today's ids: 'osv', 'depsdev', …)
  version: string;            // semver; bumped when output changes → lineage + golden diff
  kind: PluginKind;
  consumes: { inventory?: boolean; facts?: FactKind[]; entities?: boolean; labels?: LabelKind[] };
  produces: { facts?: FactKind[]; entities?: boolean; labels?: LabelKind[]; findings?: boolean; format?: string };
  after?: string[];           // explicit ordering when data deps are not enough
  ecosystems?: Ecosystem[];
  network: HostRule[];        // empty = no network
  subprocess?: ('git'|'syft')[];
  filesystem?: 'none' | 'scan-target-read' | 'cache';
  config: ZodType<C>;         // parsed and defaulted by the registry
  privacy: PrivacyClass; personFields?: string[]; // fields allowed when privacy ≠ none
  security: boolean;          // replaces SECURITY_SOURCES; --strict blocks on failure
  cost: { timeoutMs: number; hostIntervals?: Record<string, number>; budget?: { requests?: number; tokens?: number } };
  ttl?: Partial<Record<FactKind, string>>;     // freshness (QUALITY-SYSTEM §2)
  defaultEnabled: boolean; flag?: string;      // '--history', '--agentic'
  fixtures: string;           // dir of recorded contract cases
}

export interface PluginContext<C> {
  runId: string; now: Date; historical: boolean; offline: boolean; signal: AbortSignal;
  config: C;
  http: ScopedHttp;           // refuses hosts not in manifest.network, re-checks every redirect hop
  cache: NamespacedCache;     // one cache service; namespace = plugin id
  secrets: SecretReader;      // only ids declared in manifest
  sandbox?: Sandbox;          // only if manifest.subprocess
  log(msg: string): void; problem(p: Problem): void; // feeds coverage.sources
}

export interface Ingestor   { manifest: PluginManifest; detect(files: FileIndex): Detected[];
                              ingest(d: Detected[], ctx): Promise<{ part: InventoryPart; notAnalysed: NotAnalysed[]; workflows?: WorkflowInfo[] }> }
export interface Collector  { manifest: PluginManifest; collect(inv: Inventory, facts: FactView, ctx): Promise<CollectResult> }
export interface CollectResult { facts: Fact[]; checked: number; skipped?: { purl: PurlString; reason: string }[] }
export interface Resolver   { manifest; resolve(facts: FactView, ctx): Promise<{ entities: Entity[]; links: EntityLink[] }> }
export interface RuleSet    { manifest; ruleVersion: string;
                              evaluate(input: RuleInput, ctx): Promise<{ labels?: Label[]; events?: DomainEvent[]; sections?: Partial<ScanResult> }> }
export interface Scorer     { manifest; score(input: RuleInput & { labels: Label[] }, ctx): Promise<{ findings: Finding[] }> }
export interface Output     { manifest; render?(r: ScanResult, opts, ctx): Promise<Artifact>;      // json, html, sarif, cdx, spdx, grc
                              deliver?(r: ScanResult, target: Target, ctx): Promise<Delivery> }    // pr-comment, webhook
export interface GapFillTask{ manifest; spec: TaskSpec /* today's agentic TaskSpec */; needs(facts: FactView): FactRequest[];
                              verify(p: ProposedFact, refetched: Page): GateResult }
export interface Notifier   { manifest; notify(e: DomainEvent, channel: ChannelConfig, ctx): Promise<void> }
```

- **`FactView`** is read-only. It shows only the kinds listed in `consumes.facts`, so data dependencies are explicit. This replaces `repoFacts: () => facts` and `usesEarlierFacts`.
- **The fact vocabulary stays in core**, as the contract per CONTRACTS.md. It is split per family (`core/facts/{security,registry,repo,people,license,history,agent}.ts`) with a zod schema per kind. A plugin may only produce kinds that core declares.
- **The MCP server is an app, not an Output.** It calls the engine query API, reusing the `src/assistant/tools.ts` manifest planned in ROADMAP §3.2.

### 2.3 Registry and lifecycle (`engine/`)

1. **Discovery is static.** `plugins/index.ts` lists every built-in plugin. There is no file-system or npm discovery. Out-of-tree plugins are not supported until we decide on signing (§6).
2. **Validation at start-up:**
   - unique ids;
   - parsed config;
   - every consumed kind has a producer, or the plugin is marked `degraded`;
   - no cycles.
3. **Ordering** is a DAG from produces/consumes plus `after`. Nodes with no dependency between them run concurrently. Facts are appended in a stable order (plugin id, then subject, then kind) so output stays deterministic. This replaces `enricherStages`.
4. **Enable and disable** come from config, CLI flags (`--history`, `--agentic`, `--syft`) and server settings.
5. **Isolation:**
   - each plugin runs with a timeout and an `AbortSignal`;
   - a throw becomes `failed` with a reason;
   - per-plugin budgets apply;
   - the HTTP circuit breaker stays per host.
6. **Coverage:** every run writes `coverage.sources[]`:
   - `{ plugin, version, status: ok|partial|failed|skipped|disabled, security, facts, checked, problems, durationMs, requests, cacheHits }`.
   - A consumer of a failed input gets `inputStatus: 'degraded'`. Rules then say "not assessed", never "clean". This makes the Tier 0 "never a silent all-clear" rule structural.
   - `osvComplete` becomes "the security collector for this ecosystem returned ok".
7. **Boundary checks:**
   - Every fact passes schema validation, the evidence rule and the privacy rule. Failures go to quarantine and are counted, never silently dropped.
   - The invariant checks (QUALITY-SYSTEM §2) run as an engine stage.
8. **Lineage:** a run id, plugin id@version and ruleVersion are stamped on every fact, label and finding. This is Q1 of the quality system, and the learning loop needs it.
9. **`addHistory()`** becomes `engine.rerun(scan, { enable: ['collect.history'], downstream: true })`.

### 2.4 Contract test kits (`core/testing/kits/*`)

Each plugin's test file is one call, for example `collectorKit(plugin, cases)`. Cases come from `manifest.fixtures`: recorded inputs plus expected output.

| Kit | Assertions |
|---|---|
| all kinds | manifest valid; config schema accepts `{}` (defaults); offline run with recorded fixtures only (a request not recorded fails); every request host ⊆ `manifest.network`; secrets never in output or logs; deterministic: two runs, shuffled input order, same sorted output; uses `ctx.now`, not the clock (run at two `now`s where relevant) |
| Ingestor | every component has a valid purl and a scope; edges reference known components; malformed, huge or hostile inputs give a warning, not a crash or hang (size caps, YAML alias bombs, deep JSON); no subprocess unless declared; unsupported files go to `notAnalysed` |
| Collector | kinds ⊆ `produces.facts`; subject ∈ inventory; `source === id`; https evidence URL on every fact; no empty placeholder facts; no person fields unless `privacy` allows and listed; one bad component does not stop the others |
| Resolver | entity ids stable; `reviewed` only from review state; unknown owner type never becomes org |
| RuleSet | `ruleVersion` set; reads no person-level field (generalises today's stability test); each label cites the facts it used; degraded input gives "not assessed" |
| Scorer | no finding at an unresolved version; scope invariants (one scope per package across views); ranks stable |
| Output | schema validation (SARIF 2.1.0, CycloneDX 1.6, SPDX 2.3 via ajv, which is already a dev dependency); hostile strings (`<script>`, markdown, `@mentions`, control characters) are escaped; byte-identical across runs |
| GapFillTask | the gate rejects wrong subject, wrong date, wrong domain (including redirects) and missing quote; privacy refusals happen with no model call; recorded model replays |
| Notifier | HMAC signature valid; no redirects followed; private IP targets refused |

### 2.5 Enforced boundaries

- **dependency-cruiser** (MIT; verify the licence and that it runs with TypeScript 7). It is a dev dependency, so it needs no ESLint set-up. Use `eslint-plugin-boundaries` (MIT) only if ESLint is adopted anyway.
- **Rules, run in CI with `depcruise --validate`:**
  - `no-circular`;
  - `core/**` imports nothing outside `core`;
  - `plugins/<kind>/<x>/**` may import only `core/**` and its own folder;
  - only a plugin's `index.ts` may be imported from outside it (no deep imports);
  - `engine/**` imports `core` and `plugins/index.ts` only;
  - `apps/**` imports `engine` and `core`, never plugin internals;
  - `node:child_process` only in `core/sandbox/**`;
  - `fetch`/`undici` only in `core/http/**` (an ESLint `no-restricted-globals` rule, or a grep check in CI if there is no ESLint);
  - `**/testing.ts`, `**/fixture.ts` and `test/**` are never imported from production code;
  - `web/src/**` may import only `@server/contract/**`.
- **Ratchet:** start in report-only mode with today's violations listed as known (`--ignore-known`). Each stage removes its own entries. The known list may only shrink.
- **Licence check:** `license-checker-rseidelsohn` or `npm query` plus an allow-list (MIT, ISC, Apache-2.0, BSD-*, BlueOak) on every new dependency, both packages.

### 2.6 The web app

```
web/src/
  app/ (shell, routes.tsx, nav, auth)      shared/ui (shadcn), shared/lib, shared/api/transport.ts
  features/<f>/{api.ts, pages/, components/, *.test.tsx}
    f ∈ findings · exposure · stability · licenses · incidents · accounts · agentic · scans · projects · settings · changes · reports
```

- **The route contract is one table**, in `server/contract/routes.ts`:
  - each entry has `{ method, path, params, query, body (zod), response: TypeRef, perm: Permission | 'public' | 'session' }`;
  - the server registers handlers from it;
  - `features/*/api.ts` call a typed client generated from it (or Hono's `hc` RPC client typed from the app).
- **Tests:**
  - every registered route is in the table;
  - every table entry has `perm`;
  - the web client covers only table entries.
- The feature folders mirror the plugin families. A new collector that adds a page section adds one feature folder.

### 2.7 Security architecture

- **Network allow-list:**
  - `ctx.http` is scoped per plugin to its `HostRule`s, https only;
  - every redirect hop is followed manually and re-checked;
  - IP-literal, private, loopback and link-local destinations are blocked after DNS resolution, for any plugin that fetches URLs it did not build itself (agentic verify/tools, notifiers, webhook outputs);
  - `maxBytes` and timeouts apply per plugin.
- **Secrets:**
  - `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, `OPENCOLLECTIVE_API_KEY` and the identity salt are read once into a `SecretStore`;
  - a plugin sees only the ids it declares;
  - HttpClient attaches a token only to its declared host and drops it on cross-host redirects;
  - the fixture recorder and logs redact secrets;
  - secrets never appear in `ScanResult`, coverage reasons or warnings (kit check).
- **Sandbox** (`core/sandbox`), one runner for git and syft:
  - `execFile` with no shell, a scrubbed env (today's `cloneEnv`) and `GIT_ALLOW_PROTOCOL=https`;
  - hooks, submodules and LFS off; `--no-checkout` / blobless clones;
  - a 0700 temp dir; the shared disk budget; kill on abort;
  - syft pinned and checksum-verified, network off.
  - Later option: bubblewrap or nsjail on the server.
- **Input hardening:**
  - size caps per file type;
  - `yaml` with a `maxAliasCount` limit;
  - the own TOML parser fuzzed;
  - JSON depth caps;
  - npm tarball reading in memory, with no extraction and no path joins;
  - README and HTML parsed as text only;
  - all outputs escape through one `escape.ts` per format, including markdown for PR comments (neutralise `@mentions`, links and HTML).
- **SSRF:**
  - the server's scan targets keep `targets.ts`'s allow-list;
  - customer webhook URLs go through the same private-range block, with no redirects;
  - the server never fetches a user-supplied URL outside a declared plugin.
- **Authz:**
  - permissions are declared per route (§2.6);
  - CSRF stays;
  - MCP and assistant tokens: read-only GET subset, short TTL, audited;
  - person-level fields are stripped unless the caller has `manage_projects`.
- **Prompt-injection boundaries** (agentic, Ask Blastradius):
  - fetched pages and tool results are wrapped as data, never as instructions;
  - the model reaches the network only through tools with per-task domain allow-lists;
  - every proposed fact passes the deterministic gate (re-fetch, quote, domain, subject, date);
  - nothing the model says enables a plugin, changes config or writes outside `agent_fact`;
  - privacy screening happens before any model call.

---

## 3. Mapping: current → target

| Current | Target | Action |
|---|---|---|
| `core/types.ts` | `core/types/{purl,inventory,entity,incident,result}.ts` + `core/facts/<family>.ts` (zod) | split; keep a `core/types.ts` re-export barrel during migration |
| `core/http.ts`, `proxy.ts` | `core/http/{client,transport,fixtures,egress,proxy}.ts` | split; add `ScopedHttp` |
| `core/plugin.ts` | `core/plugin/{manifest,contexts,kinds}.ts` + `engine/registry.ts` | grow |
| `core/scope.ts`, `paths.ts`, `install-flags.ts` | stay in core | — |
| `core/osv-range.ts` + `enrich/npm/packument.compareVersions` + `history/continuity.isPrereleaseVersion` | `core/ids/version/{npm,pypi,semver}.ts` | merge (breaks cycle 1) |
| `core/repo-url.ts`, `enrich/npm/repo.ts` (URL part), `enrich/depsdev/repo.ts`, `stability/repo.ts` (`repoKey`, `sameRepo`), `history/repo-url.ts`, regexes | `core/ids/repo.ts` (`parseRepo`, `canonical`, `sameRepo`, `isNonRepositoryUrl`) | merge |
| `ingest/python.normalizePypiName`, `pypiPurl`, `isExactPypiVersion`; npm name helpers in types | `core/ids/package.ts` | move |
| `mapLimit`, `errorMessage`, `isObject`, `isRecord`, `addMonths`, `daysBetween` | `core/util/{concurrency,errors,guards,time}.ts` | merge |
| `history/identity.ts` (salt, normalise), parts of `history/merge.ts` | `core/identity/` | move |
| `ingest/git.ts` (runner, `cloneEnv`, `checkGitUrl`), `ingest/syft.ts` runner, `history/git.ts` (`runGit`, clone cache, budget) | `core/sandbox/{git,syft,budget}.ts` | merge |
| agentic result cache, history clone cache, pack cache | `core/cache` (namespaces, TTL, budget) | merge |
| `ingest/{npm,python,workflows,docker,syft,toml,config,manifests,fs}` | `plugins/ingest/{npm,python,actions,docker,syft}`; `toml`/`fs` → `core/parse`; `manifests` → `engine/not-analysed` | split, adapters |
| `ingest/index.ts` | `engine/ingest.ts` (detect, dispatch, merge parts) | shrink |
| `enrich/osv`, `depsdev`, `npm`, `pypi`, `github`, `licenses`, `history`, `pack` | `plugins/collect/<same>` | move; cut imports of stability/history into core/domain or FactView |
| `enrich/npm/packument.ts` (cadence and publisher derivation) | collector emits raw facts; `core/domain/cadence.ts` (from `stability/cadence`) | split |
| `enrich/github/opencollective.ts`, `funding-yml.ts` | `plugins/collect/funding` (later with funding.json) | split |
| `history/{aggregate,continuity,merge,record,graphql,bots}` | `plugins/collect/history/*` (internals); `bots` → `core/domain/bots.ts` | move |
| `history/fixture.ts`, `testing.ts` | `test/support/history` + a replay transport in `core/sandbox` | move (out of prod imports) |
| `incidents/{loader,schema}` + `kb/` | `plugins/collect/kb-incidents` | move |
| `incidents/osv-import.ts` | `plugins/resolve/incidents` (malware facts → incidents) | move |
| `entities/*` | `plugins/resolve/entities` (+ review state) | move |
| `stability/*` | `plugins/rules/stability` (`label.ts` split per rule family: ended, inactive, continuity, declared) | move + split |
| `licenses/{spdx,classify,data}` | `core/domain/license/*` (pure, shared by collector, rules and outputs) | move |
| `licenses/{policy,report,history}` | `plugins/rules/licenses` | move |
| `scoring/{intrinsic,entity,outbound,incidents,index}` | `plugins/score/{intrinsic,entity,exposure}`; `weights.ts` → each scorer's config (zod defaults) | split |
| `scoring/blast.ts` (graph, exposure), `report/reach.ts`, `watch/match.ts`, `server/{reach,graph,known-bad}.ts` | `engine/query/{graph,exposure,reach}.ts` | merge |
| `report/{json,sarif,html,html-behind,sbom,coverage,escape}` | `plugins/output/{json,sarif,html,cyclonedx,spdx}` + `core/escape` | split |
| new | `plugins/output/{pr-comment,grc-evidence,webhook}`, `apps/mcp`, `apps/action` | add |
| `watch/account.ts`, `accounts/registry.ts`, npm calls in `server/accounts.ts` / `incidents.ts` | `plugins/collect/npm-accounts` exposing an on-demand query through the engine | merge |
| `pack/*` | `plugins/collect/pack` + `apps/cli pack build` | move |
| `agentic/*`, `enrich/agentic` | `plugins/gapfill/<task>` (one file per task from `tasks.ts`) + `engine/gapfill` (agent loop, gate, budget, privacy) | split |
| `pipeline.ts` | `engine/run.ts`; report writing (`writeReportFile`, symlink checks) → `apps/cli/write.ts` | split |
| `cli.ts`, `summary.ts` | `apps/cli/` | move |
| `server/*` | `apps/server/{contract,routes,store,jobs,auth}` | move; routes from the contract table |
| `server/watch.ts`, `store/alert-rules.ts`, `alerts.ts` | `plugins/notify/{slack,webhook}` + `engine/events` | split |
| `server/api-types*.ts` | `apps/server/contract/*` (shared with web) | move |
| `web/src/pages`, `components`, `api-*.ts` | `web/src/features/*` | move |
| new | `learning/{feedback,event-log,eval}` (uses lineage and the query API) | add |

---

## 4. Staged refactor plan

**Gate for every stage:**
- `npm run typecheck`, `npm test`, `npm run build`, web unit tests and e2e are all green;
- the golden-output diff is empty except for differences declared in `test/golden/DECLARED.md` (JSON path, reason, stage);
- the dependency-cruiser rules pass, and the known-violations list only shrinks;
- the contract kit passes for every plugin touched.

**Per-module optimisation loop**, run on each stage's diff:
1. `/simplify`;
2. `/code-review` at high effort;
3. `/security-review`;
4. fix;
5. the gate.

Behaviour changes found by review get their own small PR, never mixed into a move.

| # | Stage | Scope and files | Risks | Effort | Unlocks |
|---|---|---|---|---|---|
| 0 | **Golden harness + boundary tooling** | `test/golden/run.ts`: replays tier05 parse-server, jitsi-meet and superset, plus flask (tier0 + tier05-pypi), offline through `scan()` with the default plugin set. It writes normalised JSON, SARIF, CycloneDX, SPDX and HTML (generatedAt, tmp paths and durations removed; arrays sorted where order is not meaningful). Add dependency-cruiser config in report-only mode, a licence-check script and CI jobs | recordings lack GitHub (403), history and ClearlyDefined: those sources show as failed/offline. That is deterministic, but coverage is partial (§6). Large snapshots: store gzipped with a structural diff tool | 2–3 d | every later stage |
| 1 | **Core extraction** | `core/util`, `core/ids/{repo,package,version}`, `core/identity`, `core/sandbox`, `core/cache`, `core/domain/{license,cadence,bots,time}`; old paths re-export. Breaks both cycles. Fix the stale `stability/production.ts` comment | repo URL merge changes edge cases. Write a table test from all current implementations first; any output change is declared | 4–5 d (split into 1a utils/ids, 1b sandbox/cache, 1c domain) | ecosystem helpers for new ingestors |
| 2 | **Plugin contracts + registry + engine** | `core/plugin/*`, `engine/{registry,run,coverage,lineage}`; wrap today's enrichers with a `legacyCollector()` adapter (manifest + existing `enrich()`); replace `enricherStages`, `osvComplete` and `SECURITY_SOURCES` with manifest data; run ids and lineage (QUALITY-SYSTEM Q1); `ScopedHttp` in log-only mode; kits for all kinds | DAG concurrency changes warning order: sort in the engine. Lineage fields are additive (declared diff) | 5–6 d | learning loop Q1; adding plugins |
| 3 | **Outputs** | `plugins/output/{json,sarif,html,cyclonedx,spdx}` with the output kit; then new `pr-comment` and `webhook` (signed); `apps/mcp` skeleton on the query API | HTML escaping regressions: covered by hostile-string kit cases | 3 d + new outputs | GitHub Action, MCP, webhooks (ROADMAP §3) |
| 4 | **Ingestors** | `plugins/ingest/{npm,python,actions,docker,syft}`, `engine/ingest`; then new `yarn`, `pnpm`, `bun`, `gomod`, `gemfile` as thin adapters over the Syft discovery (ROADMAP §2.3) | scope regressions: golden plus tier0/tier05 scope tests | 3 d move; ~2 d per new adapter | ecosystem coverage |
| 5 | **Collectors, one PR each** | in order: osv, depsdev, pack, kb-incidents, licenses, npm (split packument), pypi, github/funding, then history (after t06 lands); each loses its cross-plugin imports (use `FactView` or core/domain) and gets unit tests through the kit (pypi, licenses and history have none colocated today); enforce `ScopedHttp` | npm packument split; history disk budget behaviour | 1–2 d each, ~12 d total | ecosyste.ms, funding.json, ORT as new collectors |
| 6 | **Resolvers** | `plugins/resolve/{entities,incidents}`; review state; npm-accounts collector replaces server's direct npm calls | owner-type rules (Tier 0 #7) | 2–3 d | SortingHat resolver |
| 7 | **Rules** | `plugins/rules/{stability,licenses,coverage,invariants,events}`; split `stability/label.ts`; drift guard and invariants as an engine stage | precision rules from Tier 0.5: no logic edits, moves only | 4 d | event log (Q2) |
| 8 | **Scoring** | `plugins/score/*`; `weights.ts` → config schemas; `engine/query/{graph,exposure,reach}` merges `scoring/blast`, `watch/match`, `report/reach` and `server/reach` | exposure answers must equal across views (tier0 test) | 3 d | eval harness can swap rule configs |
| 9 | **Server** | `apps/server`: route contract table with `perm` per route; handlers move; jobs use `engine.rerun`; `history/fixture` import gone; route/perm tests | authz gaps surfaced: fix in separate security PRs | 5 d | MCP HTTP transport, Ask Blastradius tokens |
| 10 | **Web** | `features/*`; typed client from the contract; route coverage test | e2e selectors | 4 d | per-feature UI for new collectors |
| 11 | **Agentic** | `plugins/gapfill/<task>` from `tasks.ts`; `engine/gapfill` (loop, gate, budget, privacy); egress block for private ranges | gate regressions: `test/agentic` live-replay must stay identical | 3–4 d | new gap-fill tasks, Ask Blastradius |
| 12 | **Learning loop hooks** | `learning/{feedback,event-log,eval}` on lineage + golden + backtests | — | QUALITY-SYSTEM Q2 (2–3 w) | the loop |

**What can run in parallel safely**
- Stage 0 must finish first. Stages 1a, 1b and 1c can run in parallel: they touch disjoint folders.
- Stage 2 must finish before stages 3–11.
- After stage 2, these touch disjoint folders and can run in parallel (one agent or worktree each):
  - outputs (3);
  - ingestors (4);
  - each collector in 5, except history;
  - web feature-folder moves (10, without the typed client).
- `history` and `stability` wait for the t06 agent's work to merge. Then they go as one serial track: collect/history → rules/stability.
- Stage 9 (server) needs 6 and 8, because it imports query and accounts. Stage 10's typed client needs 9's contract table.
- Never run two stages that edit `core/types` or `engine/run.ts` at the same time. Changes there are serial and small.

---

## 5. Lining this up with splitting PR #2

**Recommendation: split PR #2 as-is (the stacked plan in ROADMAP §1.2) and merge it to main. Then run this refactor on main as small PRs.** Do not restructure while splitting.

Reasons:
1. **The split can be verified.** ROADMAP §1.2's acceptance is `git diff main docs/blast-radius-plan` = empty, plus the same test counts. Moving files during the split would break that check and mix two kinds of review.
2. **The refactor needs main.** It needs CI on main and the golden harness (stage 0). Each refactor PR is then a pure move with a provable "no output change", which is quick to review.
3. **Conflict risk is lower.** Work is still landing on the branch (t06 on history and stability). Re-cutting a moving target while also renaming paths would multiply rebase conflicts.
4. **Review cost stays one-time.** The split PRs are reviewed for behaviour. The refactor PRs are reviewed for structure, mostly by diff-of-moves (`git log --follow` keeps history).
5. **One cheap exception.** Add stage 0 (golden harness, dependency-cruiser in report-only mode) as an extra PR on top of the stack, right after PR 11. It changes no product code, and every later PR needs it.

Freeze new feature work on PR #2 while it is cut (ROADMAP's own dependency). Land t06 first, or rebase it onto the split stack.

---

## 6. Risks and open decisions for the owner

1. **Golden coverage is partial.** The recorded scans lack GitHub (403 here), git history at full scale, ClearlyDefined and agentic. Decide whether to:
   - (a) accept partial goldens plus the existing history and agentic replays; or
   - (b) run one networked recording session with a GitHub token to record the four repos fully. Expect about 1 GB of fixtures; keep them out of git, or use LFS or an artifact store.
2. **Where the fact vocabulary lives.** I recommend keeping it in core with zod schemas, so plugins talk only through core types. The alternative is module augmentation per plugin: more decoupled, but harder to keep honest.
3. **Folders or packages.** I recommend folders plus dependency-cruiser now. Move to npm workspaces packages only if outside plugins become a goal.
4. **Third-party or out-of-tree plugins.** I recommend not supporting them for now: static registry only. A supply-chain tool loading unsigned plugins is a risk.
5. **The tool choice.** dependency-cruiser or eslint-plugin-boundaries. Both need checking against TypeScript 7 and the licence allow-list.
6. **Runtime validation cost.** Zod checks on every fact cost something: superset has about 3k components and tens of thousands of facts. Measure in stage 2. A fallback is validating in dev/CI and sampling in production.
7. **Stable ids.** Keep `Fact.source` ids and the `coverage.sources` names unchanged. Stored scans and the DB depend on them.
8. **Ordering changes.** DAG concurrency may reorder warnings and facts. The engine must sort them, or goldens will churn.
9. **Authz gaps may appear in stage 9.** Treat them as security fixes in their own PRs, ahead of the move.
10. **Effort.** Stages 0–11 are roughly 8–10 engineer-weeks; stages 5 and 4's new adapters are the bulk. Stage 12 is the QUALITY-SYSTEM schedule.
11. **Sequencing against the roadmap.** The owner should confirm that outputs (stage 3, GitHub Action and MCP) come before ingestors and collectors. It moves "Integrations" ahead of "Ecosystem coverage" but needs only the plugin contracts.

### Critical files for implementation
- `/home/user/56/blastradius/src/pipeline.ts`
- `/home/user/56/blastradius/src/core/plugin.ts`
- `/home/user/56/blastradius/src/core/types.ts`
- `/home/user/56/blastradius/src/core/http.ts`
- `/home/user/56/blastradius/test/tier05/replay.ts` (base for the golden harness)

Also central: `/home/user/56/blastradius/src/core/osv-range.ts` and `/home/user/56/blastradius/src/stability/label.ts` (the two cycles), `/home/user/56/blastradius/src/server/context.ts` (authz) and `/home/user/56/blastradius/CONTRACTS.md`.
---

## 7. Owner decisions (2026-10-13)

1. **PR #2:** split it as-is into the stacked PRs from ROADMAP §1.2 and merge them to main. Then run this refactor on main as small "no output change" PRs.
2. **Golden outputs:** start partial (the recorded scans plus the history and agentic replays). Record the full set once a GitHub token is available.
3. **Order after stage 2:** outputs first (stage 3: GitHub Action PR comment, MCP for Claude Code, webhooks), then ingestors and collectors.
4. **Plugins:** built-in only, with a static registry. No third-party or out-of-tree plugins until signing is designed.
