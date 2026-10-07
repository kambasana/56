# Blastradius data and model design (knowledge pack)

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

## 4. Deliverables

- **Bootstrap scripts:** `blastradius/pack/` (collect, normalise, resolve, features, label, train in Python, export, backtest) and a `pack` workflow for the private repo.
- **Engine:** pack loader, a scan-time lookup path, the shared TypeScript feature module, and a tree evaluator.
- **Scoring:** the three layers above, replacing the hand-set weights once the gate passes.
- **Reports and UI:**
  - reach in words;
  - a "who's behind it" chain with evidence;
  - a health column;
  - per-role views (leadership summary, AppSec triage, developer "my repo").
- **Hammer:** a backtest report in the run, plus real-repo checks that the chains and reach appear.
