# Blastradius

A supply-chain blast-radius auditor for npm projects (Phase 0 + Phase 1 MVP of `docs/PLAN.md`).

Point it at a local directory or a git URL. Blastradius then:

1. **Builds an inventory** by reading `package-lock.json`/`npm-shrinkwrap.json` (v1–v3), `package.json`, GitHub Actions workflows and Dockerfiles. It only parses these files; it never runs anything from the target.
2. **Enriches** every npm component from public sources: advisories and malware reports, provenance, Scorecard, dependents, registry publish history, install scripts, repo ownership and funding.
3. **Links** packages to accounts, orgs and funders, and links those to a curated **incident knowledge base** (`kb/incidents`).
4. **Scores** each component's risk 0–100 with explainable reasons. It also computes the **inbound blast radius**: which of your repos, workflows and images reach the component, and by which dependency paths.
5. **Scores the outbound side:** how exposed your own CI workflows are (privileged triggers, PR-head checkout, unpinned actions, write tokens, OIDC).
6. **Writes reports** as JSON, SARIF 2.1.0 (for GitHub code scanning) and a self-contained HTML page, and prints a short terminal summary.

## Install

Requires Node.js 22+.

```sh
cd blastradius
npm install
npm run build          # compiles to dist/; the `blastradius` bin is dist/cli.js
npm link               # optional: puts `blastradius` on PATH
```

During development you can run it without building: `npx tsx src/cli.ts …` (or `npm start -- …`).

## Usage

```sh
# Scan a local checkout (online), writing JSON + SARIF + HTML to ./out
blastradius scan ./my-app

# Scan a remote repo (shallow clone with --depth 1, hooks and submodules disabled)
blastradius scan https://github.com/owner/repo --out reports

# Fail CI when anything is high or critical (exit code 2)
blastradius scan . --format sarif --fail-on high

# Validate the incident knowledge base
blastradius kb validate            # bundled kb/incidents
blastradius kb validate path/to/kb
```

| `scan` option | Meaning |
| --- | --- |
| `--format <list>` | `json`, `sarif`, `html` (comma-separated) or `all` (default) |
| `--out <dir>` | output directory (default `out`): `blastradius.json`, `.sarif`, `.html` |
| `--offline` | no network; answer from fixtures and the cache only (git URL targets are refused: scan a local checkout) |
| `--fixtures <dir>` | directory of recorded API responses, searched recursively (implies `--offline`) |
| `--no-cache` | disable the on-disk HTTP cache (per-user: `$BLASTRADIUS_CACHE_DIR`, else `$XDG_CACHE_HOME/blastradius`, else `~/.cache/blastradius`) |
| `--as-of <date>` | reference time for decay and history: registry versions, KB incidents and advisories published after it are ignored (backtests) |
| `--kb <dir>` | incident KB directory (default: bundled `kb/incidents`) |
| `--review <file>` | JSON review decisions that accept or reject probabilistic entity links |
| `--syft` | also merge a Syft CycloneDX SBOM when `syft` is on PATH (optional) |
| `--fail-on critical\|high` | exit code 2 if any finding, including an outbound workflow finding, is at or above that level |
| `--top <n>` | number of findings in the terminal summary (default 5) |

Exit codes: `0` ok, `1` error (or `kb validate` found problems), `2` `--fail-on` matched.

Per-asset settings go in an optional `.blastradius.yml` at the target root. It sets environment and criticality by path; the longest match wins:

```yaml
assets:
  - path: services/api
    environment: prod
    criticality: 5
  - path: docs
    environment: dev
```

### Example (offline, from this repo)

```sh
npx tsx src/cli.ts scan test/fixtures/e2e-repo --fixtures test/fixtures --no-cache --as-of 2018-11-27 --out /tmp/br
```

```
blastradius: test/fixtures/e2e-repo
  inventory: 2 asset(s), 12 component(s), 16 edge(s)
  findings:  critical 2 | high 0 | medium 4 | low 4
  top 5:
    [CRITICAL] 100.0  pkg:npm/event-stream@3.3.6  (reaches 1 asset, blast 0.6)
           malware: Listed as malicious in GHSA-mh6f-8j2x-4483 (source: osv): …
    [CRITICAL] 100.0  pkg:npm/flatmap-stream@0.1.1  (reaches 1 asset, blast 0.6)
    …
  outbound: 1 workflow(s); highest workflow:.github/workflows/pr-check.yml score 54.1
```

## Data sources and network access

| Source | Used for | Endpoint |
| --- | --- | --- |
| OSV | known vulnerabilities and malware (`MAL-*`, malware GHSAs) | `api.osv.dev/v1/querybatch`, `/v1/vulns/{id}` |
| deps.dev | provenance/attestations, source repo, Scorecard, dependents | `api.deps.dev/v3…` |
| OpenSSF Scorecard | fallback when deps.dev has no Scorecard | `api.securityscorecards.dev` |
| npm registry | maintainers, publisher history, install scripts, release age, repo, funding | `registry.npmjs.org` |
| GitHub | repo owner/transfer/archived, FUNDING.yml | `api.github.com`, `raw.githubusercontent.com` |
| Open Collective | organisational backers | `api.opencollective.com/graphql/v2` |

All requests go through one HTTP client per scan, with an on-disk cache (24 h TTL), per-host rate limiting and retry with backoff. The cache and npm snapshots live in a per-user cache directory, never in the working directory: a scanned checkout cannot supply its own cached responses. A cache directory that resolves inside the scan target is disabled with a warning, and cache entries with a missing or future timestamp are ignored. Set `GITHUB_TOKEN` for higher GitHub rate limits; it is only ever sent to `api.github.com`.

**Network access:** OSV, deps.dev, Scorecard and the GitHub API need outbound network access. In the sandbox this was built in, those hosts are blocked (GitHub returns 403 without a token) and only `registry.npmjs.org` is reachable. Every enricher therefore works from recorded fixtures, and the whole test suite runs offline. Run online elsewhere to get live data. A lookup that fails becomes a warning in the report; it never aborts the scan.

### Offline / fixtures mode

`--offline` (or `BLASTRADIUS_OFFLINE=1`) disables live requests. Answers come from:

1. fixture envelopes in `--fixtures <dir>` (or `BLASTRADIUS_FIXTURES`), as
   `{ "request": { "url", "method?", "body?" }, "status?", "response" }`. A fixture with a `body` matches only that exact POST body;
2. the HTTP cache, even when stale.

Anything else is reported as one roll-up warning per source, e.g. `npm: 1 packument(s) missing from fixtures/cache in offline mode: flatmap-stream`. `test/fixtures/` holds the recorded and reconstructed responses used by the tests. See `test/backtest/README.md` for where each one came from.

## Scoring model (PLAN §3.6, in brief)

All weights are in `src/scoring/weights.ts`. They are initial guesses, to be calibrated against the backtests.

- **Intrinsic risk** (noisy-OR, `1 − Π(1 − wᵢ·fᵢ)`) combines:
  - vulnerabilities (CVSS × exploitability, with EPSS/KEV when known);
  - a recent publisher or maintainer change, decaying linearly over 90 days; a repo transfer decays from its transfer date when a source gives one, and otherwise counts as a small constant (GitHub only shows that the declared URL redirects today, not when it moved);
  - install scripts (higher when static checks flag network access, eval, obfuscation, piping to a shell, background processes, token/environment access, credential files, or a hook that the previous release did not have; the flag names are shared in `src/core/install-flags.ts`);
  - weak Scorecard;
  - missing provenance;
  - a single maintainer;
  - abandonment: no release in 2 years (or an archived repo) **and** known vulnerabilities. Staleness alone is shown for information with weight 0.

  **Malware override:** an OSV malware record (a `MAL-*` id or alias, OpenSSF malicious-packages origins, or CWE-506; advisory summary text is never used), or a confirmed KB incident that names the exact version or commit, sets intrinsic risk to 1.0. A KB entry that lists `"*"` (all versions) never triggers the override; it becomes a decaying `incident_affected` reason. A confirmed CI compromise is reported as `compromised_release` rather than `malware`.
- **Entity risk:** the strongest path from the package through accounts, orgs and funders to a KB incident. Each path is weighted by severity, status (confirmed 1, alleged 0.4, disputed/retracted 0), link confidence, a 3-year half-life and hop decay. Probabilistic links below 0.8 confidence count only after human review.
- **Combined:** `risk = 1 − (1 − intrinsic)(1 − entity)` and `score = 100·risk`. Levels: critical ≥ 80, high ≥ 60, medium ≥ 30, low below that.
- **Inbound blast radius:**
  - Exposure per asset is the best dependency path, where each path is worth its weakest edge: runtime/peer 1, build 0.8, dev 0.3, optional 0.2.
  - Install scripts raise exposure to at least 0.9.
  - Privileged CI multiplies by 1.2; SHA/digest pins multiply by 0.7.
  - Each asset is weighted by criticality/5 × environment (prod 1, ci 0.9, staging 0.5, dev 0.3).
  - Up to 5 shortest paths per asset are reported.
- **Outbound:** workflow compromise likelihood × publish reach. The planned `× log10(1 + dependents)` term is not wired in yet: the pipeline does not look up dependents for your own packages, so the term is 1.

Every dependency reason carries a factual detail string and its public evidence URLs. Outbound (workflow) reasons name the workflow but do not carry evidence URLs yet. Each finding's `entityChain` lists the links from the package to a KB incident (`from`, `entityId`, `relation`, `confidence`, `evidence`, `method`, `reviewed`). A confirmed incident naming the exact version appears there as a single hop.

## Guardrails (PLAN §7)

- **Never executes scanned code:**
  - no `npm install`, lifecycle scripts or builds;
  - install-script text is only matched against regexes;
  - git clones use `--depth 1` with an argument array and no shell, with hooks, submodules, LFS and credential prompts disabled; only `https`/`ssh` URLs without embedded credentials are accepted.
- **Scanned content and API responses are untrusted:**
  - reads are size-capped, symlinks that escape the target are not followed, and JSON is read through own-property access only;
  - output is escaped (the HTML report has a strict CSP and no scripts), and only `http(s)` evidence links are rendered.
- **Wording about people and orgs is factual and sourced:**
  - every entity link and incident needs public evidence and a status;
  - the KB validator rejects judgement words in titles and requires https evidence;
  - nobody is labelled malicious; the KB seeds describe projects and name no individuals.
- **No profiling by nationality or ethnicity.** Sanctions incidents must cite an official source (OFAC).
- **Data minimisation:** registry email addresses are dropped by default and never stored in entities.

## Development

```sh
npm run typecheck   # tsc --noEmit (src + tests)
npm test            # vitest: unit, e2e (test/e2e) and backtests (test/backtest), fully offline
npm run build       # tsc -p tsconfig.build.json → dist/
```

Layout:

| Path | Contents |
| --- | --- |
| `src/ingest` | inventory |
| `src/enrich/{osv,depsdev,npm,github}` | enrichers |
| `src/incidents` | KB loader, validator, OSV import |
| `src/entities` | resolution, review, graph |
| `src/scoring` | scoring engine |
| `src/report` | report renderers |
| `src/pipeline.ts` | pipeline wiring |
| `src/cli.ts` | CLI |
| `CONTRACTS.md` | contracts between modules |

## What Phase 2+ adds

**Not done from Phase 0:** the Postgres schema. The MVP stores nothing in a database; it is deferred. (CI runs in `.github/workflows/blastradius.yml`: typecheck, tests, build, KB validation and an offline end-to-end scan, plus a non-blocking live-API smoke test.)

Some Phase 2 pieces are already here: npm snapshots, entity resolution with a review state, the YAML KB and its validator, funding sources, and the outbound workflow score. Still to come:

- **Phase 2 (who's behind it):**
  - GitHub contributors and org membership;
  - a review-queue UI;
  - more seed incidents with sourced, reviewed entity refs (15 project-level records ship today);
  - maintainer → org → funder → incident chains shown in the report for real scans.
- **Phase 3 (breadth):**
  - PyPI, Maven, Go and crates; yarn and pnpm lockfiles;
  - container image contents;
  - GuardDog-style behaviour checks and typosquat detection;
  - zizmor/poutine-grade workflow analysis, and dependents for outbound reach;
  - EPSS/KEV feeds.
- **Phase 4 (product):**
  - web dashboard and graph view;
  - org-wide and nightly scans;
  - GitHub Action PR gate;
  - continuous monitoring and alerts;
  - API and auth.
- **Phase 5:** KB curation, weight calibration against a larger backtest set, dispute handling.
- **Phase 6:** optional bring-your-own-AI assistance. Scans behave the same with AI switched off.
