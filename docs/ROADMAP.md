# Blastradius roadmap

**Status:** plan, 2026-10-12. No product code in this document. It follows
[WHO-BEHIND-PLAN.md](WHO-BEHIND-PLAN.md) (phases P0–P8, gate results in §10, Tier 0 and Tier 0.5 in
§11), the quality design in [QUALITY-SYSTEM.md](QUALITY-SYSTEM.md), the teardown (four hostile
buyers on real scans, 2026-10-12) and the Pipecat study (2026-10-12).

**What Blastradius is.** We tell you **who is behind each dependency** and how much you can rely on
it:
- who committed to it, who controls it and who can publish it;
- who they are, from public and self-declared information only;
- how stable it is, who funds it, and its licence.

We are **not a code scanner**. Security findings (OSV, GitHub advisories, malware feeds, Scorecard)
come from other tools. We show them with their source and add who is behind the package and how far
it reaches into your estate.

**Wedge and buyer** (from the market study, `MARKET-STUDY.md`, 2026-10-12, §0 and §6; it lives
with the session's research notes and is not in the repository yet):
- **Lead wedge: a "CRA Art. 13(5) due-diligence file for your open-source suppliers."**
  - Article 13(5) makes manufacturers "exercise due diligence when integrating components sourced
    from third parties", and the CRA defines no method for it. Full obligations start on
    11 December 2027 (market study §3.1).
  - For each production dependency the file shows: the controlling entity and publishers, the
    steward (yes or no, and who), whether it is maintained, moved or ended (with evidence), its
    licence with source, and its funding status.
  - It comes with an SBOM whose supplier fields are filled, and an exceptions list.
  - The buyer is an EU-selling manufacturer's OSPO, legal and product-security team.
- **Second wedge: the account pivot for incidents.** "Account X was phished: what can it publish,
  and what of mine does that reach?"
- **P7 jurisdiction stays at organisation level and is a premium tier.** It is sold to legal and
  GRC, gated on design partners. We never profile individuals. That is the defensible difference
  from vendors that score contributors against nation databases (market study §0, §6.2).
- **Distribution:** the CLI, the GitHub Action and the MCP server are free for single repositories
  (market study §6.3).
- The market study also finds that every *piece* exists somewhere (Socket, ecosyste.ms, LFX
  Insights, Tidelift). Nobody joins the pieces per dependency and across an estate, with evidence
  and at org level. So we **reuse the data layer** (§4) and build only the joined, sourced graph,
  the stability labels, the roll-ups and the outputs other tools consume.

**How to read it.**
- Effort is in developer-days (one developer) and is an estimate.
- Each item has a **goal**, **approach**, **reuse**, **effort**, **acceptance on real data** and
  **depends on**.
- Tooling facts carry a URL. **[v]** = checked on 2026-10-12 in this session (file read at the
  named URL or commit, registry metadata, or `git ls-remote`). **[u]** = not verified; the reason
  is given.
- The GitHub REST API answers 403 from this environment, so release dates come from the tag list
  (`git ls-remote`) and the date of the default branch's last commit (shallow fetch).

---

## Contents

1. [Near term](#1-near-term)
2. [Ecosystem coverage](#2-ecosystem-coverage)
3. [Integrations (GitHub Action, Claude Code, the customer's other tools)](#3-integrations)
4. [Reuse open source before building](#4-reuse-open-source-before-building)
5. [Product phases after that](#5-product-phases-after-that)
6. [Owner and external dependencies](#6-owner-and-external-dependencies)
7. [Timeline](#7-timeline)

---

## 1. Near term

### 1.1 Agent pipeline gate gaps

This is step Q1 of [QUALITY-SYSTEM.md §8](QUALITY-SYSTEM.md#8-build-order): the gate is a blocking
check.

**Goal.** The verification gate (`blastradius/src/agentic/verify.ts`, `tasks.ts`) closes the two
gaps found in the live run (WHO-BEHIND-PLAN §10, "Live run (2026-10-12)"):
- **Dates.** The probe `probe-wrong-date` (`test/agentic/live-turns.ts`) proposes the Redis AGPL
  announcement (published May 01, 2025) with the date 2024-05-01 and a real quote. It is kept
  today. `live-replay.test.ts` pins it as `verified`.
- **Backer types.** A fact's `kind` (`corporate_backer`, `fiscal_host`, `foundation`,
  `github_sponsors`, …) is not checked against the page. A real quote can be filed under the wrong
  type.

**Approach.**
- *Date check.* Every value with a date (`lifecycle_events.date`, `incident_writeups.date`, the
  funding amount's `since`) must match a date on the re-fetched page:
  - in the quote itself;
  - or within 300 characters of it;
  - or in the page's own publication date (`<time datetime>`, `article:published_time`, JSON-LD
    `datePublished`).

  We normalise the formats ISO, "May 01, 2025", "1 May 2025" and "Jun 2021". Month precision is
  enough for `since`, and day precision for events. No match means `unverified`. A date the page
  contradicts is rejected.
- *Backer-type check.* Each kind has rules:
  - `corporate_backer` needs the organisation in Open Collective's "Organizations" contributor
    section, or on the subject's own sponsors page. Where an Open Collective slug exists, the
    account type must be `ORGANIZATION`, read from the OC collector we already run.
  - `fiscal_host` needs the phrase "fiscal host" next to the name.
  - `github_sponsors` needs `github.com/sponsors/<subject owner>`.
  - `foundation` stays limited to the foundation's own domain (this exists).
  - A person is never accepted as a backer. Individual backers stay off (WHO-BEHIND-PLAN §5).

**Reuse.** The existing re-fetch and normaliser in `verify.ts`. The OC GraphQL query in
`src/enrich/github/opencollective.ts`. The adversarial fixture format in `live-turns.ts`.

**Effort.** 2 days.

**Acceptance on real data.**
- `probe-wrong-date` is rejected, and its replay expectation flips to `unverified`.
- Two new adversarial cases are rejected: an individual Open Collective backer filed as
  `corporate_backer`, and the fiscal host Open Source Collective filed as `corporate_backer` of
  babel.
- All 29 kept facts of the live run, and the 16 recorded-gate quotes, stay kept.
- Gate latency stays within the current 0.05–1.7 s per request.

**Depends on.** Nothing.

### 1.2 Split PR #2 into reviewable PRs and merge to main

**Goal.** `main` holds only the GitHub tutorial files today. PR #2 (`docs/blast-radius-plan`) holds
the whole product: 915 files changed, 122 commits, 2026-10-02 to 2026-10-12. This item lands that
product on `main` as PRs a person can review, each green on its own.

**Approach.** Split by area, not by history. Each PR is cut from the branch's final state as a
**stacked** branch. It must typecheck and pass tests with only the PRs below it merged. Proposed
stack, in merge order:

| # | PR | Paths (under `blastradius/` unless stated) | Size (files, approx.) |
|---|---|---|---|
| 1 | Repo and CI | `.github/workflows/blastradius.yml`, `.gitignore`, `.claude/skills/deploy-exe-dev`, root `package` files, `tsconfig*`, `vitest.config.ts` | 10 |
| 2 | Plan documents | `docs/*.md` (no code) | 14 |
| 3 | Engine core | `src/core`, `src/ingest`, `src/scoring`, `src/report`, `src/cli.ts`, `src/pipeline.ts`, `src/summary.ts`, `src/incidents`, `kb/`, `src/watch`, with `test/e2e`, `test/backtest` and their fixtures | 150 |
| 4 | Enrichment | `src/enrich` (OSV, deps.dev, npm, GitHub, OC), `src/pack`, with recorded fixtures | 110 |
| 5 | Replay and proofs | `test/replay`, `test/hammer`, `docs/ACCOUNT-PROOF.md` data | 90 |
| 6 | Server and store | `src/server` (routes, store, migrations), `src/accounts`, `src/entities` | 100 |
| 7 | Web app | `web/` (pages, components, e2e) | 230 |
| 8 | Licences (P1) | `src/licenses`, `test/licenses`, fixtures | 40 |
| 9 | History and stability (P2, P3) | `src/history`, `src/stability`, `test/history`, `test/stability`, fixtures | 60 |
| 10 | Agentic gap-filler | `src/agentic`, `src/enrich/agentic`, `test/agentic`, fixtures, migration 12 | 45 |
| 11 | Tier 0 and Tier 0.5 | `test/tier0`, `test/tier05`, `test/entities`, migration 13, and the cross-cutting edits that cannot sit in 3–10 | 60 |

- Where a later area's change touches an earlier file (Tier 0 edited scoring, scope and reports),
  the earlier PR carries the **final** version. Its tests then come with it. PR 11 keeps only what
  cannot move down.
- The `review/*` branches (`review/base`, `review/part1`, `review/part2`, `review/web-*`) already
  slice the code for CodeRabbit's file limit. Reuse their cut lines, but these PRs must build,
  which the review slices do not.
- Large recorded fixtures (`*.json.gz`) are listed per PR with their recorder, so a reviewer can
  skip their bytes.
- Every PR is squash-merged with the plan section it implements in its description.
- Housekeeping comes first, in PR 1 (see §6): delete the tutorial workflows `0-start.yml` …
  `5-merge-your-pull-request.yml`, and the `new`, `new.txt` and `run.txt` files, if the owner
  agrees.

**Reuse.** The existing CI workflow (offline tests, about 7 minutes per run on 6e71412). The
`review/*` cut lines.

**Effort.** 3–4 days to cut, make each green and write the descriptions. Review time is on the
owner.

**Acceptance on real data.**
- After the last merge, `main`'s tree equals `docs/blast-radius-plan` at the split commit
  (`git diff` is empty).
- Every PR's CI run is green.
- The test counts on main equal the branch: blastradius 996, web 321 unit and 69 e2e at 6e71412.

**Depends on.** The owner agreeing to the split and the housekeeping deletions. A freeze of new
work on PR #2 while it is cut, or a rebase plan.

### 1.3 Learning loop v1

**The design is [QUALITY-SYSTEM.md](QUALITY-SYSTEM.md)** (§5 the loop, §7 where the checks run, §8
the build order). This roadmap schedules its steps and does not repeat them. The items the owner
asked for map to its steps like this:

| Owner item | Quality-system step | Where it is designed |
|---|---|---|
| User feedback on every label and finding | **Q2** feedback capture | §5.1 |
| Golden set as a CI quality gate that blocks a rule change when false positives or misses get worse | **Q2** evaluation harness, CI gate on regression | §5.4, §7 |
| Monthly time-travel backtests on new real compromise, takeover and deprecation events, with the replay tooling | **Q2** event log, then the monthly run | §5.2, §5.3, §7 |
| Per-rule noise view | **Q3** quality dashboards | §3.1, §6 |
| Shared corrections knowledge base (opt-in) | **Q3** corrections KB with reviewer flow | §5.5 |
| Later, a calibrated ranker (gradient-boosted trees) on top of the rules | **Later** ranker in shadow mode | §5.5, §8 |

- **Q1** (run ids, lineage, invariants, drift guard, nightly canaries, metrics store) comes first.
  It includes §1.1 above.
- **Effort**, from QUALITY-SYSTEM §8: Q1 1.5–2 weeks, Q2 2–3 weeks, Q3 2 weeks, Q4 1.5 weeks,
  ranker 1–2 weeks then measure.
- **Ranker caution.** Our own LightGBM model was built properly and still lost to the rules on both
  gate measures (DATA-ML.md, FEEDS-AND-DETECTORS.md). The ranker only reorders within a level. It
  ships only if it beats the rules on the harness, and only once several hundred labelled outcomes
  exist (QUALITY-SYSTEM §8).
- **Acceptance on real data** follows QUALITY-SYSTEM §3 and §5.4: the golden set is the Tier 0 and
  Tier 0.5 rows, the §8 subjects and the teardown cases, all recorded real data.
- **Depends on.** §1.2 (CI on main). Design partners for real verdicts (§6). The event log needs
  network in a scheduled job.

---

## 2. Ecosystem coverage

### 2.1 Scope

What is read today (`blastradius/src/ingest/`, README "What is read"):
- npm `package-lock.json` and `npm-shrinkwrap.json`;
- Python `requirements*.txt`, `uv.lock`, `poetry.lock`, `Pipfile.lock` and `pyproject.toml`;
- GitHub Actions workflows and Dockerfiles;
- optionally, a Syft CycloneDX import (`src/ingest/syft.ts`). It maps every ecosystem except npm,
  Actions and Docker to `generic`.

Everything else is listed as **NOT ANALYSED** (`src/ingest/manifests.ts`), with a package count.

| Target | Files | Why |
|---|---|---|
| **"TypeScript"**: the JS lockfiles we don't parse yet | `yarn.lock` v1, `yarn.lock` berry (`__metadata`), `pnpm-lock.yaml` (v6, v9), `bun.lock` (text, JSONC) | Most TypeScript repos use them. jitsi-meet and superset already show them as NOT ANALYSED |
| **Go** | `go.mod`, `go.sum`; Go binaries (build info) | Services and CLIs; `go.mod` NOT ANALYSED today |
| **Ruby** | `Gemfile.lock` (plus `Gemfile` for groups) | Rails apps; jitsi-meet's `Gemfile.lock` (~133 packages) is NOT ANALYSED today |
| **Nearly free with the same tool** | Maven `pom.xml`, `gradle.lockfile`; Cargo `Cargo.lock`; Composer `composer.lock`; NuGet `packages.lock.json`; CocoaPods `Podfile.lock` | The extractors below read these with the same run. The work is mapping, scope and enrichment |

### 2.2 Candidate tools, evaluated

| Tool | Licence | Maintenance (2026-10-12) | Language, form | Output | Dev/prod scope | Dependency graph | Offline |
|---|---|---|---|---|---|---|---|
| **OSV-SCALIBR** lockfile extractors | Apache-2.0 [v [LICENSE](https://github.com/google/osv-scalibr/blob/main/LICENSE)] | tag v0.5.3, last commit 2026-10-11 [v] | Go library and CLI | its own inventory proto; SPDX/CycloneDX via osv-scanner [u: not run] | `DepGroupVals` "dev" for npm lock and pnpm `dev:` only; bun sets none; yarn and Gemfile.lock none [v source: [pnpmlock.go](https://github.com/google/osv-scalibr/blob/main/extractor/filesystem/language/javascript/pnpmlock/pnpmlock.go), [bunlock.go](https://github.com/google/osv-scalibr/blob/main/extractor/filesystem/language/javascript/bunlock/bunlock.go)] | **none** for lockfiles (flat inventory) [v: no edges in those extractors] | yes; the deps.dev licence and the transitive pom/requirements enrichers go online and two are marked "unsafe" [v [supported_inventory_types.md](https://github.com/google/osv-scalibr/blob/main/docs/supported_inventory_types.md)] |
| **osv-scanner** | Apache-2.0 [v [LICENSE](https://github.com/google/osv-scanner/blob/main/LICENSE)] | tag v2.7.0, last commit 2026-10-13 [v] | Go CLI on top of SCALIBR | JSON, SARIF, CycloneDX, SPDX [u: format list from memory] | as SCALIBR | as SCALIBR | lockfile parsing yes; vuln matching needs OSV or a local DB |
| **Syft** (we already import its output) | Apache-2.0 [v [LICENSE](https://github.com/anchore/syft/blob/main/LICENSE)] | tag v1.54.1, last commit 2026-10-12 [v] | Go CLI | CycloneDX, SPDX, Syft JSON, with relationships | dev dependencies **dropped by default** (`IncludeDevDependencies: false`), not labelled when included [v [javascript/config.go](https://github.com/anchore/syft/blob/main/syft/pkg/cataloger/javascript/config.go), [parse_pnpm_lock.go](https://github.com/anchore/syft/blob/main/syft/pkg/cataloger/javascript/parse_pnpm_lock.go)]; bun separates dev-only packages [v parse_bun_lock.go] | **yes** for package-lock, yarn, pnpm and bun (`dependency.Resolve`) [v]; **none** for Gemfile.lock [v [parse_gemfile_lock.go](https://github.com/anchore/syft/blob/main/syft/pkg/cataloger/ruby/parse_gemfile_lock.go) returns `nil` relationships]; Go only with the Go toolchain and module download [v [parse_go_mod.go](https://github.com/anchore/syft/blob/main/syft/pkg/cataloger/golang/parse_go_mod.go)] | yes, except Go licences and graph (GOPROXY) and remote npm licences (off by default) |
| **cdxgen** | Apache-2.0 [v [LICENSE](https://github.com/CycloneDX/cdxgen/blob/master/LICENSE)] | `@cdxgen/cdxgen` 13.3.0, 2026-10-02 (renamed from `@cyclonedx/cdxgen`, last 12.8.5) [v npm registry]; last commit 2026-10-12 [v] | Node CLI, 25 deps + 21 optional [v npm] | CycloneDX (SPDX by conversion) | CycloneDX `scope`; `cdx-audit --scope all\|required` [v [README](https://github.com/CycloneDX/cdxgen/blob/master/README.md)] | yes for Node, Go, Ruby (`Gemfile.lock`) [v [PROJECT_TYPES.md](https://github.com/CycloneDX/cdxgen/blob/master/docs/PROJECT_TYPES.md)] | **runs build tools by default**; `--dry-run` blocks child processes and network, and secure mode "does not provide security guarantees in the presence of malicious code" [v [PERMISSIONS.md](https://github.com/CycloneDX/cdxgen/blob/master/docs/PERMISSIONS.md)] |
| **Trivy** | Apache-2.0 [v [LICENSE](https://github.com/aquasecurity/trivy/blob/main/LICENSE)] | tag v0.75.0, last commit 2026-10-12 [v] | Go CLI | JSON, CycloneDX, SPDX, SARIF | dev **excluded** for npm, yarn, pnpm v9, bun; **included** for Bundler [v [nodejs.md](https://github.com/aquasecurity/trivy/blob/main/docs/guide/coverage/language/nodejs.md), [ruby.md](https://github.com/aquasecurity/trivy/blob/main/docs/guide/coverage/language/ruby.md)] | yes for all four JS lockfiles, Bundler and go.mod; the Go graph needs modules in the local cache [v [golang.md](https://github.com/aquasecurity/trivy/blob/main/docs/guide/coverage/language/golang.md)] | yes, with a downloaded DB. **Supply-chain caution:** v0.69.4 and the `trivy-action` tags were compromised on 2026-03-19 (CVE-2026-33634) [v search result: [Snyk](https://snyk.io/articles/trivy-github-actions-supply-chain-compromise/)] |
| **deps.dev** requirements and dependencies APIs | API under Google API ToS, data CC-BY 4.0, client code Apache-2.0 (WHO-BEHIND-PLAN L1 [v P0]; [repo](https://github.com/google/deps.dev)) | live | HTTP API | JSON | n/a (per package version, not per project) | `GetDependencies` "currently available for npm, Cargo, Maven and PyPI" [v [api.proto](https://github.com/google/deps.dev/blob/main/api/v3/api.proto)]; `:requirements` answers for Go (direct and indirect) and RubyGems (runtime) [v live: cobra v1.8.0, rails 7.1.0]; Go `:dependencies` answers "dependencies not found" [v] | no |
| `@yarnpkg/parsers` | BSD-2-Clause [v npm, [berry LICENSE.md](https://github.com/yarnpkg/berry/blob/master/LICENSE.md)] | 3.1.0, 2026-07-29 [v npm]; berry last commit 2026-09-24 [v] | TS library, 2 deps | JS objects (`parseSyml` reads v1 and berry) [u: v1 support through `parseSyml` from memory] | from the workspace `package.json` roots (our code) | from the entries' `dependencies` (our code) | yes |
| `@yarnpkg/lockfile` | BSD-2-Clause [v npm] | 1.1.0, **2018-09-10** [v npm]: unmaintained | JS | v1 only | — | — | yes |
| `@pnpm/lockfile.fs` (was `@pnpm/lockfile-file`, last 9.1.3 on 2024-07-21) | MIT [v npm, [pnpm LICENSE](https://github.com/pnpm/pnpm/blob/main/LICENSE)] | 1100.2.13, 2026-10-06 [v npm]; 21 deps | TS library | typed lockfile | `importers.*.devDependencies` | `snapshots` (v9) | yes |
| **Bundler** `Bundler::LockfileParser` | MIT or Ruby licence [v [rubygems LICENSE.txt](https://github.com/rubygems/rubygems/blob/master/LICENSE.txt)] | Bundler 4.0.x [v local 4.0.17; discourse locks 4.0.11, mastodon 4.0.22] | Ruby | specs with their dependencies | no: groups live only in `Gemfile` (Ruby code) | yes: mastodon 346 specs, 585 edges, 155 direct [v, run here]. Discourse's `PATH` gems need the Gemfile directory [v: error here] | yes |
| `go mod graph`, `go list -m -json all` | BSD-3-Clause (Go) | Go toolchain | CLI | text, JSON | no dev scope in Go; test-only deps only through `go list -deps -test` with source | yes | **needs the matching toolchain and module download** (prometheus needs go ≥ 1.26.7; local go 1.24.7 refused with `GOTOOLCHAIN=local`) [v] |
| `go version -m <binary>` | BSD-3-Clause | Go toolchain | CLI | text | n/a | modules only, no edges | yes: `gh` 2.89.0 lists 168 `dep` lines [v] |

### 2.3 Recommendation

**One approach: a pinned Syft for discovery, plus our own thin adapters where scope or graph is
missing.**

- **Why Syft.**
  - We already import its CycloneDX (`--syft`).
  - It is Apache-2.0 and active.
  - It reads every target file statically, and gives relationships for all four JS lockfiles.
  - It reads Go binaries and the "nearly free" ecosystems in the same run.
- **Why not the others as primary.**
  - SCALIBR has no lockfile graph. We need the graph for reach, "brought in by" and scope.
  - cdxgen runs build tools unless kept in dry-run.
  - Trivy's own release channel was compromised in 2026.
  - deps.dev resolves a published package, not the customer's lockfile.
- **Why some adapters stay ours.** Syft drops dev dependencies or does not label them. Our scope
  model (`src/core/scope.ts`: runtime, peer, optional, ci, dev, unreachable) needs the roots and
  their dependency types. Those come from the lockfile's own importer and root sections.

**Packaging Syft.**
- An exact release, checksum-verified on download (`syft_<v>_checksums.txt` and its signature)
  [u: signing method not checked].
- Run as `syft scan dir:<target> -o cyclonedx-json --select-catalogers …`, with the network off:
  - Go licence and proxy lookups off;
  - `include-dev-dependencies: true`, so we see everything and label scope ourselves.
- It becomes a default-on ingest step when the binary is present. The container image (§3.4)
  includes it.

**Per ecosystem: where components, scope and graph come from.**

| Ecosystem | Components | Dev/prod scope | Graph | Adapter we write |
|---|---|---|---|---|
| yarn v1 and berry | Syft, cross-checked by our parser | importer roots: each workspace `package.json` `dependencies` / `devDependencies` / `optionalDependencies` / `peerDependencies`, then a closure over the graph (as `src/ingest/npm.ts` does for npm) | yarn entries' `dependencies` (Syft relationships agree) | `src/ingest/yarn.ts` on `@yarnpkg/parsers` (BSD-2) |
| pnpm v6/v9 | same | `importers.<path>.{dependencies,devDependencies,optionalDependencies}` | `snapshots` (v9) or `packages` (v6) | `src/ingest/pnpm.ts` on the `yaml` package we already ship. The format is documented; `@pnpm/lockfile.fs` (21 deps) is the test oracle only |
| bun | same | `workspaces.*.devDependencies` | `packages` tuples | `src/ingest/bun.ts` (JSONC). `bun.lockb` (binary) stays NOT ANALYSED |
| Go modules | `go.mod` (complete module list since Go 1.17 graph pruning: [go.dev/ref/mod](https://go.dev/ref/mod) [u: section not re-read]), hashes from `go.sum` | all `runtime`; `// indirect` kept as a fact. Test-only modules cannot be told without source and toolchain: said in the coverage line | deps.dev `:requirements` per module version (no toolchain, no clone, cached), **or** `go mod graph` in a network sandbox when a customer opts in | `src/ingest/gomod.ts` (thin; the format is line-based) |
| Go binaries | Syft (build info), or `go version -m` | `runtime` | none (modules only) | none: Syft |
| Ruby (Bundler) | `Gemfile.lock` specs, with `CHECKSUMS` (Bundler ≥ 2.5) as hashes | `Gemfile` `group :development, :test do` blocks read **statically** (never evaluated); gems only in dev/test groups are `dev`; anything unclear is `runtime` with a warning | `Gemfile.lock` spec dependencies (Syft has none) | `src/ingest/gemfile.ts` (the format is documented and line-based) |
| Maven, Gradle lockfile, Cargo, Composer, NuGet, CocoaPods | Syft | Composer `packages-dev`, Cargo `[dev-dependencies]` roots, Gradle lockfile configurations, Maven `<scope>`; else `runtime` with "scope unknown" | Syft relationships where present; else flat, said in the coverage line | mapping only (purl types in `src/core/types.ts`) |

- **Not chosen:** running package managers (`yarn install`, `bundle install`, `pnpm install`).
  Nothing from the target is executed (ingest README).

### 2.4 Enrichment per ecosystem

| Source | npm | PyPI | Go | RubyGems | Maven, Cargo, Composer, NuGet |
|---|---|---|---|---|---|
| OSV (advisories, malware) | yes | yes | yes ([osv-schema ecosystems](https://ossf.github.io/osv-schema/)); live answer for `golang.org/x/net` 0.10.0 [v] | yes; live answer for nokogiri 1.13.0 [v] | yes [u: per ecosystem not queried] |
| deps.dev (licence, repo, Scorecard, dependents, deprecation) | yes | yes | version, licence, `SOURCE_REPO` for cobra v1.8.0 [v live] | version, licence, advisories for nokogiri 1.16.0 [v live] | yes [u] |
| ecosyste.ms (maintainers, owner record, funding links; the main source per §4) | yes | yes | yes [u: per ecosystem not queried] | yes [u] | yes [u] |
| **Who can publish** (stability S1, account pivot) | packument `maintainers`, `_npmUser` | (not today) | **none**: Go has no registry accounts; we use the repository owner and git history only | owners API `/api/v1/gems/<name>/owners.json` gives handles and roles [v live]; versions API gives dates, licences, `sha` [v live]; per-version publisher [u: not in the v1 fields seen] | crates.io owners, Packagist maintainers, NuGet owners [u] |
| Releases and cadence (S4) | packument `time` | | `proxy.golang.org/<module>/@v/list` [v] and `.info` (time) [u]; `retract` and `// Deprecated:` in `go.mod` [u] | versions API `created_at` [v] | deps.dev versions [u] |
| Git history (S2, C1–C3) | yes | yes | yes (the module path is the repository) | yes (`source_code_uri` metadata) [u] | yes, via deps.dev repo |
| Funding (P4) | `funding` field, FUNDING.yml | FUNDING.yml | FUNDING.yml | `funding_uri` metadata [u] | FUNDING.yml |

Stability rules stay registry-neutral where the inputs exist. Where an ecosystem has no publisher
accounts (Go), S1 and S5a say "not available for Go modules". They are never read as "fine".

### 2.5 Acceptance on real data

Each repository was checked on 2026-10-12 with a shallow, blob-less fetch of `HEAD` and only the
named files read (`git cat-file`). Nothing was kept on disk afterwards.

| Case | Repository @ pinned commit (date) | File checked [v] | Size, count [v] | Expected after this work |
|---|---|---|---|---|
| pnpm monorepo | `vitejs/vite` @ `dce9fe69d37e957b62f3b5df61a761f7f2f949f5` (2026-10-12) | `pnpm-lock.yaml`, `lockfileVersion: '9.0'` | 498 KB; 1,393 `packages` entries, 87 importers | 0 NOT ANALYSED for the lockfile; component count = `@pnpm/lockfile.fs` reading of the same file; prod/dev per importer equals the oracle's `filterLockfileByImporters` (prod-only) closure; 20 random packages hand-checked for "brought in by" |
| yarn berry | `babel/babel` @ `0915316cf4a66e85af77ff9043d2f9c8a439418b` (2026-10-12) | `yarn.lock` with `__metadata: version 10`, `.yarnrc.yml` | 684 KB; 1,737 entries | as above, oracle `@yarnpkg/parsers` plus Syft relationships; `workspace:` and `patch:` protocols resolved to the real package |
| yarn v1 | `facebook/react` @ `9f2e1f888e5675e0feb12b4e58ecfae36b14cd4d` (2026-10-12) | `yarn.lock`, "yarn lockfile v1" | 812 KB; 2,388 entry lines | as above |
| bun | `elysiajs/elysia` @ `e037eca710e7ad193be09cc6615ab0dbe54af914` (2026-08-26) | `bun.lock` | 66 KB | as above, oracle Syft (separates dev-only) |
| Go service | `prometheus/prometheus` @ `2377dc1460206961d819ee3e2f6032b98a9e148c` (2026-10-12) | `go.mod` (go 1.26.7), `go.sum` | 249 required modules, 140 `// indirect` | 249 Go components, `pkg:golang/…`, with go.sum hashes; graph from deps.dev; the oracle `go list -m all` in a network sandbox with go 1.26.7 gives the same module set; OSV advisories match osv-scanner on the same commit |
| Go binary | `gh` 2.89.0 binary (`/usr/local/bin/gh`, built with go1.26.1) | build info | 168 `dep` lines (`go version -m`) | 168 components, scope runtime, no graph (said) |
| Rails app (also yarn berry) | `mastodon/mastodon` @ `cbe4329f1cd4c82991216c77f078a4e69ee43b47` (2026-10-12) | `Gemfile.lock` (Bundler 4.0.22), `yarn.lock` (`__metadata: version 10`) | 346 specs, 585 edges, 155 direct (Bundler's own parser) [v] | 346 gems and the same 585 edges; test and development groups as `dev`; npm side as for babel |
| Rails app with path gems | `discourse/discourse` @ `2f32ab2dbef42a31d359596f709cdf6fb8983a75` (2026-10-12) | `Gemfile.lock` (Bundler 4.0.11, `CHECKSUMS`), `Gemfile` (6 `group` blocks) | 344 specs | `PATH` gems are local projects, not registry components; `CHECKSUMS` become hashes in the SBOM |

- Across all eight, `--strict` exits 0 for these files. jitsi-meet @ `36d4c1c7` drops its
  `Gemfile.lock` (~133) from NOT ANALYSED. CocoaPods (~215) moves to "read, flat graph" through
  Syft.
- Fixtures: trimmed slices of each lockfile plus recorded OSV and deps.dev answers, with the
  recorders in `test/ecosystems/`. This is the Tier 0 pattern, kept small: disk here is under
  2 GB.

### 2.6 Effort and dependencies

| Step | Days |
|---|---|
| Syft pinning, checksum check, default-on discovery, purl ecosystems beyond `generic` | 3 |
| yarn (v1 and berry), pnpm, bun adapters with scope and graph | 6 |
| Go (`go.mod`, `go.sum`, deps.dev graph, binaries via Syft) | 3 |
| Ruby (`Gemfile.lock` graph, static `Gemfile` groups, `CHECKSUMS`) | 3 |
| Enrichment: OSV and deps.dev ecosystems, RubyGems owners and versions, Go proxy releases, coverage wording | 4 |
| Acceptance runs, fixtures, docs | 3 |
| **Total** | **≈ 22** |

**Depends on.** §1.2 (main is green). Network for the recorders. The owner accepts a Go binary
(Syft) in the CLI container image.

---

## 3. Integrations

Blastradius is useful where people already work: their pull requests, their AI assistant, their
tickets and their GRC tool. Integrations come before new screens.

### 3.1 GitHub Action

**Goal.** Run Blastradius in the customer's CI. The main value is not code-scanning upload. It is
three things.

1. **The customer's own `GITHUB_TOKEN` unlocks GitHub data we cannot get from here.** The GitHub API
   answers 403 in our environment, as it did in the teardown and in Tier 0. With the customer's
   token we get:
   - owner types (closes the `owner:` "type unknown" gap of §11);
   - commit → login mapping and `verification` (identity merge, C2 signed commits);
   - the Sponsors listing (F1) and org `location` (C4).

   `GITHUB_TOKEN` has 1,000 REST requests per hour per repository [v
   [rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)].
   The existing budget (≤ 2,000 GraphQL points per scan) and the priority order
   (`src/stability/priority.ts`) keep a scan inside it.
2. **A pull-request comment when dependencies change.** For each new or changed package it shows:
   - who is behind it: maintainers and publishers, the repository owner and its type, machine-derived
     or reviewed;
   - any maintainer or publisher change since the base version;
   - its stability label with the reason;
   - its licence, and any licence change across the bump;
   - its declared funding.

   Security advisories appear as one line per package with their source (OSV or GHSA), not as our
   findings.
3. **Optional policy gates.** These are exit codes, off by default:
   - `--strict` (exists, exit 3, NOT ANALYSED);
   - licence `deny` (from §5, licence policy gate);
   - "adds a Fragile production dependency";
   - "a changed package has a new publisher with no history in the repository" (S5a).

**Approach.**
- **Diff.**
  - Use GitHub's dependency-review compare API (`GET /repos/{owner}/{repo}/dependency-graph/compare/{basehead}`
    [v [docs](https://docs.github.com/en/rest/dependency-graph/dependency-review)]) when the
    dependency graph is on.
  - Else diff our own inventories of base and head. The base lockfiles are read with `git show`,
    with no second checkout.
- **Comment.**
  - One sticky comment, updated in place, with collapsed sections per package.
  - The same text goes to the job summary.
  - Wording follows the judgement-word lint and the disclaimer "Public links with sources. Not a
    finding of wrongdoing."
- **Upload.**
  - Optional: to a Blastradius server, with `BLASTRADIUS_URL` and an org **ingest-only** token
    (secret, masked, scope "write scan").
  - Otherwise the JSON, CycloneDX and SPDX outputs are kept as a workflow artifact.
- **Minor options.**
  - SARIF upload to code scanning (needs `security-events: write`; posture results stay out, as
    Tier 0 decided).
  - Dependency Submission API snapshot, for ecosystems GitHub does not parse (needs
    `contents: write` [v [docs](https://docs.github.com/en/rest/dependency-graph/dependency-submission)]).
- **Safety.**
  - Ship as a Docker action pinned by **digest**, and document pinning **our** action by commit
    SHA. Mutable tags are how `trivy-action` users were hit in 2026 [v search:
    [Snyk](https://snyk.io/articles/trivy-github-actions-supply-chain-compromise/)].
  - Default permissions `contents: read`. The comment job alone gets `pull-requests: write`.
  - `actions/checkout` with `persist-credentials: false`.
  - The token is sent only to `api.github.com` (existing rule). `::add-mask::` for the ingest
    token. Logs never print headers.
- **Forks.**
  - Run on `pull_request`, never on `pull_request_target` with a checkout of the PR head.
  - Fork PRs get a read-only token and no secrets. The scan still runs: public GitHub data is
    readable. The comment is written to an artifact, and a separate `workflow_run` workflow, which
    never checks out PR code, posts it. This is GitHub Security Lab's pattern [v
    [preventing pwn requests](https://securitylab.github.com/resources/github-actions-preventing-pwn-requests/)].
  - `pull_request_target` plus untrusted code was the root cause of the Trivy compromise [v search,
    Snyk above].
- **Recommend alongside.** `actions/dependency-review-action` for vulnerability gating: it is the
  security tool, we are the who-is-behind tool.

**Reuse (cite and pin by SHA when built; tags as of 2026-10-12 [v `git ls-remote`]).**

| Action | Licence | Tag → commit | Use |
|---|---|---|---|
| [actions/dependency-review-action](https://github.com/actions/dependency-review-action) | MIT [v] | v5.0.0 → `a1d282b36b6f3519aa1f3fc636f609c47dddb294` | pattern for inputs (`allow-licenses`, `deny-licenses`, `comment-summary-in-pr`, `fail-on-scopes`, `show-openssf-scorecard` [v action.yml]); recommended alongside |
| [github/codeql-action](https://github.com/github/codeql-action) `upload-sarif` | MIT [v] | v4.38.3 → `24c54180a607b1449ed407dd24f251e4e9147c8d` | optional SARIF upload |
| [advanced-security/component-detection-dependency-submission-action](https://github.com/advanced-security/component-detection-dependency-submission-action) | MIT [v] | v0.2.0 → `a02aeda7a175ad4dd38a13c4d3ff2df9da8f2cf0` | pattern for the Dependency Submission snapshot |
| [anchore/sbom-action](https://github.com/anchore/sbom-action) | Apache-2.0 [v] | v0.24.3 → `66cbf4bc1f1c0d2edc94016e65bc221b6bb0ad6c` | pattern for Syft in Actions; we ship Syft inside our image instead |

**Effort.** 8 days: action and image 2, PR diff and comment 3, fork-safe `workflow_run` path 1,
gates 1, docs and tests 1.

**Acceptance on real data.**
- In a test repository (owner's account), a PR that bumps a real package across a known publisher
  change gets a comment naming the publisher change. Candidates: event-stream 3.3.5 → 3.3.6 in a
  throwaway lockfile, or color-convert 3.1.0 → 3.1.1 (INC-2025-0002).
- With the customer token: owner types resolve, so 0 `owner:` "type unknown" rows for
  parse-server's direct dependencies. Commit login mapping runs.
- A fork PR gets the comment through `workflow_run`, and no secret is readable in the fork job
  (test with a canary secret).
- Run time ≤ 5 minutes on parse-server with a warm cache artifact.

**Depends on.** §1.2. The owner creates a test repo and a GitHub token for development (§6). The
licence gate needs §5's licence policy step.

### 3.2 Claude Code integration (MCP server and skill)

**Goal.** In Claude Code (or any MCP client) a developer can ask "who is behind X, what else do
they maintain, is it stable, who funds it, are we exposed", and get answers from **their**
Blastradius data, with sources. The best moment is **before an agent adds a dependency**.

**Why it matters.** The channel is contested for *security scores*. Socket ships an MCP server
listed as a Claude connector, and Sonatype advertises an "API & MCP Server". It is **not**
contested for "who controls this, and will it last" (market study §1.4). The free single-repo MCP
server is also a cheap distribution channel (market study §6.3).

**Approach.**
- **An MCP server** in TypeScript, in the engine package (`blastradius mcp`):
  - Uses `@modelcontextprotocol/sdk` (MIT, 1.32.1 [v npm]; the repository notes a move from MIT to
    Apache-2.0 [v [LICENSE](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/LICENSE)]).
  - Transports: **stdio** for a local CLI database or `--fixtures`, and **streamable HTTP** against
    a Blastradius server with a per-user read-only token.
  - The token design is the Pipecat plan's: hashed, 30-minute TTL, GET only, allow-list, audited
    "assistant on behalf of <user>".
- **Tools are the same read-only allow-list as the Pipecat assistant** (one manifest,
  `src/assistant/tools.ts`, so the two cannot drift): `list_projects`, `search_exposure`,
  `package_reach`, `package_behind`, `account`, `account_exposure`, `project_stability`,
  `project_coverage`, `findings`, `incidents`, `licenses`, `changes`.
- **Guardrails reused.**
  - Person-level handles go to the model only for `manage_projects`; they are stripped for other
    roles (owner decision, Pipecat study).
  - Questions are screened by `agentic/privacy.ts` `asksForInference` before any tool call.
  - `project_coverage` is always returned with exposure answers (no false all-clear).
- **A Claude Code skill and plugin** (`blastradius` skill: when to call which tool, wording rules,
  "not in your data" instead of guessing). It is packaged as a plugin that registers the MCP
  server [v docs resolve: [MCP](https://code.claude.com/docs/en/mcp),
  [skills](https://code.claude.com/docs/en/skills),
  [plugins](https://code.claude.com/docs/en/plugins)].

**Reuse.** The Pipecat plan's tool manifest, token and screen (WHO-BEHIND-PLAN §5, Pipecat study
§6.2–6.6). The existing API routes. The MCP SDK.

**Effort.** 5 days: server and tools 2, token path 1 (shared with Pipecat), skill and plugin 1,
tests 1.

**Acceptance on real data.** The Pipecat golden questions, on the recorded parse-server,
jitsi-meet, flask and superset data, through Claude Code:
- "Are we exposed to proxy-addr?" → 2.0.7, GHSA-jqcg-44mw-7w3h, fix 2.0.8, via express.
- "Who is behind debug?" → qix, tootallnate, owner debug-js, machine-derived.
- "What else does qix publish that we use?" → 7 in production, INC-2025-0002.

Also:
- The refusal phrasings are refused with no tool call.
- A non-`manage_projects` token gets no handles.
- A live run needs a key [u until §6].

**Depends on.** §1.2. It shares the token path with the Ask Blastradius step (§5), so build
whichever comes first once.

### 3.3 The customer's other tools

**Goal.** Our answers flow into the tools customers already use. We do not ask them to switch.

| Target | How | Exists? | New work |
|---|---|---|---|
| Code scanners and SBOM managers (Snyk, Socket, GitHub, Dependency-Track) | CycloneDX 1.6 and SPDX 2.3 with **supplier and steward fields filled**, plus our annotations as properties (`blastradius:scope`, stability, publisher, licence decision). Filling `supplier` in someone else's SBOM is a concrete gap: GitHub's SBOM export has left it NOASSERTION (market study §1.4 [u there]). SARIF only as an optional export, carrying org-level and stability facts only | yes (exports); annotations partly; supplier missing on 1,570 of 1,570 in the teardown | CRA profile (§5, step 5.2): supplier, hashes, relationships to BSI TR-03183-2 fields; an "enrich my SBOM" mode that fills supplier and steward in a customer's existing CycloneDX |
| GRC (Vanta, Drata, ServiceNow IRM, OneTrust) | **evidence objects for CRA Art. 13(5) due diligence**: one per production dependency (controlling entity, publishers, steward, maintenance state with evidence, licence with source, funding, reviewer and date), plus an estate summary and the exceptions list. Socket already integrates with Vanta for security issues (market study §1.4); ours is the supplier file | JSON report yes | the due-diligence pack export (JSON schema, CSV, PDF one-pager), pushed through each GRC tool's evidence API [u: per-vendor APIs not checked] |
| Ticketing (Jira, Linear, GitHub Issues) | outbound **webhooks** for events (label worse, new publisher, licence change, known-bad version) with a signed JSON body; a ticket per decision row, not per package | Slack-compatible webhook and alert rules exist (`src/server/watch.ts`, `store/alert-rules.ts`) | generic signed webhook (HMAC), event schema, Jira and GitHub Issues recipes |
| Chat (Slack, Teams) | the existing webhook | yes | Teams card format |
| GitLab CI | job template on the same container image; MR note with a project access token; `artifacts:reports:cyclonedx` for the SBOM (GitLab Ultimate) [v [GitLab docs](https://docs.gitlab.com/ci/yaml/artifacts_reports/)] | no | template and MR-note poster [u: whether `CI_JOB_TOKEN` may post MR notes] |
| Plain CLI container image | `ghcr.io/<owner>/blastradius@sha256:…` with Node 22, the engine and a pinned Syft; read-only root, non-root user | no | image build, SBOM and provenance attestation for our own image |

**Effort.** 8 days: generic webhook 2, due-diligence pack export 2, "enrich my SBOM" mode 1,
GitLab template 1, container image 2.

**Acceptance on real data.**
- parse-server's CycloneDX imports into OWASP Dependency-Track with our properties visible
  [u: Dependency-Track not run here].
- A recorded label-worse event from two stored scans posts once to a webhook receiver with a valid
  signature.

**Depends on.** §1.2. The CRA profile comes from §5 P6.

---

## 4. Reuse open source before building

**Rule.** The data layer is a commodity (market study §0, §1.3). Before we build P2-style analytics
(git history), identity merge, P4 funding or a licence engine, we take what already exists if:
- it is maintained;
- its licence fits a commercial product;
- its data can be shown with attribution.

We build only the joined, sourced graph, the stability labels, the roll-ups and the outputs.

| Candidate | What it gives | Licence and terms | Status (2026-10-12) | Decision | Why |
|---|---|---|---|---|---|
| **ecosyste.ms** (packages, repos, commits, funds) | per package: maintainers, licences, funding links, dependents, a `critical` flag, and an owner record (kind, company, location, website, funding) (market study §1.3). Live answer for chalk: maintainer sindresorhus, `critical: true`, three funding links [v]. Per-repo commit stats: past-year committers, bot commits, `dds` [v live: expressjs/express 395 committers, 42 in the past year] | code AGPL-3.0 [v [packages LICENSE](https://github.com/ecosyste-ms/packages/blob/main/LICENSE)]; data **CC BY-SA 4.0** [v home page; WHO-BEHIND-PLAN §5]; a [commercial licence](https://docs.ecosyste.ms/docs/usage/commercial/) and higher limits are sold through Open Source Collective [v page resolves; terms per market study §1.3]; free tier 300 requests/hour ([pricing](https://ecosyste.ms/pricing)) | active: all four services have commits on 2026-10-12 [v]. Their August 2025 note says licence revenue no longer covers hosting (market study §1.3 [u there]) | **Adopt as the main data source** for maintainers, owners and funding links, in every ecosystem of §2 | It replaces several of our own lookups, and covers repos over our history cap without a clone. **Owner decision:** CC BY-SA is share-alike, so redistributing the data in a paid product (exports, SaaS, the due-diligence pack) needs the commercial licence (§6). Until then it is a lookup, attributed on screen, kept out of exports. Our own collectors stay as the fallback and the cross-check. Our CAF stays ours: it needs hashed e-mails, `--as-of` replays and bot lists |
| **GrimoireLab SortingHat** (identity merge and org affiliation) | merges a person's identities (e-mails, names, logins) into one and enrols them in organisations with dates (market study §1.3) | GPL-3.0 [v [LICENSE](https://github.com/chaoss/grimoirelab-sortinghat/blob/master/LICENSE)] | active, last commit 2026-09-21, tag 1.15.2rc1 [v] | **Evaluate against our merge** (`src/history/merge.ts`); adopt its rules or affiliation data if it wins | Identity errors caused the false takeovers (teardown problem 4: nanoid's author changing e-mail; react's address change still reads as two people, §11 "Deferred"). Run both on the recorded identity fixtures (`tier0-identity.json`; nanoid, react, picocolors, moment, xmldom) and the event-stream and xz histories. Pick on false merges and missed merges. GPL-3.0 means running it as a separate service or reusing its approach and data, not linking it into our CLI. Python plus a database is a second runtime |
| **GrimoireLab** (rest of the stack) and **CollectOSS** (ex-Augur) | contributor analytics dashboards | GrimoireLab GPL-3.0 [v [LICENSE](https://github.com/chaoss/grimoirelab/blob/master/LICENSE)]; CollectOSS MIT [v [LICENSE](https://github.com/chaoss/CollectOSS/blob/main/LICENSE)] | GrimoireLab active (2026-09-22) [v]; Augur "has been moved outside of the CHAOSS organization", CollectOSS is the fork [v [Augur README](https://github.com/chaoss/augur/blob/main/README.md)] | **Test reference only** | A full OpenSearch or Postgres service for numbers our P2 collector already gives |
| **deps.dev** | licences, repos, Scorecard, dependents, advisories; Go and RubyGems requirements | API under Google API ToS, data CC-BY 4.0 (WHO-BEHIND-PLAN L1 [v P0]) | live [v] | **Input only** (exists); extend to Go and RubyGems (§2.4) | No maintainer data. Its values are shown with their source and never drive a label alone |
| **OpenSSF Scorecard** | Maintained, Contributors, Signed-Releases, … | Apache-2.0 [v [LICENSE](https://github.com/ossf/scorecard/blob/main/LICENSE)] | active, 2026-10-12 [v] | **Input only** (exists) | Fallback for repos we do not clone (Tier 0). It never drives severity (teardown, Tier 0) |
| **funding.json** (FLOSS/fund) | declared funding channels, plans and history, and the entity type and role | spec at [floss.fund](https://floss.fund/funding-manifest/), schema v1.1.0 (WHO-BEHIND-PLAN F1 [v P0]); the Go reference library is MIT, last commit 2025-09-02 [v [go-funding-json](https://github.com/floss-fund/go-funding-json)] | live; [dir.floss.fund](https://dir.floss.fund/) resolves [v] | **Adopt** in P4 (F1); validate with the official JSON schema (`ajv`) | Self-declared, high confidence. Its `entity` is also a clean declared input for P7 (market study §1.3) |
| **OSS Review Toolkit (ORT)** | licence policy as code (`evaluator.rules.kts` over `license-classifications.yml`), NOTICE files, SPDX and CycloneDX | Apache-2.0 [v [LICENSE](https://github.com/oss-review-toolkit/ort/blob/main/LICENSE)] | active, last commit 2026-10-12 [v] | **Adopt for the licence policy gate and NOTICE output** (§5, step 5.4) | Do not write a new licence engine (market study §6.4). We feed ORT our inventory and sourced licences. ORT evaluates and writes notices, and we show its results with their rule names. It runs on the JVM, so it ships in the container image or runs as the customer's own ORT (§6 owner decision) |
| **Tidelift (now Sonar)** | curated maintainer attestations and end-of-life status for "lifted" packages | paid; now inside SonarQube Advanced Security (market study §1.3) | — | **Integrate as a source** when the customer has it ("this package has a paid maintainer", with source) | Do not compete. Public API access needs a subscriber token (WHO-BEHIND-PLAN F1 [u]) |
| **thanks.dev and GitHub Sponsors** | payment rails | thanks.dev: no public data API found (WHO-BEHIND-PLAN F1 [v]); Sponsors via GraphQL (F1 [v P0]) | live | **Money hand-off only.** Export the P4 sponsor list in their formats, with pay links | We never handle money (market study §1.3, §6.4) |
| **Open Source Pledge** member data | per company: join date, yearly self-reported USD paid to maintainers, average developer count [v `data/members/ag-grid.json`: 2024, $30,000, 14 devs] | `data/**` is CC0-1.0 per the repo's [REUSE.toml](https://github.com/opensourcepledge/osspledge.com/blob/main/REUSE.toml) [v] | active, 2026-10-11 [v] | **Integrate** in P4 as company-level context | "Pays maintainers: $N in 2024, self-reported (Open Source Pledge)". Never attributed to a package |
| **OpenSSF Security Insights** (`security-insights.yml`) | project-declared `administrators`, `core-team`, `funding`, and `steward` as defined by CRA Art. 3 [v [schema.cue](https://github.com/ossf/security-insights/blob/main/spec/schema.cue)] | Community Specification License 1.0 [v [LICENSE](https://github.com/ossf/security-insights/blob/main/LICENSE)] | active, 2026-10-08 [v] | **Read when present**, as a self-declared source | The steward field is the regulated CRA fact for the due-diligence file. Coverage is low (market study §1.3 [u there]) |
| **Open Collective** | ledgers, backers, fiscal hosts | API terms (WHO-BEHIND-PLAN F2 [v P0]) | live | **Keep** (exists) | P4 adds direction and amounts |
| **OpenSSF Criticality Score** | 0–1 importance | Apache-2.0 [v] | "Beta"; Google Cloud data "will no longer be available after 2026-08-29" [v [README](https://github.com/ossf/criticality_score/blob/main/README.md)] | **Drop** | No live data. Use ecosyste.ms `critical` and our own production fan-in instead (market study §6.4) |
| **libraries.io** | scraped package metadata | free, owned by Tidelift/Sonar; describes its own data as not validated (market study §1.3) | — | **Drop** | ecosyste.ms supersedes it |

**Effect on the plan.**
- **P2** keeps its own git-history collector. The identity-merge step is decided by the SortingHat
  evaluation. ecosyste.ms fills maintainers and commit stats for repos over the cap, labelled
  "basis: ecosyste.ms".
- **P4** becomes mostly integration:
  - ecosyste.ms funding links and owner records;
  - funding.json, Security Insights `funding` and `steward`, Pledge data;
  - Open Collective amounts;
  - the Sponsors listing through the customer's token (§3.1);
  - a sponsor list exported to thanks.dev and Sponsors.
- **The licence gate** is built on ORT.
- **Effort** of this section:

| Step | Days |
|---|---|
| ecosyste.ms adapter (maintainers, owner record, funding links, commit stats) as a primary source with fallback | 3 |
| SortingHat evaluation on the recorded identity fixtures, then adopt or close | 3 |
| Security Insights reader | 1 |
| Pledge data | 1 |
| **Total** | **8** |

funding.json, Tidelift and the money hand-off are counted in P4. ORT is counted in the licence gate
(step 5.4).

---

## 5. Product phases after that

The order follows the teardown's tiers (Tier 0 is done, WHO-BEHIND-PLAN §11). Each phase keeps its
gate from WHO-BEHIND-PLAN §6, measured on recorded real data.

| # | Phase | Goal | Approach and reuse | Effort | Acceptance on real data | Depends on |
|---|---|---|---|---|---|---|
| 5.1 | **Ask Blastradius: text, then voice** | ask questions of your own data, in the app | The Pipecat study's slice, with the owner decisions: model **Claude Sonnet 5.5** (`claude-sonnet-5-5`, set by an environment variable, Pipecat's thinking setting set explicitly because its default breaks Sonnet 5.5); person-level handles to the model only for `manage_projects`; the bot is an **optional add-on** service (core stays Node-only); **no phone, SIP, dial-in or Pipecat Cloud**. Step 1a text over WebSocket; step 1b push-to-talk voice over SmallWebRTC with local faster-whisper and Kokoro. Shares the tool manifest and token with §3.2 | 11–15 | the 8 golden questions and the guardrail cases of Pipecat study §6.7; time to first audio measured in a live run [u until a key] | §1.2, §3.2 token path, an Anthropic key |
| 5.2 | **P6 views and roll-up, plus the CRA due-diligence file and SBOM profile** | the data exists but cannot be seen or handed on (every teardown persona); this step ships the lead wedge (market study §6.1) | **The CRA Art. 13(5) due-diligence file**: per production dependency, the controlling entity, publishers, steward, maintenance state with evidence, licence with source and funding, plus an exceptions list, as a page, a PDF one-pager and the GRC evidence objects of §3.3. P6 as planned (Stability and Funding views, Overview tile, Exposure "Funders and backers", package pages, "first seen in repos"); a baselined weekly digest grouped by decision; incident export. SBOM: supplier (registry publisher or owning org, labelled by source), hashes (lockfile `integrity`, go.sum, `CHECKSUMS`), `downloadLocation` from `resolved`, scope per component, `DEV_DEPENDENCY_OF` / `BUILD_TOOL_OF`, a separate build-environment SBOM for CI actions and images, `--sbom-scope runtime`, `--manufacturer`, `--sbom-profile cra` checked against BSI TR-03183-2 v2.1.0 fields (creator or supplier, hashes, licences; market study §3.1) and listing every field it could not fill; Security Insights `steward` where declared | 13 | parse-server: a due-diligence file for all runtime dependencies where every row cites its sources; supplier filled on ≥ 95 % of runtime components, hashes on 100 % of lockfile components, 0 CI actions in the product SBOM, validation against the CycloneDX 1.6 and SPDX 2.3 schemas; roll-up numbers equal API counts (contract test) | §2 for non-npm hashes; the graph-database evaluation (5.8) |
| 5.3 | **P5 issues knowledge base** | make the account pivot an incident product | KB event types (`funding_change`, `maintainer_stepping_away`, `relicensing`, …), proposals from facts and from the agentic `lifecycle_events` / `incident_writeups`; link KB and OSV MAL entries to package pages; "publisher of adjacent versions" | 4 | seeded events for HashiCorp, Elastic, Redis, core-js, colors/faker with sources; `kb validate` passes; qix's known-bad versions flagged on every view | 1.1 (dates are checked) |
| 5.4 | **Licence policy as a CI gate, built on ORT** | legal can pilot it next to FOSSA | **ORT evaluates and writes NOTICE files** (§4): we hand it our inventory and sourced licences, ship a default `evaluator.rules.kts` and `license-classifications.yml` per distribution type, and show its rule names. Our own work: distribution type per project (SaaS, distributed, internal); violations become findings, exit code `--fail-on-license deny` and an optional SARIF result; approvals per component@version with who, why and expiry; licence-file reading for "SEE LICENSE IN" via ClearlyDefined discovered expressions; NOTICE export (`--format notices`, written by ORT); review queue ranked by obligation × runtime reach | 6 | superset `mapbox-gl@3.32.0` (Mapbox TOS) and jitsi `matroska@2.2.5` (GPL-3.0, production) become review/deny findings; ua-parser-js MIT → AGPL is first in the change feed; NOTICE for parse-server lists every runtime licence text | §3.1 for the PR gate |
| 5.5 | **P4 funding with direction and amounts, plus a sponsor list** | who really funds what, and where money would help | Mostly integration (§4): ecosyste.ms funding links and owner records as the main source; Tidelift (Sonar) as a source when the customer has it; "receives at" vs "backed by"; OC amounts and dates (12 months, top share, trend); Sponsors listing through the customer token; funding.json; Pledge context; Security Insights `funding`. Sponsor list ranked by production fan-in × CAF × underfunding, exported in thanks.dev and GitHub Sponsors formats with pay links; we never handle money | 6 | §8 rows 5, 11, 12 (core-js, babel, webpack, express); no `funds` edge without direction; individual backers excluded (test) | §3.1 token; §4 integrations |
| 5.6 | **P8 privacy operations** | ready for a customer data-processing agreement | retention dates per person, the salt outside the cache, the legitimate-interest assessment, objection and suppression route (`suppressed` wins over every rule), export excludes hashes | 2–3 | retention test with a fake clock; a suppression request removes a recorded handle from every view and export | legal review (§6) |
| 5.7 | **P7 org jurisdiction and sanctions, with human confirmation (premium tier)** | the board question at organisation level, with sources; a premium tier for legal and GRC, gated on design partners (market study §6.3, §6.4). Org-level only: no person is ever screened | controlling-entity table; declared org location with source; OFAC SDN and consolidated (EU and UK after verification) as a versioned list pack; "possible match, needs review" until a person confirms; reads only `confirmedJurisdictions()` | 4 | synthetic list test (true match, near miss, a person's name never matched); real org rows for Open Source Collective and Elastic N.V. pending confirmation (from the live run) | owner typing via §3.1 token, P4 direction, P8 |
| 5.8 | **Graph-database evaluation at P6** | pick the store for roll-ups across an estate | Measure on estate-sized data (all stored scans of parse-server, jitsi-meet, superset, flask and the replay "Acme" org, scaled ×10 synthetically): (a) Postgres recursive CTEs, (b) a Postgres graph extension (Apache AGE [u: licence and status not checked]), (c) an embedded graph DB (Kùzu [u: maintenance status after 2025 not checked]). Questions: "who can publish into production across the org", "funders covering these 12 packages", "first seen in repos" | 3 | p95 latency and memory for the three questions at 10× size; pick the simplest option that meets 500 ms p95 | 5.2 design |

---

## 6. Owner and external dependencies

| Need | Why | Blocks |
|---|---|---|
| **Design partners** (2–3 teams; profiles and questions in market study §6.5: an EU manufacturer's OSPO preparing CRA due diligence first, then a platform team, an incident responder; a US defence supplier and a DORA third-party-risk team for the premium tier) | real verdicts for the learning loop; PR-comment wording; the due-diligence file's fields; GRC evidence format; willingness to pay for P7 | §1.3 Q2 onward, §3.3, 5.4 |
| **A GitHub token** for development (fine-grained, public repositories, read) and a test repository | owner types, login mapping and Sponsors are untested live (403 here); Action development | §3.1 acceptance, 5.5, 5.7 |
| **An Anthropic API key** for live runs | the agentic pipeline and the assistant are tested only on replays [u] | §1.1 live re-run, §3.2 and 5.1 live smoke tests |
| **Legal review of privacy** | legitimate-interest assessment, retention, person-level data in MCP and the assistant, sanctions wording | 5.6, 5.7, shared corrections KB |
| **ecosyste.ms commercial licence** (owner decision) | ecosyste.ms becomes the main data source (§4). Its data is CC BY-SA 4.0 (share-alike), so redistributing it in a paid product (exports, the due-diligence pack, SaaS) needs its commercial licence, sold through Open Source Collective. Buying it also supports a fragile dependency (market study §1.3, §6.3) | §4 adoption beyond on-screen lookups; 5.2 exports |
| **ORT in the product** (owner decision) | ORT runs on the JVM: ship it in the container image, or require the customer's own ORT | 5.4 |
| **Data-source terms** | ecosyste.ms AGPL code (we call the API only); deps.dev Google API ToS; Open Collective API terms; Open Source Pledge CC0 (no issue); GitHub API terms for data from customer tokens stored on our server | §4 integrations, §3.1 upload |
| **Repo housekeeping** | Bugbot GitHub app (keep or remove; it reviews PR #2); the `data/ml-model` and `data-ml/model` branches (the model is not shipped, FEEDS-AND-DETECTORS.md: archive or tag); the GitHub tutorial workflows `0-start.yml` … `5-merge-your-pull-request.yml` and the `new`, `new.txt`, `run.txt` files on `main`; stale `review/*`, `ui/*` and `wip/*` branches after the split | §1.2 |

---

## 7. Timeline

One developer per lane, in working days, all estimates. Lane B (a second developer) starts in
week 3.

The order follows dependencies:
- trust and merge first;
- then the cheap distribution channels (MCP, Action);
- then coverage and reuse;
- then the wedge (the due-diligence file, 5.2) and the other phases.

| Weeks | Lane A | Lane B (second developer) | Effort A / B (days) | Exit |
|---|---|---|---|---|
| 1–2 | §1.1 agent gate gaps; §1.2 split PR #2 and merge; QUALITY-SYSTEM Q1 starts | — | 2 + 4 + 4 / — | probe-wrong-date rejected; main green with the same test counts |
| 3–5 | Q1 (finish), Q2 (feedback, event log, harness, CI gate) | §3.2 MCP server and skill; §3.1 GitHub Action | 14–21 / 5 + 8 | rule changes blocked on regression; golden questions answered in Claude Code; Action comment on a real publisher change |
| 6–10 | §2 ecosystem coverage | §4 reuse (ecosyste.ms, SortingHat evaluation); §3.3 SBOM enrichment, GRC evidence, webhooks, GitLab, image; Q3 (corrections KB, noise view) | 22 / 8 + 8 + 10 | the §2.5 table passes; the identity-merge decision is recorded |
| 11–13 | 5.2 P6 views, roll-up, **CRA due-diligence file** and SBOM profile, with 5.8 graph evaluation | 5.4 licence gate on ORT; 5.3 P5 issues KB; Q4 | 13 + 3 / 6 + 4 + 7.5 | due-diligence file and CRA profile on parse-server; mapbox-gl and matroska flagged |
| 14–16 | 5.1 Ask Blastradius (text, then voice) | 5.5 P4 funding and sponsor list; 5.6 P8 privacy ops | 11–15 / 6 + 2–3 | Pipecat golden questions; §8 funding rows |
| 17–18 | 5.7 P7 jurisdiction and sanctions (premium) | calibrated ranker in shadow mode, if enough labels exist | 4 / 5–10 | synthetic list test; ranker report |

**Totals.** About 145–165 developer-days, or about 18 weeks with two developers.

The external dependencies in §6 move these dates. The biggest are the GitHub token, design
partners, the ecosyste.ms licence and legal review.
