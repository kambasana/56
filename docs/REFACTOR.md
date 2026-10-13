# Running the refactor

How to run the gate for each stage of the staged refactor in [ARCHITECTURE.md](ARCHITECTURE.md) §4. Stage 0 added the tooling described here. It changed no product code.

All commands run in `blastradius/`.

## The gate

A stage's PR merges only when all of these pass. CI runs every one of them (`.github/workflows/blastradius.yml`).

| Check | Command | Fails on |
|---|---|---|
| Types | `npm run typecheck` | any type error (`src`, `test`, `tools`) |
| Tests | `npm test` | any failing test, including the golden check (`test/golden/golden.test.ts`) |
| Golden outputs | `npm run golden:check` | any difference from `test/golden/snapshots/` not declared in `test/golden/DECLARED.md` |
| Boundaries | `npm run boundaries` | a new import-rule violation, a new module cycle, a new `fetch()` caller, or a known one that is fixed but still listed |
| Licences | `npm run license-check` | a dependency whose licence is neither allowed nor listed in `tools/license-exceptions.json` |
| Proof | `npm run proof` | the replayed proof cases |
| Build | `npm run build` | |
| Web | in `web/`: `npm run typecheck`, `npm test`, `npm run build`, `npm run e2e` | |

Run e2e on a free port when another server is running: `BR_E2E_PORT=18890 npm run e2e`.

## Golden outputs

`test/golden/run.ts` replays the recorded real scans offline through the real `scan()`, with the default plugin set and the bundled incident KB:
- parse-server, jitsi-meet and superset from `test/fixtures/tier05`;
- flask from `test/fixtures/tier0/flask` plus `test/fixtures/stability/recorded/tier05-pypi-flask.json.gz`.

It writes all five reports (JSON, SARIF, CycloneDX, SPDX, HTML) and normalises them (`test/golden/normalise.ts`):
- The temporary target path becomes `<target>`.
- `generatedAt`, timestamps, durations, run ids and the SBOM serial and namespace UUIDs are removed or replaced with placeholders.
- Arrays whose order means nothing are sorted: warnings, coverage sources, SBOM components, dependencies and relationships.
- Ranked lists keep the product's order, because their order is part of the answer: findings, health, SARIF results, stability packages.

Snapshots are stored gzipped in `test/golden/snapshots/<case>/<format>.(json|html).gz`.

The coverage is partial (owner decision 2). Sources the recordings lack show as partial or failed coverage, the same way on every run. `test/golden/DECLARED.md` lists what is missing per case.

### When `golden:check` fails

It prints one line per difference, with a path:

```
~ parse-server/json $.findings[purl=pkg:npm/proxy-addr@2.0.7].level: "high" → "critical"
+ parse-server/json $.findings[purl=pkg:npm/node-forge@1.4.0]: {...}
- jitsi-meet/html $.line[412]: "<td>…</td>"
```

Arrays of objects are matched by identity (`purl`, `bom-ref`, `SPDXID`, `source`, `id`, `name`, …), so one inserted finding gives one line. A change in ranking shows as `[*order*]`.

1. **Unintended change:** fix the code. A refactor stage is "no output change" unless it says otherwise.
2. **Intended change:** add one row per change to the table in `test/golden/DECLARED.md` (`<case>/<format> <json path>`, reason, stage). Then run `npm run golden:update` and commit the snapshots together with the change. Globs work: `*/json $.coverage.sources[*].plugin` declares a new field in every case. Remove the rows in the next PR, once the snapshots carry the change.
3. Behaviour changes found while refactoring get their own small PR. Never mix them into a move.

`npm run golden:determinism` runs the harness twice, then on two shuffled input orders: case order, manifest write order and recorded-response order. All four must be identical. `npm test` runs one shuffled order on every run.

## The boundary ratchet

`.dependency-cruiser.cjs` holds the §2.5 rules:
- no cycles;
- `core` imports nothing outside `core`;
- `child_process` only in the files that run git and syft today (target: `core/sandbox`);
- `undici` only in `core/http`;
- no test support (`testing.ts`, `fixture.ts`, `test/**`) in production code;
- the web app imports only `@server/*`, and only types.

It also has one rule per cross-layer leak listed in §1.3, and the target-layout rules for `plugins/`, `engine/` and `apps/`. The target-layout rules start enforcing as soon as those folders exist.

TypeScript 7 has no JavaScript compiler API, which dependency-cruiser's TypeScript parser needs, so sources are parsed with swc. You can ignore dependency-cruiser's `missing-typescript-transpiler` notice. `tsconfig.depcruise.json` gives it the web app's path aliases.

`tools/boundaries.ts` adds what dependency-cruiser cannot check:
- cycles between top-level modules, for example `core → enrich/npm → core` (§1.3 counts cycles at this level; a file-level rule does not see them);
- a check that `fetch()` is only called in `core/http`;
- the shrink-only rule.

**Rules:**
1. Today's violations are known. They are listed in `.dependency-cruiser-known-violations.json` (file-level rules) and `.boundaries-known.json` (module cycles, `fetch()` callers).
2. A new violation fails CI.
3. A fixed violation that is still listed fails CI too. Remove it in the same PR:
   - file-level: `npm run boundaries:baseline`;
   - module cycles and `fetch()` callers: `npm run boundaries:update`.
4. The lists may only shrink. CI compares them with `main`'s lists, and any entry that `main` does not have fails as growth. Never regenerate a list to hide a new violation. Fix the import, or change the rule in a reviewed PR that says why.
5. Each stage removes the entries for the modules it moves. The stage 1 PR, for example, removes `core-is-a-leaf`, the module cycles through `core` and `enrich/pypi`, and the `ingest-internals-outside-ingest` entries for `ingest/python` and `ingest/git`.

## Licences

`npm run license-check` reads both lockfiles, so it needs no install.

- **Allowed:** MIT, ISC, Apache-2.0, BSD-*, BlueOak-*, 0BSD and CC0-1.0. Python-2.0 is allowed for dev dependencies only.
- **Expressions:** `A OR B` needs one allowed side; `A AND B` needs both.
- **Exceptions:** anything else must be listed in `tools/license-exceptions.json`, with a reason, by package and licence. A licence change in a listed package needs a new review.

## Per-module optimisation loop

Run this on each stage's diff, before the gate:

1. `/simplify`: reuse, simplification and efficiency cleanups.
2. `/code-review` at high effort: correctness.
3. `/security-review`: the pending changes on the branch.
4. Fix what they find. A behaviour change goes to its own PR.
5. The gate above: typecheck, tests, golden check, boundaries, licences, proof, build and web.
