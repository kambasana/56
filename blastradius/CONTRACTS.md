# Blastradius shared contracts

These contracts are the source of truth between modules. The TypeScript is in
`src/core/types.ts`, `src/core/http.ts` and `src/core/plugin.ts`. If you need
to change a contract, agree it first; do not fork types locally.

General rules for all modules:

- ESM, Node 22, TypeScript strict (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`).
  Import with `.js` suffixes: `import type { Fact } from '../core/types.js'`.
- All data is plain JSON. Timestamps are ISO-8601 strings (`new Date().toISOString()`); dates are `YYYY-MM-DD`.
- Everything read from scanned repos, lockfiles, workflows or registries is **untrusted**: never execute it,
  never pass it to a shell, cap sizes, and escape it when rendering (HTML/SARIF).
- Network access only through `HttpClient` (`ctx.http`). Tests are fully offline (`BLASTRADIUS_OFFLINE=1`
  is set by `vitest.config.ts`); use in-memory fixtures or fixture envelopes under `test/fixtures/<module>/`.
- Wording about people/orgs is factual and sourced ("linked to INC-2018-0001 (confirmed)"). Never call anyone
  malicious. No nationality-based scoring.

## Module ownership

| Directory | Owner / purpose |
|---|---|
| `src/core` | foundation (this document) |
| `src/ingest` | static parsers (package-lock / package.json / workflows / Dockerfile, optional syft) → `Inventory` |
| `src/enrich/osv` | `vuln`, `malware` facts |
| `src/enrich/depsdev` | `scorecard`, `provenance`, `dependents`, `repo` facts (deps.dev + Scorecard API) |
| `src/enrich/npm` | `maintainers`, `publisher`, `publisher_change`, `maintainer_change`, `install_script`, `release_age`, `funding`, `repo`, `provenance` |
| `src/enrich/github` | `repo_owner`, `repo_transfer`, `archived`, `funding` |
| `src/entities` | `Entity` / `EntityLink` from facts |
| `src/incidents` + `kb/incidents` | YAML incident KB loader + validator → `Incident[]` |
| `src/scoring` | intrinsic, entity, combined risk, inbound blast radius → `Finding[]` (PLAN §3.6) |
| `src/report` | JSON / SARIF / HTML renderers of `ScanResult` |
| `test/fixtures` | recorded API responses, one subdirectory per module |
| `test/backtest` | historical incident replays |
| `src/pipeline.ts`, `src/cli.ts` | integration (placeholder `runScan` / `validateKb` throw "not implemented") |

---

## 1. Package URLs (`src/core/types.ts`)

```ts
type Ecosystem = 'npm' | 'githubactions' | 'docker' | 'generic';
type PurlString = string;
interface Purl { type: string; namespace?: string; name: string; version?: string;
                 qualifiers?: Record<string, string>; subpath?: string }

parsePurl(s: string): Purl              // throws PurlParseError
formatPurl(p: Purl): PurlString         // canonical: lower-case type, sorted qualifiers, percent-encoded
normalizePurl(s: string): PurlString    // formatPurl(parsePurl(s))
npmPurl(packageName: string, version?: string): PurlString   // npmPurl('@babel/core','7.24.0') → 'pkg:npm/%40babel/core@7.24.0'
splitNpmName(name: string): { namespace?: string; name: string }
npmNameFromPurl(purl: PurlString | Purl): string             // → '@babel/core'
unversionedPurl(purl: PurlString): PurlString                // 'pkg:npm/x@1' → 'pkg:npm/x'
```

Conventions:

- npm: `pkg:npm/<name>@<version>`, scoped `pkg:npm/%40scope/name@<version>`. npm names are lower-cased.
  Always build npm purls with `npmPurl()` and compare canonical strings.
- GitHub Actions: `pkg:githubactions/<owner>/<repo>@<ref>`; a sub-path action (`owner/repo/path@ref`) uses
  the purl subpath `#path`. Reusable workflows: `pkg:githubactions/<owner>/<repo>@<ref>#.github/workflows/x.yml`.
- Docker images: `pkg:docker/<namespace>/<name>@<tag-or-digest>` (`library/node` for official images).

## 2. Inventory (ingest output)

```ts
type AssetKind = 'repo' | 'workflow' | 'image';
type Environment = 'prod' | 'staging' | 'dev' | 'ci';
type Criticality = 1 | 2 | 3 | 4 | 5;

interface Asset {
  id: string;              // 'repo:<name>', 'workflow:<path>', 'image:<path>'
  kind: AssetKind;
  name: string;
  environment: Environment;
  criticality: Criticality;
  sourceFile: string;      // path relative to the scan root
  ci?: { hasWriteTokens?: boolean; hasOidc?: boolean; publishes?: boolean };  // for workflows
}

interface Component {
  purl: PurlString;        // versioned, canonical; unique within an Inventory
  ecosystem: Ecosystem;
  name: string;            // '@scope/name', 'owner/repo', 'library/node'
  version: string;
  hasInstallScript?: boolean;
  resolved?: string;       // untrusted
  integrity?: string;
  pinning?: 'sha' | 'tag' | 'branch' | 'digest' | 'unpinned';   // actions/images
}

type DepScope = 'runtime' | 'dev' | 'optional' | 'peer' | 'build';
interface DepEdge { from: string /* Asset.id or purl */; to: PurlString; scope: DepScope; direct: boolean }

interface Inventory { assets: Asset[]; components: Component[]; edges: DepEdge[] }

interface InventorySummary {
  assets: number; components: number; edges: number; directComponents: number;
  byEcosystem: Partial<Record<Ecosystem, number>>;
  byScope: Partial<Record<DepScope, number>>;
  withInstallScripts: number;
}
summarizeInventory(inv: Inventory): InventorySummary
```

Edge rules: `direct === true` iff `from` is an `Asset.id`. Workflow `uses:` actions get scope `build`.
Default environments: repo → `prod`, workflow → `ci`, image → `prod`; default criticality 3.

## 3. Facts (enrichment output)

```ts
interface TypedFact<K extends FactKind> {
  subject: PurlString;     // versioned purl for version facts, unversioned for package facts
  kind: K;
  value: FactValueMap[K];
  source: string;          // 'osv' | 'depsdev' | 'scorecard' | 'npm' | 'github' | 'kb' | ...
  fetchedAt: string;       // ISO timestamp
  evidence?: string[];     // public URLs
}
type Fact = { [K in FactKind]: TypedFact<K> }[FactKind];   // discriminated on `kind`

makeFact(kind, subject, value, { source, fetchedAt: string | Date, evidence? }): TypedFact<K>
isFactKind(k: string): k is FactKind
isFactOf(kind)                         // narrowing filter: facts.filter(isFactOf('vuln'))
factsFor(facts, purl, kind?)           // matches versioned purl and its unversioned form
FACT_KINDS                             // readonly array of all kinds
```

### Fact kinds vocabulary and value shapes

| kind | subject | value shape | producers |
|---|---|---|---|
| `vuln` | versioned | `{ id: string; aliases: string[]; summary?: string; severity: 'critical'\|'high'\|'medium'\|'low'\|'unknown'; cvss?: number /*0–10*/; cvssVector?: string; epss?: number /*0–1*/; kev?: boolean; fixedVersions: string[]; url?: string; published?: string /*ISO; advisory publish time, used by --as-of replays*/ }` | osv |
| `malware` | versioned | `{ id: string /*MAL-… or INC-…*/; summary?: string; origin: 'osv'\|'incident'\|'other'; url?: string; published?: string }` | osv, kb |
| `scorecard` | unversioned | `{ score: number /*0–10*/; date?: string; repo: string /*github.com/o/r*/; checks: { name: string; score: number; reason?: string }[] }` | depsdev/scorecard |
| `provenance` | versioned | `{ hasProvenance: boolean; type?: string /*'slsa-v1'\|'npm-attestation'\|'sigstore'*/; sourceRepo?: string; url?: string }` | depsdev, npm |
| `dependents` | unversioned | `{ count: number; direct?: number; indirect?: number }` | depsdev |
| `maintainers` | unversioned | `{ maintainers: { name: string; email?: string }[]; count: number }` | npm |
| `publisher` | versioned | `{ name: string; email?: string; version: string; publishedAt?: string; trustedPublisher?: boolean }` | npm |
| `publisher_change` | versioned | `{ version: string; previousVersion: string; previousPublisher: string; newPublisher: string; changedAt: string; firstTimePublisher: boolean /*true when newPublisher had not published this package before `version`*/ }` | npm |
| `maintainer_change` | unversioned (or versioned when tied to a release) | `{ added: string[]; removed: string[]; changedAt: string; version?: string; daysBeforeRelease?: number }` | npm, snapshots |
| `install_script` | versioned | `{ hasInstallScript: boolean; hooks: ('preinstall'\|'install'\|'postinstall'\|'prepare')[]; commands: Partial<Record<hook, string /*≤500 chars, never executed*/>>; flags?: string[] }` | npm |
| `repo` | unversioned | `{ url: string /*https://github.com/o/r*/; host: 'github'\|'gitlab'\|'bitbucket'\|'other'; owner?: string; name?: string; directory?: string; via: string /*'npm.repository'\|'depsdev.links'\|'provenance'*/ }` | npm, depsdev |
| `repo_owner` | unversioned | `{ repo: string; owner: string; ownerType: 'User'\|'Organization'; url: string }` | github |
| `repo_transfer` | unversioned | `{ repo: string; fromOwner: string; toOwner: string; detectedAt: string; transferredAt?: string }` (`detectedAt` = when observed; decay only from `transferredAt`) | github, snapshots |
| `funding` | unversioned | `{ sources: { platform: string; handle?: string; url?: string }[]; via: string /*'package.json#funding'\|'FUNDING.yml'\|'opencollective'*/ }` | npm, github |
| `archived` | unversioned | `{ archived: boolean; lastPushAt?: string }` | github, depsdev |
| `release_age` | versioned | `{ version: string; publishedAt: string; ageDays: number; latestVersion?: string; latestPublishedAt?: string; daysSinceLatestRelease?: number; deprecated?: string }` | npm |

Notes:
- `ageDays` / `daysSinceLatestRelease` are computed against `EnrichContext.now`, never the wall clock.
- `email` fields are kept only when public in registry metadata; reports should not display them.
- When a source has no data for a component, emit no fact (don't emit empty placeholders), except
  `install_script` / `provenance` which may emit `false` explicitly when the registry was checked.

## 4. Entities

```ts
type EntityType = 'person' | 'org' | 'funder' | 'account';
interface Entity { id: string; type: EntityType; name: string }
// id conventions: 'account:npm/<handle>', 'account:github/<login>', 'org:github/<login>',
//                 'person:<slug>', 'funder:opencollective/<slug>'

type EntityRelation = 'maintains' | 'publishes' | 'owns' | 'funds' | 'member_of' | 'linked_to';
interface EntityLink {
  from: string; to: string;        // Entity ids or unversioned component purls
  relation: EntityRelation;
  confidence: number;              // 0–1
  evidence: string[];              // ≥1 public URL
  method: 'deterministic' | 'probabilistic';
  reviewed: boolean;               // probabilistic links < 0.8 must be reviewed before scoring uses them
}
```

Direction: `account:npm/x --maintains--> pkg:npm/foo`, `org:github/o --owns--> pkg:npm/foo`,
`account:github/x --member_of--> org:github/o`, `funder:… --funds--> org:github/o`.

## 5. Incidents

```ts
INCIDENT_TYPES = ['malware_publish','account_takeover','maintainer_sabotage','maintainer_infiltration',
  'malicious_handover','ci_compromise','domain_or_name_takeover','typosquat','abandonment',
  'crypto_rugpull','sanctions'] as const;
type IncidentStatus = 'confirmed' | 'alleged' | 'disputed' | 'retracted';
type IncidentSeverity = 'critical' | 'high' | 'medium' | 'low';
interface Incident {
  id: string;                      // 'INC-YYYY-NNNN'
  title: string;
  type: IncidentType;
  status: IncidentStatus;
  date: string;                    // YYYY-MM-DD
  severity: IncidentSeverity;
  affected: { purl: PurlString /*unversioned*/; versions: string[] /*exact, or ['*']*/ }[];
  entities: { ref: string /*Entity id*/; role: string /*factual*/; confidence: number }[];
  evidence: string[];              // ≥1 public URL
  reviewed_by?: string[];
}
```

YAML files in `kb/incidents/*.yaml` use exactly these field names. Status weights for scoring:
confirmed 1.0, alleged 0.4, disputed/retracted 0.

## 6. Scoring and results

```ts
type RiskLevel = 'critical' | 'high' | 'medium' | 'low';
LEVEL_THRESHOLDS = { critical: 80, high: 60, medium: 30 };
levelForScore(score): RiskLevel    // critical ≥80, high 60–79, medium 30–59, low <30

interface Reason {
  factor: string;       // 'malware' | 'vuln' | 'maintainer_change' | 'publisher_change' | 'install_script' |
                        // 'weak_posture' | 'no_provenance' | 'single_maintainer' | 'abandoned' | 'entity_incident' | ...
  value: number;        // fᵢ in 0–1
  weight: number;       // wᵢ
  contribution: number; // marginal contribution to 0–1 risk
  detail: string;       // factual, human-readable
  evidence: string[];
}

interface AssetExposure { assetId: string; exposure: number; paths: string[][] /* [assetId, purl, …, purl] */ }

interface Finding {
  purl: PurlString;     // versioned
  score: number;        // 0–100 (= combined risk × 100)
  level: RiskLevel;     // levelForScore(score)
  reasons: Reason[];
  blastRadius: { assets: AssetExposure[]; score: number };
  // from → entityId per link; first `from` is the unversioned purl, last entityId is the incident id.
  entityChain: { from?: string; entityId: string; relation: EntityRelation | 'incident'; confidence: number; evidence?: string[]; method?: 'deterministic' | 'probabilistic'; reviewed?: boolean }[];
}

interface OutboundFinding { assetId: string; score: number; dependents?: number; reasons: Reason[] }

interface ScanResult {
  schemaVersion: '1';
  target: string;
  generatedAt: string;
  inventory: InventorySummary;
  findings: Finding[];             // sorted by score desc
  outbound?: OutboundFinding[];
  warnings?: string[];
}
```

Exposure values (PLAN §3.6): runtime/prod 1.0, build/CI 0.8, install script anywhere 0.9, dev 0.3, optional 0.2
(`peer` treated as runtime). Reach multiplier ×1.2 when a workflow asset has write tokens / OIDC / publish
secrets, ×0.7 when pinned by hash.

## 7. HTTP client (`src/core/http.ts`)

```ts
class HttpClient {
  constructor(opts?: HttpClientOptions);
  readonly offline: boolean;
  requestCount: number;
  fetchJson<T>(url: string, opts?: RequestOptions): Promise<T>;            // throws HttpError (non-2xx) / OfflineMissError
  fetchJsonOrNull<T>(url: string, opts?: RequestOptions): Promise<T | null>; // null on 404
  fetchText(url: string, opts?: RequestOptions): Promise<string>;
  request(url: string, opts?: RequestOptions): Promise<{ status: number; body: string }>;
  addFixture(key: string, value: unknown): void;
}
interface RequestOptions { method?: 'GET' | 'POST'; headers?: Record<string,string>; body?: unknown; ttlMs?: number; timeoutMs?: number }
interface HttpClientOptions {
  transport?: Transport;                     // (req: TransportRequest) => Promise<{ status; body: string }>
  cacheDir?: string | false;                 // default <user cache dir>/http (core/paths.ts), never the cwd
  defaultTtlMs?: number;                     // default 24h
  offline?: boolean;                         // default process.env.BLASTRADIUS_OFFLINE === '1'
  fixtures?: Record<string, unknown>;        // key → JSON value, or { status, response }
  fixturesDir?: string;                      // default process.env.BLASTRADIUS_FIXTURES
  minIntervalMs?: number;                    // per-host rate limit, default 100
  hostIntervals?: Record<string, number>;
  maxRetries?: number;                       // 429/5xx/network, default 2, exponential backoff
  maxBytes?: number;                         // default 25 MB
  userAgent?: string;
  now?: () => number; sleep?: (ms: number) => Promise<void>;
}
fixtureKey(url, method = 'GET', body?): string   // 'GET <url>' | 'POST <url> <sha256(body)[0..16]>'
fetchJson<T>(url, opts & { client?: HttpClient }): Promise<T>   // convenience wrapper
class HttpError { url; status }   class OfflineMissError { url; key }
```

Resolution order: fixtures (exact `fixtureKey`, then plain URL) → disk cache (fresh; any age when offline) →
transport (online only) → `OfflineMissError`.

**Fixture envelope files** (any `*.json` under the fixtures dir, searched recursively; other JSON is ignored):

```json
{ "request": { "url": "https://api.osv.dev/v1/querybatch", "method": "POST", "body": { "queries": [] } },
  "status": 200,
  "response": { "results": [] } }
```

Omit `request.body` to match any body for that URL; omit `status` for 200; use `"status": 404` to record
"not found". `response` must match the real, documented API response shape. Put fixtures in
`test/fixtures/<module>/`.

## 8. Enricher plugin (`src/core/plugin.ts`)

```ts
interface EnrichContext {
  http: HttpClient;
  now: Date;                       // fixed per scan; use for all age calculations
  offline: boolean;
  warn?: (message: string) => void;
}
interface Enricher {
  name: string;                    // also used as Fact.source by convention
  enrich(inv: Inventory, ctx: EnrichContext): Promise<Fact[]>;
}
runEnrichers(enrichers, inv, ctx): Promise<Fact[]>   // sequential; a throwing enricher becomes ctx.warn
```

Each enricher module exports a factory, e.g. `export function createOsvEnricher(opts?): Enricher`.
Enrichers skip ecosystems they don't handle, batch requests where the API allows, and turn per-component
failures (including `OfflineMissError`) into `ctx.warn` rather than throwing.

## 9. Pipeline and CLI

```ts
// src/pipeline.ts
type OutputFormat = 'json' | 'sarif' | 'html';
interface ScanOptions { target: string; format: OutputFormat; outDir: string; offline: boolean; fixturesDir?: string; now?: Date }
runScan(opts: ScanOptions): Promise<ScanResult>               // placeholder: throws 'not implemented'
validateKb(dir: string): Promise<{ ok: boolean; files: number; errors: { file: string; message: string }[] }>  // placeholder
```

CLI: `blastradius scan <target> [--format json|sarif|html] [--out dir] [--offline] [--fixtures dir]`
(`--fixtures` implies offline) and `blastradius kb validate [dir]` (default `kb/incidents`).
`buildProgram()` is exported from `src/cli.ts` for tests.

Commands: `npm run typecheck`, `npm test`, `npm run build`, `npm start -- scan <target>`.
