# Blastradius quality system: pipeline, data quality, metrics, scoring and self-improvement

Status: design, 2026-10-12. Builds on what exists in `docs/WHO-BEHIND-PLAN.md` §4, §10 and §11 and
on the teardown findings. It answers one question: **how do we know an answer is right, and how
does it get more right over time?**

Principle: every number we show is a **fact with a source**, or a **rule over facts** whose
reasons are listed. We measure each rule against ground truth, and we only change a rule when the
measurements say the change is better. No opaque scores and no self-training in production.

---

## 1. The pipeline (one path for CLI, web and the GitHub Action)

```
 lockfiles / SBOM            ┌──────────── checks at every arrow (§2) ────────────┐
       │
 1 INGEST     → inventory: components, versions, dependency graph, ONE scope per (project, package)
 2 COLLECT    → deterministic collectors: registries (npm, PyPI, …), deps.dev, OSV, Scorecard,
                Open Collective / FUNDING.yml, git history (blobless clone), GitHub API (token)
 3 FACTS      → typed, normalised facts: value · source · evidence URL · observedAt · validFrom/To
                · method (deterministic | registry | agent:<task>) · confidence · TTL
 4 GAP-FILL   → agent pipeline, ONLY for facts still missing; every proposal passes the
                deterministic verification gate (re-fetch, quote match, domain, subject, date)
 5 RESOLVE    → entities: people (salted ids, merged identities), accounts, owners, orgs, funders
 6 DERIVE     → rules: stability labels, licence categories and changes, events, coverage
 7 SCORE      → findings: exposure gate, then factors, then rank (§4)
 8 PRESENT    → web, CLI, HTML, JSON, CycloneDX/SPDX, MCP server for Claude Code, PR comments
 9 FEEDBACK   → user verdicts and external events flow back as labels (§5)
```

Every run has a **run id**. Every fact, label and finding records the run id, the rule version
(for example `stability-rules@2`) and the source versions it came from (**lineage**). So any
answer can be explained ("why does it say Fragile?") and reproduced ("what did we say on
1 March?"). Facts are **bitemporal**: when it was true, and when we saw it. That is what makes
backtests exact (§5.3).

What exists today: stages 1–8 exist, with per-source coverage, rule versions in `rules.ts` and
`weights.ts`, and the replay and backtest tooling (`test/replay`, `test/backtest`). What is new
below: the invariant checks as a runtime stage, the canary job, the metrics store, the feedback
capture, the evaluation harness and the corrections KB.

---

## 2. Data quality checks

Checks run **inside the pipeline**, not only in tests. Each check is either **blocking** (the
item is quarantined and the coverage banner says so) or **warning** (shown, counted, alerted).

| Stage | Check | Kind | Example it catches |
|---|---|---|---|
| Ingest | Only lockfile-resolved versions become components; unresolved → one warning per manifest | blocking | 0.0.0 placeholders (teardown #8) |
| Ingest | Unsupported manifests listed as NOT ANALYSED; `--strict` fails | blocking | Python read as clean (teardown #2) |
| Collect | Per-source status ok / partial / failed, latency, rate limit, record counts | warning (security sources: blocking under `--strict`) | OSV skipped behind a proxy |
| Facts | Schema validation per fact type; evidence URL required; no person-level field outside the allowed types | blocking (quarantine) | a fact with no source |
| Facts | Freshness: TTL per fact type (advisories 1 day, maintainers 7 days, funding 30 days, licences 30 days) | warning, re-fetch | stale deprecation state |
| Facts | URL hygiene: funding/sponsor URLs never treated as repos; current repo resolved from the latest release | blocking | Sponsors URL cloned; moved repos (teardown #3) |
| Gap-fill | Verification gate: re-fetch, quote present, allowed domain incl. redirects, subject named, date matches, schema, privacy | blocking | wrong-subject quote; wrong date (open gap, fix queued) |
| Resolve | Unknown owner type never treated as an org; `reviewed` only after a human decision | blocking | personal accounts as orgs (teardown #7) |
| Derive / score | **Invariants**: one scope per package across all views; counts reconcile (home = overview = list); labels read no per-person field; maintainer change alone is never a top reason; no finding at an unresolved version | blocking in CI, alert at runtime | three different "production" answers (teardown #1) |
| Between scans | **Drift guard**: if a label or finding count jumps more than a set share (for example >15 % of a project's production packages change label in one scan) without an inventory change, hold the alerts and flag "possible source problem" | warning, alerts held | a source outage turning 50 packages Ended |
| Nightly | **Canaries**: a fixed set of packages with known answers is scanned live (left-pad Fragile ended, express Steady, request deprecated, proxy-addr CVE at #1 on the pinned parse-server lockfile, debug's maintainers) | alert if any differs | a registry or API change breaking a collector |

The cross-source agreement rule: when two sources disagree (deps.dev vs ClearlyDefined vs the
registry; repo URLs from npm vs deps.dev), we never pick silently. We show both, flag the
disagreement, and count disagreement rates per source pair as a metric.

---

## 3. Metrics (what we measure, how, and the targets)

### 3.1 Accuracy metrics per rule (the ones that matter most)

| Metric | Definition | How it is measured | Target |
|---|---|---|---|
| **Precision** | share of the rule's positive outputs that are correct | (a) user verdicts; (b) a monthly random hand-review sample of 30 per rule against primary sources; (c) the golden set | ≥ 95 % for Fragile and alerts; ≥ 90 % for Watch |
| **Early-warning recall** | share of real events (compromise, takeover, deprecation, relicensing) the rule flagged before the event was public | time-travel backtests on the event log (§5.3) | tracked, and must never drop |
| **Lead time** | days between our signal and the public advisory or announcement | backtests | tracked |
| **Coverage** | share of production packages with a non-Unknown label, per ecosystem | every scan | ≥ 90 % |
| **Noise** | alerts per repo per week, and events per scan | every scan, web history | ≤ 5 per repo per week |

Tier 0 targets are the first instances of these: under 5 % false Ended, under 5 takeover items per
repo, under 10 % Unknown, top 10 all production, 0 findings at 0.0.0.

### 3.2 Source metrics
Availability, latency, freshness, record counts, rate-limit hits and disagreement rate, per
source per day.

### 3.3 Agent pipeline metrics
Acceptance rate, audited false-accept rate (a hand-checked sample of accepted facts each month),
false-reject rate, cost and latency per verified fact, share of facts still pending human
confirmation.

### 3.4 Product metrics
Time to the exposure answer (target: under 1 s on an indexed estate), scan time warm and cold,
share of findings with a user verdict, and share of alerts acted on.

All metrics are written to a **metrics store**, one table keyed by date, rule version and
source, so trends and regressions are visible.

---

## 4. Scoring (how ranking works, and how it stays honest)

There are two different outputs, and they are kept apart.

1. **Labels** (Fragile / Watch / Steady / Unknown; licence category; events). These are pure
   rules over facts (`src/stability/rules.ts`, `label.ts`). Each label lists the rules that fired
   and each fact's source and confidence. Low-confidence-only evidence is capped at Watch. These
   are what most users read.
2. **Findings ranking** (what to look at first). These are ranked in three steps
   (`src/scoring/`):
   - **Gate:** scope and severity first. A runtime advisory with CVSS ≥ 9 and a fix outranks
     anything dev-only. Known malicious releases rank with runtime in any scope, because they run
     at install time.
   - **Factors:** the evidence factors are combined by noisy-OR into a 0–1 risk. Posture factors
     (Scorecard, provenance, single maintainer) are tie-breakers only and decay over time.
     Maintainer change alone is context.
   - **Exposure:** production reach across the estate orders items within the same gate tier.

How scoring changes safely:
- Weights and thresholds live in versioned files (`weights.ts`, `rules.ts`). Every output records
  the version.
- A change is a PR that must include the **evaluation report** from the harness (§5.4): metric
  before and after on the golden set and the backtests. CI blocks it if precision or recall gets
  worse beyond a tolerance.
- **Calibration, later:** once there are enough labelled outcomes (several hundred real verdicts
  and events), we fit the factor weights offline (logistic regression first, gradient-boosted
  trees only if they beat it on a time-split hold-out). The rules stay as the explanation layer.
  A new model runs in **shadow mode** first: computed and logged, not shown, until it beats the
  current version on the same data. This is the lesson from the Laya experiment: measure before
  adopting.

---

## 5. Self-improvement: the learning loop

```
  outputs ──► capture labels ──► evaluate ──► propose change ──► gate ──► release ──► outputs
              (§5.1, §5.2)        (§5.4)       (§5.5)             (CI +     (versioned)
                                                                  human)
```

### 5.1 Capture human labels
- On every label, finding, event and agent fact: **Correct · Wrong · Not relevant**, plus a reason
  from a short list (moved repo, bot, same person, wrong version, dev only, already handled,
  other) and optional text.
- Stored with the run id and the rule version, so the verdict is tied to exactly what was shown.
- Only reviewer roles' verdicts count toward metrics. One customer's verdicts are weighted so they
  can't dominate shared corrections (poisoning guard).
- Privacy: verdicts about a person-level fact are visible only to manage_projects and are kept
  with the same retention rules as the fact.

### 5.2 Capture ground truth from the world (delayed labels)
External events are recorded in an **event log**, with dates and sources:
- OSV `MAL-*` entries and GitHub malware advisories;
- npm deprecations and repository archive flags;
- relicensing announcements;
- incident write-ups (from the issues KB, P5);
- maintainer handovers.
These become labels after the fact ("this package really did end on this date"). They need no
human, so they also make the loop work before we have customers.

### 5.3 Backtests (time travel)
- For every event in the log, replay the scan **as of the day before**, using bitemporal facts
  and the cached history, and record whether each rule flagged it and with what lead time.
- They run monthly over the whole log, and on every rule-change PR over a fixed backtest set.
- The existing `test/backtest` and `test/replay` tooling and the account-proof replays are the
  starting point. They already show, for example, 11 of 16 early warnings on the proof set.

### 5.4 Evaluation harness
One command that runs the current or proposed rules over:
- the **golden set**: every hand-checked row so far, the §8 subjects, the teardown cases and the
  Tier 0 / 0.5 acceptance rows, with real recorded data;
- the **backtest set** (§5.3);
- the **verdict set** (§5.1).

It outputs a report: precision, recall, lead time, coverage and noise per rule, with before/after
diff tables. This report is attached to every rule-change PR, and CI fails on regression.

### 5.5 What actually improves, and how
| Learner | What changes | How | Who approves |
|---|---|---|---|
| **Corrections KB** | facts: moved repos, release bots, identity merges, org types, funding direction | a "Wrong" verdict with a reason proposes a correction; a reviewer accepts it; it applies deterministically everywhere (shared across customers only if opted in) | reviewer |
| **Threshold tuning** | rule thresholds (for example the CAF window, inactive months, the small-package size) | the harness searches within bounded ranges and proposes the best setting with its metric diff | human, via PR |
| **Source trust** | how much each source and domain is trusted | disagreement and false-accept rates per source | automatic within bounds, reported |
| **Agent prompts and domains** | task prompts, allowed domains, validators | false-accept and false-reject cases become new gate tests first, then fixes | human, via PR |
| **Calibrated ranker** (later) | factor weights | offline fit, shadow mode, time-split evaluation | human |

Nothing changes production behaviour without a versioned release that passed the harness. That is
what "self-improving" means here: the system **proposes** improvements from evidence, and the
gate makes sure they really are improvements.

---

## 6. Analytics

- **Internal (quality) dashboards:** precision, recall and noise per rule over time; source
  health; coverage by ecosystem; agent acceptance and cost; drift alerts; canary results.
- **Customer analytics:**
  - estate trends: Fragile and Watch over time, concentration ("these 120 packages rely on 9
    people"), funding coverage, licence decisions;
  - time to act on alerts;
  - which teams own which risks.
  Built from the stored scans (time series), aggregated by default, with person-level detail only
  for manage_projects.
- Every chart number links to the filtered list behind it.

---

## 7. Where the checks run

| Where | What |
|---|---|
| Every commit (CI) | unit tests; gate tests on recorded real data; privacy and invariant tests; a fresh-worktree check that every fixture is committed; the golden set and fixed backtests through the harness; e2e with axe |
| Every scan (runtime) | source coverage, schema and evidence checks, invariants, drift guard, NOT ANALYSED banner, `--strict` |
| Nightly | live canaries; source health; freshness re-fetch |
| Monthly | full backtest over the event log; hand-review sample of 30 per rule; audited sample of agent facts; metrics report |

---

## 8. Build order

| Step | What | Effort (estimate) |
|---|---|---|
| Q1 | Run ids and lineage on every output; invariant checks as a runtime stage; drift guard; nightly canary job; metrics store | 1.5–2 weeks |
| Q2 | Feedback capture (API, UI on labels/findings/events/facts); event log from OSV MAL, deprecations, archive flags, KB; evaluation harness with golden + backtest + verdict sets; CI gate on regression | 2–3 weeks |
| Q3 | Corrections KB with reviewer flow; threshold-tuning proposals; quality dashboards | 2 weeks |
| Q4 | Customer analytics; source-trust weighting; monthly review routine | 1.5 weeks |
| Later | Calibrated ranker in shadow mode, once several hundred labelled outcomes exist | 1–2 weeks, then measure |

The agent pipeline's date-match and backer-type checks (open gaps from the live run) are part of
Q1, because the gate is a blocking check.
