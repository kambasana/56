/**
 * Import boundaries (docs/ARCHITECTURE.md §2.5; docs/REFACTOR.md "Ratchet").
 *
 *   npm run boundaries          depcruise --validate, ignoring the known violations, plus the ratchet
 *                               (known list may only shrink) and the fetch check (tools/boundaries.ts)
 *   npm run boundaries:baseline regenerate .dependency-cruiser-known-violations.json (shrinking only)
 *
 * Report-only ratchet: today's violations are listed in .dependency-cruiser-known-violations.json.
 * A new violation fails; a fixed one must be removed from the list in the same PR.
 *
 * TypeScript 7 has no JavaScript compiler API, which dependency-cruiser's TypeScript parser needs
 * (it supports typescript <7), so sources are parsed with swc (@swc/core, dev dependency).
 * Path aliases (web/tsconfig.json: `@server/*` → src/server, `@/*` → web/src) come from tsconfig.depcruise.json.
 * The engine sources use relative imports only, so the same config resolves both packages.
 */

/** Test support: never imported from production code. */
const TEST_SUPPORT = '(^test/|(^|/)testing\\.ts$|(^|/)fixture\\.ts$|\\.test\\.tsx?$)';
/** Production sources of the engine (colocated tests and test-support files excluded). */
const ENGINE_PROD = '^src/';
/** Files allowed to start subprocesses today (§1.3 "strengths"); the target is core/sandbox only. */
const CHILD_PROCESS_ALLOWED = ['^src/core/sandbox/', '^src/ingest/git\\.ts$', '^src/ingest/syft\\.ts$', '^src/history/git\\.ts$', '^src/server/targets\\.ts$'];

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'No import cycles (§1.3 lists today\'s: core ↔ enrich/npm, stability ↔ enrich/pypi). Stage 1 breaks them.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'core-is-a-leaf',
      severity: 'error',
      comment: 'core/** imports nothing outside core (§2.1). Today: core/osv-range → enrich/npm/packument.',
      from: { path: '^src/core/' },
      to: { path: '^src/', pathNot: '^src/core/' },
    },
    {
      name: 'no-child-process-outside-sandbox',
      severity: 'error',
      comment: 'Subprocesses only in core/sandbox (target) or the files that run git/syft today (§2.5, §2.7).',
      from: { path: ENGINE_PROD, pathNot: CHILD_PROCESS_ALLOWED.concat(['\\.test\\.ts$']) },
      to: { path: '^(node:)?child_process$' },
    },
    {
      name: 'no-undici-outside-core-http',
      severity: 'error',
      comment: 'Network I/O only through core/http (§2.5). Global fetch() is checked by tools/boundaries.ts (a grep: depcruise sees imports, not globals).',
      from: { path: ENGINE_PROD, pathNot: ['^src/core/http(\\.ts$|/)', '^src/core/proxy\\.ts$', '\\.test\\.ts$'] },
      to: { path: '(^|/)undici(/|$)' },
    },
    {
      name: 'no-test-support-in-production',
      severity: 'error',
      comment: 'testing.ts, fixture.ts and test/** are never imported from production code (§2.5). Today: server/jobs → history/fixture.',
      from: { path: ENGINE_PROD, pathNot: TEST_SUPPORT },
      to: { path: TEST_SUPPORT },
    },
    {
      name: 'web-imports-only-server-alias',
      severity: 'error',
      comment: 'The web app reaches the engine only through @server/* (src/server), never other engine modules (§2.5, §2.6).',
      from: { path: '^web/src/' },
      to: { path: '^src/', pathNot: '^src/server/' },
    },
    {
      name: 'web-imports-server-types-only',
      severity: 'error',
      comment: 'The web app imports types from @server/*, not runtime values (§2.5). Today\'s shared constants (api-types, permissions) move to the route contract in stage 9.',
      from: { path: '^web/src/', pathNot: '\\.test\\.tsx?$' },
      to: { path: '^src/server/', dependencyTypesNot: ['type-only'] },
    },
    // Cross-layer leaks of today's layout (§1.3). Each stage that moves a module removes its entries.
    {
      name: 'collector-imports-rules',
      severity: 'error',
      comment: 'Collectors (enrich/*) do not import rules: stability/{cadence,rules,priority,repo} move to core/domain or a FactView (§1.3, stages 1 and 5).',
      from: { path: '^src/enrich/' },
      to: { path: '^src/stability/' },
    },
    {
      name: 'collector-imports-history-internals',
      severity: 'error',
      comment: 'Only the history collector reads history/*; others use core/domain (§1.3: enrich/npm/packument → history/bots, aggregate; enrich/pypi → history/continuity).',
      from: { path: '^src/enrich/(?!history/)' },
      to: { path: '^src/history/' },
    },
    {
      name: 'rules-import-collector',
      severity: 'error',
      comment: 'Rules (stability) do not import a collector (§1.3: stability/label → enrich/pypi).',
      from: { path: '^src/stability/' },
      to: { path: '^src/enrich/' },
    },
    {
      name: 'collector-imports-collector',
      severity: 'error',
      comment: 'A collector does not import another collector (§1.3: github → npm, history → npm and depsdev, licenses → npm and depsdev, pypi → depsdev).',
      from: { path: '^src/enrich/([^/]+)/' },
      to: { path: '^src/enrich/', pathNot: '^src/enrich/$1/' },
    },
    {
      name: 'gapfill-imports-collector',
      severity: 'error',
      comment: 'The agentic gap-filler reads facts, not collector internals (§1.3: agentic → depsdev, github/opencollective, npm).',
      from: { path: '^src/agentic/' },
      to: { path: '^src/enrich/' },
    },
    {
      name: 'ingest-internals-outside-ingest',
      severity: 'error',
      comment: 'Ecosystem helpers and the git sandbox live in ingest today (§1.3: enrich/{osv,depsdev,pypi} and watch/match → ingest/python; history/git and server/targets → ingest/git). They move to core/ids and core/sandbox in stage 1.',
      from: { path: '^src/(?!ingest/|pipeline\\.ts$|cli\\.ts$)' },
      to: { path: '^src/ingest/', pathNot: '^src/ingest/index\\.ts$' },
    },
    {
      name: 'scoring-weights-private',
      severity: 'error',
      comment: 'Scoring constants are scorer config, not shared (§1.3: entities/review and incidents import scoring/weights).',
      from: { path: '^src/(?!scoring/)' },
      to: { path: '^src/scoring/weights\\.ts$' },
    },
    {
      name: 'report-reaches-into-modules',
      severity: 'error',
      comment: 'Outputs read the ScanResult, not other modules\' internals (§1.3: report/sarif → scoring, ingest/manifests; report/html, sbom → licenses).',
      from: { path: '^src/report/' },
      to: { path: ['^src/scoring/', '^src/ingest/', '^src/licenses/'] },
    },
    {
      name: 'server-calls-collector-internals',
      severity: 'error',
      comment: 'The server goes through the engine, not collector or scoring internals (§1.3: server → enrich/npm/registry, scoring/blast, watch/*, pipeline).',
      from: { path: '^src/server/' },
      to: { path: ['^src/enrich/', '^src/scoring/blast\\.ts$', '^src/watch/', '^src/pipeline\\.ts$'] },
    },
    // Target layout (§2.1, §2.5): these hold trivially until the folders exist, then they enforce.
    {
      name: 'plugin-imports-core-and-itself-only',
      severity: 'error',
      comment: 'plugins/<kind>/<x>/** may import only core/** and its own folder.',
      from: { path: '^src/plugins/([^/]+)/([^/]+)/' },
      to: { path: '^src/', pathNot: ['^src/core/', '^src/plugins/$1/$2/'] },
    },
    {
      name: 'no-deep-plugin-imports',
      severity: 'error',
      comment: 'Only a plugin\'s index.ts may be imported from outside the plugin.',
      from: { path: '^src/(?!plugins/)' },
      to: { path: '^src/plugins/[^/]+/[^/]+/', pathNot: '^src/plugins/[^/]+/[^/]+/index\\.ts$' },
    },
    {
      name: 'engine-imports-core-and-plugin-index',
      severity: 'error',
      comment: 'engine/** imports core and plugins/index.ts only.',
      from: { path: '^src/engine/' },
      to: { path: '^src/', pathNot: ['^src/core/', '^src/engine/', '^src/plugins/index\\.ts$'] },
    },
    {
      name: 'apps-never-import-plugin-internals',
      severity: 'error',
      comment: 'apps/** import engine and core, never plugin internals.',
      from: { path: '^src/apps/' },
      to: { path: '^src/plugins/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // Production graph only: colocated tests may import anything (test support, fixtures, internals).
    exclude: { path: ['(^|/)(node_modules|dist|dist-check)/', '\\.test\\.tsx?$', '^web/src/test/'] },
    parser: 'swc',
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.depcruise.json' },
    enhancedResolveOptions: {
      extensions: ['.ts', '.tsx', '.d.ts', '.js', '.mjs', '.cjs', '.json'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
    },
    skipAnalysisNotInRules: true,
    reporterOptions: { text: { highlightFocused: true } },
  },
};
