# Blastradius data and model design (knowledge pack)

> **Superseded in part (2026-10-08): see [FEEDS-AND-DETECTORS.md](FEEDS-AND-DETECTORS.md).** We no longer train our own "next compromise" model. Detection reuses established feeds and detectors (OSV and OpenSSF, GuardDog, Datadog's dataset), and Blastradius owns the blast radius and "who's behind it". The model was trained properly but lost to the existing rules on both gate measures, so it is not shipped (`data-ml/model`, reports/2026-10-08-gate.md). The dataset and gate stay as the way we evaluate detectors.

**Decision (2026-10-07):** build the data and train the model **once**, as a one-off bootstrap. The result is a small, versioned **knowledge pack** that ships with the app. Regular scans run against the pack and only fetch live data for gaps. Refreshing the pack means re-running the same bootstrap job, by hand, when wanted. There is no continuous ingestion service.

Why: scan-time fetching of every source for every package was slow (3,000 packages took about 27 minutes in the hammer run). It was noisy, because hand-set weights flag almost every npm package as "low". And it never built up the maintainer → org → funder graph, so "who's behind it" stayed empty.

## 1. Scope: small but enough

The pack covers a bounded **package universe**, not the whole npm registry:

| Set | Why | Rough size |
|---|---|---|
| Every npm package named in OSV `MAL-*`, GitHub malware advisories and our incident KB | Positive labels and known-bad lookups | low thousands |
| Top npm packages by dependents (deps.dev) | Where most real projects' dependencies live; negative labels | ~10k |
| Every package in the hammer scenarios' lockfiles | Proves the app on real repos | ~10k (overlaps) |

A package outside the pack still scans: known-bad checks always run (OSV live, plus the pack's malware list), and missing features are fetched live and cached.

## 2. Bootstrap job (runs once, in GitHub Actions in the private repo, which has network access)

1. **Collect** for the universe:
   - OSV npm exports (all advisories, including `MAL-*`) and GitHub advisories.
   - npm packuments: every version, its publish time and `_npmUser`, maintainers per version, install scripts, `dist.attestations`, repository and funding fields.
   - deps.dev: dependents counts, repository links. OpenSSF Scorecard: checks.
   - GitHub (token): repo owner type, contributors (top), `FUNDING.yml`, archived flag. Open Collective / GitHub Sponsors from `FUNDING.yml`.
2. **Normalise** into a graph with **bitemporal facts**: each fact has `validFrom/validTo` (when it was true) and `observedAt` (when we saw it), plus its source URL. That gives exact as-of replays and change detection.
   - Nodes: package, version, account (npm/GitHub), organisation, funder, repository, incident.
   - Edges: `published_by`, `maintained_by`, `owned_by`, `funded_by`, `repo_of`, `affected_by`, `depends_on` (counts only).
3. **Entity resolution:** link npm accounts ↔ GitHub users ↔ organisations ↔ funders.
   - Deterministic links: an explicit repository field, a verified `FUNDING.yml`, npm trusted publishing.
   - Probabilistic matching for the rest. Links below 0.8 go to the existing review queue and are not used for scoring until accepted.
4. **Features (as of a date)**, computed by one shared module used for training and at scan time:
   - recent maintainer or publisher change (days since, first release by this account);
   - new install script vs the previous release;
   - token publish vs trusted publishing, provenance present;
   - maintainer count (bus factor), account age;
   - release cadence change and abandonment;
   - Scorecard checks;
   - typosquat distance to popular names;
   - dependency churn in the release;
   - downloads trend.
5. **Labels:** a version is positive if a confirmed compromise (OSV `MAL-*`, GitHub malware advisory or a KB incident of a compromised-release type) affected it. Features use only data known **before** the label date (time-split; no leakage).
6. **Train:**
   - **Model:** gradient-boosted trees (LightGBM, small depth), target "this package has a compromised release within the next 90 days".
   - **Imbalance:** handled with class weights and evaluated with precision@k and recall, not accuracy.
   - **Calibration:** isotonic, so a displayed 30% means about 3 in 10 on held-out data.
   - **Export:** the trees as JSON, so TypeScript can evaluate them at scan time. No Python is needed at runtime.
7. **Backtest and gate.** On a time-held-out set the model must beat today's hand-weighted noisy-OR on both:
   - **Recall:** share of real compromises flagged at or before disclosure.
   - **Noise:** findings per healthy, well-maintained repo (the hammer controls).

   If it does not beat it, it does not ship, and the report says why.
8. **Emit the knowledge pack:** a compressed SQLite file (or gzip JSON), a few tens of MB at most. It contains the graph, the features at pack time, the malware and incident list, the model JSON, a calibration table, and a manifest (sources, dates, row counts, backtest metrics, git SHAs). It is published as a release asset on the private repo; the app downloads it by version and verifies its SHA-256.

## 3. Scoring at scan time (three layers, each explainable)

| Layer | What | Output |
|---|---|---|
| Known-bad (rules, no ML) | Version listed in OSV `MAL-*` / malware advisory / KB incident / CISA KEV | **Critical**, with evidence links. Always wins. |
| Likely next compromise (model) | Calibrated probability from the pack model on the current features | A level from calibrated thresholds, plus the top contributing features in plain words |
| Inherited and reach (graph) | Risk passed through maintainer → org → funder links (decay tuned on the backtest); reach = your projects affected (production vs dev, direct vs transitive, "brought in by") plus downloads-weighted public dependents | "Reaches 3 of 12 projects, 2 in production, brought in by tslint; about 40k public packages depend on it" |

**Noise rule:** weak posture signals (no provenance, single maintainer, abandoned) are **model features and a health column**, not findings. A finding is created only for a known-bad match, a model score above the calibrated threshold, or inherited risk above the threshold.

**AI rule:** PLAN §11 stands. LLM assistants never change scores. The trained model is deterministic, versioned, backtested and explained per finding, so it is allowed to set the "likely next compromise" score (decided 2026-10-07).

## 4. Reuse, not reinvent (researched 2026-10-07)

| Need | Reuse | Licence | Notes |
|---|---|---|---|
| Malware, compromise and vulnerability records | **OSV bulk export** `gs://osv-vulnerabilities/npm/all.zip` (230k records, 222k `MAL-*`; refreshed daily) | CC-BY-4.0 / Apache-2.0 | Replaces per-package live queries for the pack. **Label filter:** only `MAL-*` records naming specific versions of a package that had earlier non-malicious releases count as "compromised release". Whole-package spam and typosquats are a separate class. |
| Curated compromises of legitimate packages | **tstromberg/supplychain-attack-data** (187 incidents, 734 npm artifacts, with a `cause` field) | Apache-2.0 | Seeds the incident KB (imported as `alleged` until reviewed) and the labels. |
| Extra labels | **DataDog malicious-software-packages-dataset** manifests ("compromised benign" flag) | Apache-2.0 | Manifests only; never unpack samples. |
| Top packages, dependents, Scorecard, provenance | **deps.dev** API, plus its BigQuery dataset for the one-off top-N and dependents history | CC-BY-4.0 | Scorecard via deps.dev first; OpenSSF's own hosted data is at risk after its cloud funding lapsed. |
| Registry history | **npm packuments + attestations API** | npm ToS | Add `_npmUser.trustedPublisher` (publish-method downgrade, as in axios 2026-03) and "in `time` but missing from `versions`" (unpublished, often malicious). |
| Repo collaborator changes | **GH Archive** (BigQuery `MemberEvent`) | public | The only time-stamped "new collaborator before a release" signal. |
| Funding | **GitHub GraphQL `fundingLinks`** + Sponsors (public), **Open Collective GraphQL** | platform ToS | Replaces our FUNDING.yml parser. |
| Known-exploited, exploit probability | **CISA KEV**, **FIRST EPSS** | CC0 / attribution | Bundled in the pack. |
| Metadata heuristics | **Datadog GuardDog** rules (email domain, metadata mismatch), **OSS Gadget** squat mutations | Apache-2.0 / MIT | Ported into the shared TS feature module. |
| Multi-ecosystem lockfiles | **OSV-SCALIBR / osv-scanner** (read-only extractors), **Syft** (kept) | Apache-2.0 | For PyPI, Maven, Go and crates. Our npm parser stays because it keeps scopes and workspaces. |
| SBOM in and out | **@cyclonedx/cyclonedx-library**, **packageurl-js** | Apache-2.0 / MIT | |
| Bootstrap number-crunching | **DuckDB** | MIT | Emits the SQLite pack. |
| Entity matching | **Splink 4** (probabilistic record linkage) | MIT | Per-field match weights become link evidence; links below 0.8 still go to review. |
| Model | **LightGBM** → `dump_model` JSON + a small TS evaluator | MIT | Parity check against LightGBM predictions is part of the bootstrap. |
| Graph UI | **Cytoscape.js** (kept) with WebGL renderer + ELK layout for chains | MIT | |

**Not adopted:**
- **GUAC:** a heavy Go service with no maintainer, funder or incident model.
- **cdxgen:** runs build tools, which breaks "never execute".
- **Trivy:** its own releases were compromised in March 2026.
- **packj:** AGPL licence.
- **OpenSSF Criticality Score:** its data was shut down in August 2026.
- **libraries.io:** stale.
- **Socket and Phylum data:** proprietary.

**Licence rule for the pack:** embed only CC-BY, Apache, MIT, CDLA-Permissive or CC0 data, and include a NOTICE table (source, licence, snapshot date) in the manifest. ecosyste.ms is CC BY-SA (share-alike), so it is only used at bootstrap time to compute features, and none of its raw rows ship. Decided 2026-10-07: no commercial licence for now.

**What nobody provides (our own asset):**
- the maintainer → org → funder → rug-pull history;
- npm-account ↔ GitHub-user ground truth beyond trusted publishing.

These come from our incident KB plus entity resolution and need ongoing curation.

**Base-rate warning:** account-takeover compromises of legitimate npm packages number in the low hundreds to about 1,000 (2018–2026) and are clustered in campaigns such as Shai-Hulud and chalk/debug. Splits are grouped by campaign and time, so one worm cannot leak across folds.

## Status (2026-10-07)

- **Pack v2 (known-bad layer) built.** v2 keeps 806 range-only advisories as ranges; v1 misread them as "every version" (live hammer run #4: fsevents 2.3.3 flagged by MAL-2023-462, which only covers 1.0.0–1.2.10). v1 packs are rejected. `npm run pack:build` (src/pack/) reads the OSV npm export and supplychain-attack-data and writes `pack.json.gz` (about 3 MB, gzipped JSON, sorted so the same inputs give the same bytes, with a `.sha256`). First build: 207,509 malicious-in-every-version packages, 27,262 bad releases of 14,587 otherwise legitimate packages, 84 curated npm incidents (imported as `alleged`).
- **Finding:** the classic compromises (event-stream, ua-parser-js, node-ipc) are not `MAL-*` records; they are GitHub advisories tagged **CWE-506** (embedded malicious code), so the pack includes those too. Protestware (colors, faker, peacenotwar) is in neither and stays covered by our own incident KB.
- **Scan time:** `blastradius scan --pack pack.json.gz` or `BLASTRADIUS_PACK=…` (the server reads the same variable). The pack enricher runs after OSV and only adds what live OSV did not already report, so offline and blocked-network scans still flag known malware.
- **Bootstrap job:** `test/hammer/ci/pack.yml` (copy into the private repo) builds the pack and publishes it as a release asset; the hammer workflow uses the newest one.
- **Noise rule and reach in words:** shipped (health list and "Upkeep signals" tab; `describeReach`).
- **Next:** maintainer → org → funder graph (npm packuments, GitHub `fundingLinks`, Open Collective), features and the model with its backtest gate.

## 5. Deliverables

- **Bootstrap scripts:** `blastradius/pack/` (collect, normalise, resolve, features, label, train in Python, export, backtest) and a `pack` workflow for the private repo.
- **Engine:** pack loader, a scan-time lookup path, the shared TypeScript feature module, and a tree evaluator.
- **Scoring:** the three layers above, replacing the hand-set weights once the gate passes.
- **Reports and UI:**
  - reach in words;
  - a "who's behind it" chain with evidence;
  - a health column;
  - per-role views (leadership summary, AppSec triage, developer "my repo").
- **Hammer:** a backtest report in the run, plus real-repo checks that the chains and reach appear.
