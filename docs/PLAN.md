# Supply-Chain Blast Radius Auditor — System Plan

> Working name: **Blastradius**. Status: design / pre-MVP.

## 1. Goal

Given a GitHub repo (or SBOM, container image, or whole org), the system:

1. **Breaks it down** into every component it depends on: packages (direct and transitive), GitHub Actions, base images.
2. **Works out who is behind each component**: maintainers, owning org, funders, and how that has changed over time.
3. **Checks components and entities against known issues**: CVEs, malware, protestware or sabotage ("rug pulls"), account takeovers, compromised CI, abandoned projects.
4. **Calculates the blast radius**: how far a problem in any component spreads into your apps, CI and production, and outward to everyone who depends on you.
5. **Explains every score** with sourced evidence, so an auditor can defend each finding.

Two views of blast radius:

| View | Question | Example |
|---|---|---|
| **Inbound** | "What risk am I inheriting?" | `lib-x` → maintainer changed 9 days ago → reached by 3 of your direct deps → runs an install script in CI where `NPM_TOKEN` exists |
| **Outbound** | "If this repo is compromised, who gets hit?" | Your action is used by 4,100 repos, isn't pinned, and has a `pull_request_target` workflow |

### Non-goals
- Not a vulnerability scanner of its own. Use OSV, Scorecard and others.
- No scoring by where contributors live or what nationality they are. Score on behaviour and documented links only.
- Never execute third-party code while analysing it.

---

## 2. Architecture

```
                ┌─────────────────────────── Inputs ───────────────────────────┐
                │  repo URL · GitHub org · SBOM (CycloneDX/SPDX) · OCI image   │
                └──────────────────────────────┬────────────────────────────────┘
                                               ▼
  ┌──────────────────────────── 1. Ingest & Inventory ────────────────────────────┐
  │ shallow clone (no code exec) → Syft / cdxgen → CycloneDX                       │
  │ + parse .github/workflows (uses: owner/action@ref) + Dockerfile FROM           │
  │ → normalise to purl, build dependency edges (direct/transitive, prod/dev/build)│
  └──────────────────────────────────────┬─────────────────────────────────────────┘
                                         ▼
  ┌──────────────────────────── 2. Enrichment workers (queue) ────────────────────┐
  │ vulns · malware · health · registry metadata · source repo · funding ·        │
  │ downstream dependents · behaviour heuristics      (each cached with a TTL)    │
  └──────────────────────────────────────┬─────────────────────────────────────────┘
                                         ▼
  ┌──────────────── 3. Entity resolution ────────────┐   ┌── 4. Incident KB ─────┐
  │ registry accounts ↔ GitHub logins ↔ orgs ↔       │◄──┤ curated YAML in git,  │
  │ funders, each link with confidence + evidence    │   │ sourced, reviewed     │
  └──────────────────────────────┬───────────────────┘   └───────────────────────┘
                                 ▼
  ┌──────────────────────────── 5. Knowledge graph (Postgres) ────────────────────┐
  │ Asset → Package@ver → Package → Maintainer/Org/Funder → Incident              │
  └──────────────────────────────────────┬─────────────────────────────────────────┘
                                         ▼
  ┌──────────────────────────── 6. Risk & blast-radius engine ────────────────────┐
  │ intrinsic risk + inherited entity risk → propagate across graph → score       │
  └──────────────────────────────────────┬─────────────────────────────────────────┘
                                         ▼
  ┌──────────────────────────── 7. Outputs ───────────────────────────────────────┐
  │ CLI · JSON · SARIF (GitHub code scanning) · HTML report · web dashboard +     │
  │ graph view · GitHub Action (PR gate) · REST API · alerts (continuous monitor) │
  └────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Components in detail

### 3.1 Ingest & inventory
- **Inputs:** repo URL, org (enumerate repos), uploaded SBOM, container image reference.
- **SBOM generation:** Syft (broad ecosystem coverage, images) and cdxgen (better transitive resolution for some ecosystems). Store as CycloneDX 1.6.
- **Also count as components:**
  - GitHub Actions in `uses:` lines, including whether they're pinned to a SHA, a tag, or a branch.
  - Reusable workflows.
  - Docker `FROM` images.
  - Git submodules.
- **Dependency scope:** tag every edge as `runtime`, `dev`, `build/CI` or `optional`, and record whether the package has an **install script**. Install scripts run code at install time, which matters for reach.
- **Safety:** never run `npm install`, `pip install`, builds or tests. Parse lockfiles and manifests statically. Run cloning and parsing in a sandboxed worker with no credentials.

### 3.2 Enrichment workers
Each worker is a plugin with a common interface (`enrich(purl) -> Facts[]`), its own rate limiter, and a cache keyed by purl and TTL.

| Worker | Data | Source |
|---|---|---|
| Vulnerabilities | CVE/GHSA, severity, fix versions | OSV API (batch), GitHub Advisory DB; EPSS and CISA KEV for exploitability |
| Malware | Known malicious packages | OSV `MAL-*` advisories / `ossf/malicious-packages` |
| Health | Scorecard checks, release cadence, archived, signed releases / SLSA provenance | deps.dev API, OpenSSF Scorecard |
| Registry metadata | Maintainers, publish history, **maintainer adds/removes over time**, install scripts, npm provenance | npm registry, PyPI JSON API, crates.io, RubyGems, Maven Central, Go proxy |
| Source repo | Owner type (user/org), contributors, bus factor, last commit, repo transfers, `FUNDING.yml` | GitHub REST/GraphQL |
| Funding | Backers, sponsors, fiscal hosts, corporate sponsors | `FUNDING.yml`, `package.json#funding`, Open Collective GraphQL, GitHub Sponsors GraphQL, ecosyste.ms |
| Downstream | Dependent counts (outbound blast radius) | deps.dev, ecosyste.ms, GitHub dependency graph |
| Behaviour (phase 3) | Obfuscation, network calls in install scripts, typosquats | GuardDog (Datadog), static heuristics, name-distance checks |

**Snapshotting:** store registry and repo metadata as dated snapshots so the system can detect *changes*, such as "new maintainer added 2 days before a release" or "repo transferred to a new owner". Changes are often the strongest attack signal.

### 3.3 Entity resolution
Goal: one node per real-world actor, linking accounts across systems.

- **Entity types:** `Person`, `Organization`, `Funder` (an organisation in a funding role), `Account` (registry or GitHub handle).
- **Deterministic links (high confidence):**
  - A registry package's `repository` field points to a GitHub repo.
  - A GitHub org lists the maintainer as a member.
  - A verified domain email.
  - Open Collective lists a GitHub account.
- **Probabilistic links (lower confidence):** matching names or emails across registries, similar handles. These need a reviewer before they're used in scoring.
- Every link stores `confidence (0–1)`, `evidence_url[]`, `method`, `reviewed_by`, `first_seen`.
- **Review queue:** probabilistic links under 0.8 confidence go to a human queue and don't affect scores until they're confirmed.

### 3.4 Incident knowledge base
This is the core asset, so treat it like code.

- Stored as **YAML files in a git repo** (`incidents/2024-xz-utils.yaml`), changed through pull requests and review.
- Schema:

```yaml
id: INC-2024-0001
title: xz-utils backdoor
type: maintainer_infiltration   # see type list below
status: confirmed               # confirmed | alleged | disputed | retracted
date: 2024-03-29
severity: critical
affected:
  - purl: pkg:generic/xz-utils
    versions: ["5.6.0", "5.6.1"]
entities:
  - ref: account:github/JiaT75
    role: perpetrator
    confidence: 0.99
evidence:
  - https://www.openwall.com/lists/oss-security/2024/03/29/4
  - https://nvd.nist.gov/vuln/detail/CVE-2024-3094
reviewed_by: [alice, bob]
```

- **Incident types:** `malware_publish`, `account_takeover`, `maintainer_sabotage` (protestware or rug pull), `maintainer_infiltration`, `malicious_handover`, `ci_compromise`, `domain_or_name_takeover`, `typosquat`, `abandonment`, `crypto_rugpull`, `sanctions` (sanctions only from official lists such as OFAC).
- **Seed set:**
  - event-stream (2018)
  - ua-parser-js (2021)
  - Codecov (2021)
  - colors.js and faker.js (2022)
  - node-ipc (2022)
  - xz-utils (2024)
  - polyfill.io (2024)
  - tj-actions/changed-files (2025)
  - chalk/debug npm phishing (2025)
  - plus every OSV `MAL-*` entry imported automatically as `malware_publish`
- **Rules:**
  - No entity link without at least one public source.
  - `alleged` incidents count for less in scoring.
  - Anyone can file a dispute, and a disputed incident stops counting until it's resolved.

### 3.5 Knowledge graph (data model)
Start with **Postgres** using recursive CTEs, with in-memory graph analysis in `networkx`. Move to Neo4j only if query patterns call for it.

Core tables:

| Table | Key columns |
|---|---|
| `asset` | id, kind (repo/image/org/app), name, criticality (1–5), environment (prod/staging/dev) |
| `component` | purl (unversioned), ecosystem, name, source_repo |
| `component_version` | purl@version, published_at, has_install_script, provenance |
| `dep_edge` | from (asset or version), to (version), scope, direct (bool), path_depth |
| `entity` | id, type, display_name |
| `account` | platform, handle, entity_id |
| `entity_link` | from, to, relation (maintains/owns/funds/member_of), confidence, evidence[], reviewed |
| `incident` / `incident_entity` / `incident_component` | mirrored from the YAML knowledge base |
| `fact` | subject, kind, value (jsonb), source, fetched_at, ttl |
| `snapshot` | subject, taken_at, payload (jsonb), used for change detection |
| `finding` | asset, component_version, score, blast_radius, reasons (jsonb) |

### 3.6 Risk and blast-radius engine

**Step 1 — Intrinsic risk of a component version**, combined with noisy-OR so independent signals add up without going above 1:

```
intrinsic(p) = 1 − Π (1 − wᵢ · fᵢ(p))
```

| Factor fᵢ | Signal | Weight (initial) |
|---|---|---|
| Malware | Known `MAL-*` / incident `malware_publish` | **override → 1.0** |
| Exploitable vuln | CVSS × EPSS, ×1.5 if in KEV | 0.6 |
| Recent maintainer/owner change | Days since change, decays over 90 days | 0.5 |
| Install script present | Boolean, raised if obfuscated or makes network calls | 0.3 |
| Weak posture | 1 − Scorecard/10 | 0.3 |
| No provenance / unsigned | Boolean | 0.15 |
| Single maintainer / low bus factor | Boolean | 0.15 |
| Abandoned | No release or commit in 2 years and has open vulns | 0.2 |

**Step 2 — Inherited entity risk**, which carries the "funded by X who rug-pulled" logic:

```
entity_risk(p) = max over paths  p → e₁ → … → eₙ → incident
                 of   severity(inc) · status_weight(inc) · Π confidence(link)
                      · age_decay(inc) · hop_decay(n)
```
- `status_weight`: confirmed 1.0, alleged 0.4, disputed or retracted 0.
- `hop_decay`: 1.0 for a direct maintainer, 0.5 for the org, 0.25 for a funder of the org. Limit to 3 hops.
- `age_decay`: half-life of about 3 years, so old incidents fade but never fully disappear.

**Step 3 — Combined risk:** `risk(p) = 1 − (1 − intrinsic(p)) · (1 − entity_risk(p))`

**Step 4 — Inbound blast radius** of a risky component for your estate:

```
blast_in(p) = risk(p) · Σ over assets a reaching p:
              criticality(a) · exposure(scope of path) · reach_multiplier
```
- `exposure`:
  - runtime/prod 1.0
  - build/CI 0.8 (secrets live there)
  - install script anywhere 0.9
  - dev-only 0.3
  - optional 0.2
- `reach_multiplier`:
  - ×1.2 if the CI context has write tokens, OIDC `id-token: write` or publish secrets
  - ×0.7 if the component is pinned by hash and vendored

**Step 5 — Outbound blast radius**, for repos and packages you publish:

```
blast_out(repo) = compromise_likelihood(repo) · log10(1 + downstream_dependents) · publish_reach
```
`compromise_likelihood` comes from the risky-workflow and posture checks (zizmor, poutine, Scorecard), and `publish_reach` covers whether CI publishes to npm/PyPI/containers or deploys.

**Explainability:** every score stores `reasons[]`, each with a factor, value, weight, contribution and evidence URLs, plus the dependency path(s) from asset to component. Reports always show *why*, not just a number.

**Calibration:** the weights above are starting guesses. Tune them against the backtest set (§6).

### 3.7 Outputs
- **CLI:** `blastradius scan <repo|sbom|image> [--format json|sarif|html]`
- **GitHub Action:** runs on PRs and **fails or comments when a PR adds a dependency** whose risk is above a threshold, showing the before/after diff of the blast radius.
- **SARIF:** upload to GitHub code scanning.
- **HTML report:** a single file for auditors, with a summary, the top 20 findings, and evidence.
- **Web dashboard:**
  - org-wide view: risk by asset, top shared risky components
  - interactive graph (Cytoscape.js): asset → deps → maintainers → funders → incidents
  - time-travel view: risk at date X
- **REST API:** for integrations (Jira, Slack, SIEM).
- **Continuous monitoring:** watch tracked packages for new versions or maintainer changes, plus new OSV/incident entries, and alert on any change to a finding's score.

---

## 4. Tech stack (recommended)

| Layer | Choice | Why |
|---|---|---|
| Core language | **Python 3.12** | Fast iteration, good graph and data libraries. Call Go tools (Syft, osv-scanner, scorecard) as CLIs |
| API | FastAPI | Typed, async, auto OpenAPI |
| Queue / workers | Redis + RQ (or Celery) | Enrichment is I/O-bound and rate-limited |
| DB | Postgres 16 (+ jsonb) | One store for graph, facts and snapshots |
| Graph analysis | networkx | Propagation, path finding |
| Frontend | React + Cytoscape.js | Graph view |
| Packaging | Docker Compose (dev), container image + Helm (prod) | |
| CI | GitHub Actions, pinned by SHA, with zizmor run on its own workflows | Hold this tool to the standard it checks for |

---

## 5. Repository layout

```
blastradius/
├── cli/                  # entrypoint
├── ingest/               # sbom generation, workflow/Dockerfile parsers, purl normaliser
├── enrich/               # one module per worker: osv.py, depsdev.py, npm.py, pypi.py, github.py, funding.py ...
├── entities/             # resolution, linking, review queue
├── incidents/            # loader + validator for the YAML KB
├── graph/                # db models, queries, networkx builders
├── scoring/              # intrinsic, entity, propagation, blast radius, explanations
├── report/               # json, sarif, html renderers
├── api/                  # FastAPI app
├── web/                  # React dashboard
├── action/               # GitHub Action wrapper
kb/
└── incidents/*.yaml      # curated incident database (separate repo later)
tests/
├── unit/
├── fixtures/             # recorded API responses
└── backtest/             # historical incident replays
docs/
```

---

## 6. Validation: prove it works

1. **Backtesting (main test).** For each historical incident, rebuild the dependency and metadata state from **just before** the attack (from snapshots, registry history and archived data) and check whether the tool would have flagged it.
   - event-stream: new maintainer before a malicious release → should flag the maintainer change
   - ua-parser-js: account takeover → publishing anomaly
   - xz-utils: new co-maintainer, release pattern change
   - tj-actions: unpinned action with high downstream count → high outbound blast radius
2. **Precision check.** Run on about 200 popular, healthy repos and measure how much it flags. Target fewer than 5% of direct deps flagged as high.
3. **Golden reports.** Hand-audit 10 repos and compare the results.
4. **Track metrics:** recall on the backtest set, false-positive rate, scan time per 1,000 deps, API calls per scan.

---

## 7. Legal, ethical and safety guardrails

- **Personal data (GDPR and similar):**
  - Maintainers are individuals, so record a legitimate-interest assessment.
  - Store only public professional data.
  - Set a retention policy.
  - Provide a route for people to object or ask for correction.
- **Defamation risk:**
  - Every claim about a person or org needs a public source and a stated status.
  - Wording is factual ("linked to incident INC-2024-0001 (confirmed)"), never a judgement ("malicious funder").
  - Publish a dispute process.
- **No profiling by nationality or ethnicity.** Sanctions data comes only from official lists such as OFAC, matched on legal entities.
- **Responsible disclosure:** if a scan finds an exploitable issue in a third party's repo, report it privately to the maintainer or through GitHub private vulnerability reporting. Never publish it in a report first.
- **API terms of service:** respect GitHub, registry and deps.dev rate limits. Use authenticated tokens, back off on errors, and cache heavily.
- **Tool security:**
  - The tool reads untrusted repos, so never execute their code.
  - Run workers sandboxed with no credentials.
  - Lock down the tool's own supply chain (pinned deps, signed releases, SLSA provenance).

---

## 8. Delivery phases

| Phase | Scope | Exit criteria | Rough effort (1–2 devs) |
|---|---|---|---|
| **0. Foundations** | Repo scaffold, CI, Postgres schema, purl normaliser, plugin interface, recorded-response test fixtures | `blastradius scan` produces an inventory JSON for an npm repo | 1–2 weeks |
| **1. MVP (npm only)** | Syft SBOM, Actions parsing, OSV + malware, deps.dev + Scorecard, npm registry maintainers + install scripts, intrinsic scoring, inbound blast radius, JSON/HTML/SARIF, ~15 seed incidents | Backtest catches event-stream and ua-parser-js; scans a 1k-dep repo in under 5 min | 4–6 weeks |
| **2. Who's behind it** | Snapshots + change detection, GitHub owner/contributors, funding sources, entity resolution + review queue, entity-inherited risk, incident KB as YAML + validator | Report shows maintainer → org → funder → incident chains with evidence | 4–6 weeks |
| **3. Breadth** | PyPI, Maven, Go, crates; container images; GuardDog behaviour checks; typosquat detection; outbound blast radius (zizmor/poutine + dependents) | Backtest recall ≥ 70% across ecosystems | 6–8 weeks |
| **4. Product** | Web dashboard + graph view, org-wide scans, GitHub Action PR gate, continuous monitoring + alerts, API, auth | Org of 100 repos scanned nightly; alerts within 1 hour of a maintainer change | 6–8 weeks |
| **5. Ongoing** | KB curation, weight calibration, community contributions, dispute handling | Monthly calibration review | continuous |

---

## 9. Main risks to the project

| Risk | Mitigation |
|---|---|
| Too many alerts, so users ignore them | Reachability weighting, a strict default threshold, PR-diff mode (show only *new* risk) |
| Wrong entity links damage trust or bring legal trouble | Confidence thresholds, human review, sources required, dispute flow |
| API rate limits on large orgs | Aggressive caching (most packages are shared across repos), batch endpoints, token pools within terms of service |
| Historical data needed for backtests is missing | Start snapshotting on day 1; use archive.org and registry version history where available |
| Building the KB takes a lot of effort | Auto-import OSV `MAL-*`; accept community PRs; keep curation focused on high-impact incidents |
| Overlap with commercial tools (Socket, Lineaje, Endor) | Differentiate on being open, explainable, and modelling entities/funders, and integrate with existing scanners rather than competing with them |

---

## 10. Open decisions

1. **Open-source or commercial?** This affects licensing and whether the incident KB is public.
2. **First ecosystem:** npm is recommended because it has the most incidents and the richest metadata.
3. **Delivery model:** CLI/Action first (recommended) or hosted SaaS first.
4. **Language:** Python (recommended for speed of building) or Go (matches the ecosystem's existing tools, single binary).
5. **Scope of "rug pull":** OSS maintainer sabotage only, or also crypto/DeFi token rug pulls? The second needs on-chain data sources and is effectively a separate module.
