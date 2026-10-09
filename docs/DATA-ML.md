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

## Status (2026-10-08)

- **Pack v2 (known-bad layer) built.** v2 keeps 806 range-only advisories as ranges; v1 misread them as "every version" (live hammer run #4: fsevents 2.3.3 flagged by MAL-2023-462, which only covers 1.0.0–1.2.10). v1 packs are rejected. `npm run pack:build` (src/pack/) reads the OSV npm export and supplychain-attack-data and writes `pack.json.gz` (about 3 MB, gzipped JSON, sorted so the same inputs give the same bytes, with a `.sha256`). First build: 207,509 malicious-in-every-version packages, 27,262 bad releases of 14,587 otherwise legitimate packages, 84 curated npm incidents (imported as `alleged`).
- **Finding:** the classic compromises (event-stream, ua-parser-js, node-ipc) are not `MAL-*` records; they are GitHub advisories tagged **CWE-506** (embedded malicious code), so the pack includes those too. Protestware (colors, faker, peacenotwar) is in neither and stays covered by our own incident KB.
- **Scan time:** `blastradius scan --pack pack.json.gz` or `BLASTRADIUS_PACK=…` (the server reads the same variable). The pack enricher runs after OSV and only adds what live OSV did not already report, so offline and blocked-network scans still flag known malware.
- **Bootstrap job:** `test/hammer/ci/pack.yml` (copy into the private repo) builds the pack and publishes it as a release asset; the hammer workflow uses the newest one.
- **Noise rule and reach in words:** shipped (health list and "Upkeep signals" tab; `describeReach`).
- **Next:** maintainer → org → funder graph (npm packuments, GitHub `fundingLinks`, Open Collective); more labelled compromises for the model (below).

### Features, model and backtest gate (branch `data-ml/model`, 2026-10-07)

**Built:**
- **Shared as-of feature module** (`src/features/asof.ts`). It turns a packument and a release into 40 features: release cadence and dormancy, same-day multi-major releases, backports, the publisher's history and tenure, trusted publishing, provenance (and its share in earlier releases), per-version maintainer changes, new install hooks and risky flags, dependency churn, young dependencies, and optional Scorecard, dependents, downloads and typosquat distance. Missing values are NaN.
  - **No leakage.** Only versions and `time` entries up to `asOf` are read. Today's packument-level fields (`maintainers`, `dist-tags`, `modified`), `deprecated`, the registry's `hasInstallScript` and the replay notes are never read.
  - **Stable over time.** Every feature is measured relative to the release, so a vector does not change after it is computed.
  - **Tested on the replay data.** For all 270+ recorded releases, three inputs give the same vector: a registry snapshot at `asOf`, the packument plus a later malicious release, and a scan a year later.
  - **One code path.** `npm run features` (`src/features/cli.ts`) emits JSONL. The bootstrap uses it and nothing else to compute features.
- **TypeScript evaluator** (`src/model/gbdt.ts`, `bundle.ts`).
  - It reads LightGBM `dump_model` JSON. It handles numerical splits, `missing_type` None/Zero/NaN with `default_left`, and the binary sigmoid. Categorical splits are refused.
  - Isotonic calibration uses table lookup with clipping, as sklearn does.
  - The bundle is tied to the feature schema and its feature order, and a mismatch is refused.
- **Bootstrap scripts** (`pack/model/`, Python with pinned `requirements.txt`): `fetch_packuments.py`, `universe.py`, `build_dataset.py`, `train.py` and `known_bad.py`.
  - **Training:** LightGBM with depth 3 and class weights. Isotonic calibration is fitted on out-of-fold predictions grouped by incident and package.
  - **Threshold:** the F2-best value on training data only.
  - **Parity check:** the TS evaluator must match LightGBM to within 1e-6, or the run fails.
  - **Workflow:** `test/hammer/ci/train.yml` is for the private repo and is not wired up. It publishes the model only when the gate passes.
- **Backtest gate** (`npm run model:gate`, `test/model/gate.ts`).
  - **Recall:** recorded compromises, scored at release + 1 h.
  - **Noise:** findings per Acme org repo, both at each pinned release and on a fixed scan day.
  - **Baseline:** the noisy-OR on the same packuments.
  - **Pass rule:** strictly better on held-out recall and on noise. Pareto dominance is reported but does not pass the gate.

**Local run** (registry.npmjs.org only; report in `blastradius/pack/model/reports/2026-10-07-local.md`):

- **Dataset.** 1,019 packages: the incident packages, plus negatives found by walking dependencies out from the Acme lockfiles. The 1,733 control packages are never trained on. That gives 140,153 releases. Train: before 2023, 37,286 releases, 10 positives from 4 incidents. Test: 102,867 releases, 6 positives (chalk/debug, eslint-config-prettier, nx). All 16 labelled releases were kept. 3 packages returned 404 and were dropped.
- **Parity.** 105,167 rows. The largest difference is 0 on raw scores and 2.8e-17 on probabilities.
- **Model quality.**

  | | ROC AUC |
  |---|---|
  | Training split (in-sample) | 0.999 |
  | Out-of-fold, by incident | 0.50 |
  | Held-out test | 0.33 |

  A variant with monotone constraints did no better. The top features by gain are cadence features, so the model memorises packages rather than attack patterns.
- **Gate: FAIL.**

  | Measure | Model | Noisy-OR |
  |---|---|---|
  | Held-out recall | 0/6 | 4/6 |
  | Noise per repo, scored at each release | 23.2 | 95.7 |
  | Noise per repo, scanned on 2026-10-07 | 23.2 | 10.8 |

  **The model is not wired into scoring. The hand-set weights stay.**
- **Why.** Ten positives from four campaigns, each with a different signal (new publisher, new install hook, new dependency, protestware), cannot teach a pattern that transfers to a new campaign. The data is the bottleneck, not the code.
- **Found on the way.** With the full live history, chalk 5.6.1 is **not** a publisher change: qix has published chalk since 2016. The proof run's early warning for chalk comes from the trimmed replay packument. Live, the noisy-OR misses chalk 5.6.1 as well, so held-out recall is 4/6, not 5/6.

### Dataset with network access (2026-10-08, data first, audited)

Report: `blastradius/pack/model/reports/2026-10-08-dataset.md`. Manifest (labels, negative package lists, every input's URL, commit or SHA-256): `blastradius/pack/model/manifest/`. The dataset itself (about 14 MB gzipped) is not committed; the report lists the commands that rebuild it.

- **Positives: 5,136 compromised releases of 2,096 packages in 55 campaigns** (was 16 releases from 7 incidents). Sources: the OSV npm export (MAL-* and CWE-506 GitHub advisories), tstromberg/supplychain-attack-data (Apache-2.0, 1,157), the incident KB (56) and the replay incidents (15).
  - **Rule** (`labels.py`): the package had at least one release not called malicious and 90 days of history before its first bad release, read from the packument `time` map (npm keeps it for unpublished versions). Records whose versions span more than 30 days are affected ranges (e.g. fsevents < 1.2.11), not compromises at publish time. Packages with more than 10 bad versions, most still live, are package-level classifications. Every drop is listed with its reason.
  - **Attacker-owned packages** (audit): a positive cited only by OSV must not jump majors like dependency confusion (0.x → 99.99.99; 40 dropped), and when no record text describes a compromise it needs 10 clean earlier releases and an unpublished bad release (130 dropped: automated scanner verdicts on squats, spam and still-live packages).
  - **Campaigns:** supplychain-attack-data ids merged into families by campaign marker (TeamPCP, Sha1-Hulud "Second Coming", Shai-Hulud 2025-09, Miasma, the npnjs and npmjs.help phishing waves), OSV records whose text names a marker (the 2026-03-20 CanisterWorm wave is now TeamPCP, not a separate group), KB and replay ids, and OSV-only positives joined to a named campaign within 2 days or chained in time. Train: 25 campaigns, 1,584 positives, 1,389 of them from the two Shai-Hulud worm waves. Test: 30 campaigns, 3,552 positives, 2,945 from TeamPCP.
  - **5,021 of the positives have no manifest** (npm unpublished them). Their features come from the history before them (`allowMissingManifest`), with the 18 manifest features NaN. The 17 manifests the replay overlay rebuilt from advisories are no longer used (`--no-reconstructed`): their publisher, maintainers, scripts and dependencies are partly guesses (nx 21.5.0's lacks the real postinstall).
- **Negatives: 138,014 releases** (sampled by at most 12 per package and year, using a hash): the dependency walk from the Acme lockfiles, the hammer control repos' lockfiles at their pinned commits, and the positive packages' own clean releases. Known-bad versions, whole-package malware and the Acme lockfile packages (the gate's noise set) are excluded, and so are unpublished releases of a positive package within 7 days of one of its positives (458 candidates: no source lists them, but npm removed them during the attack).
- **External features.** Downloads are real and as of the release: `api.npmjs.org` range history, using the week ending two days before the release (`downloads_weekly_log10` and `downloads_trend`), with 100% coverage. Scorecard, deps.dev dependents and typosquat distance have no history here, so they stay NaN on every row.
- **Schema v3:** `bump_kind` compares with the previous version in the `time` map, not the previous version that still has a manifest (which release npm later unpublished is hindsight).
- **Audit (2026-10-08).** Leakage: the feature code reads only `time` entries and manifests up to the release; downloads end two days before the release day. Ten positives (one per large campaign plus three small ones) were recomputed by hand from live registry.npmjs.org packuments and api.npmjs.org: release time, prior releases, releases in the previous 24 h, days since the previous release and weekly downloads matched in all ten. Two of those ten were attacker-owned packages (okxweb3 99.999.999, eslint-plugin-i18n-scan 11.0.6), which led to the label rules above.
- **Warnings for the model step** (quantified in the report):
  - **Manifest missing.** The manifest features are NaN on 98% of positives and under 1% of negatives. Train the history-only variant with them masked on all rows; the `manifest` and `origin` row fields must never be inputs. Training only on rows with a manifest is not viable (15 training positives).
  - **Sampling bias.** Negatives come from popular packages. Weekly downloads alone give AUC 0.28 on the training split, but 0.47 within the positive packages (their own clean releases against their bad ones), so that signal is how the negatives were chosen, not the attacks.
  - **Time confound.** Within the positive packages, `package_age_days` still gives AUC 0.80, because the positives cluster in 2025 while the clean releases spread back to 2016. Match negatives to the positives' time window, or weight by year, before trusting age, release counts or cadence.
  - **Remaining skew.** `prev_*` and `*_share_prior` read only earlier releases whose manifest survives, so a release that follows an unpublished bad one is compared with an older release than scan time would use.
  - **Residual label noise.** OSV-only positives within 2 days of a named campaign join it even if unrelated (a grouping error, not a label error). Automated MAL verdicts with compromise wording are still trusted.

### Model trained and gated on that dataset (2026-10-08): FAIL, not shipped

Report: `blastradius/pack/model/reports/2026-10-08-gate.md`. Machine-readable results: `2026-10-08-gate.json`.

- **Training** (`train.py --variants`):
  - history-only (the 18 manifest features masked on every row);
  - GroupKFold by campaign;
  - variant chosen on out-of-fold average precision only: history + downloads with a class weight, beating per-year weighting and no downloads;
  - isotonic calibration on out-of-fold predictions, and an F2 threshold of 0.111.
- **Parity** with LightGBM: max difference 2.2e-16 on 25,949 rows.
- **Model quality on the 2026 test split:** ROC AUC 0.923, AP 0.718, recall 49.9% at a 2.7% false-positive rate. Within the positive packages, ROC AUC is 0.896. That is up from 0.33 on 2026-10-07, but the recall is inflated:
  - most test positives are the second or later release of a worm burst, minutes after the first;
  - first bad release per package: 35.5%;
  - where npm still serves the manifest: 26.8%.
- **Top features by gain:** releases in the past year, days since the previous release, downloads trend, package age and weekly downloads. These are cadence and popularity, not the attack itself.
- **Gate** (`npm run model:gate`, now with the dataset test split, download history, the hammer controls at their pinned commits and `--no-reconstructed`):

  | Measure | Model | Noisy-OR |
  |---|---|---|
  | Held-out recall, 100 releases both can score | 16% | 27% |
  | Noise per Acme repo, at release | 14.5 | 95.2 |
  | Noise per Acme repo, scan day | 14.5 | 2.17 |
  | Noise per hammer control, at release | 22.5 | 86.0 |
  | Noise per hammer control, scan day | 22.5 | 11.0 |

  **FAIL** on recall and on scan-day noise. The other two variants fail as well (informational). **Scoring keeps the hand-set weights. The model is not wired in.**
- **Why it fails.** The publisher, install-hook and dependency evidence for the positives was unpublished by npm. With only history features, the model finds worm bursts but not single hijacked releases. It also flags quiet, low-download packages in healthy repos with no time-decay.
- **Caveat.** 495 of the 1,184 control packages were training negatives, so the model's control noise is optimistic. The Acme packages were never trained on.

**Still needed:**
- **Manifests for unpublished bad releases** (registry mirror or the replicate.npmjs.com changes feed). This is the main blocker for the model.
- **Train and evaluate on the first bad release per package,** so worm bursts do not dominate. Sample negatives matched to the positives' popularity and year.
- **Choose the threshold with a noise objective** on held-out healthy repos.
- **As-of history for Scorecard and dependents.** For example, deps.dev BigQuery snapshots. Until then, those features stay NaN.

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
