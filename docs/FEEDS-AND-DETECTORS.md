# Feeds and detectors: reuse what exists, own the blast radius

**Decision (2026-10-08).** Blastradius stops training its own "next compromise" model. Detection comes from established feeds and detectors. We build and own what nobody else provides: an org-wide answer to *are we hit, where, who brought it in, and who's behind it*, given within minutes and without re-scanning.

**Why.** Our own model was built properly: campaign- and time-held-out test, calibration, and an independent re-run that reproduced every number (`data-ml/model`, `pack/model/reports/2026-10-08-gate.md`). It still lost to the existing rules on both gate measures:

| | Model | Current rules |
|---|---|---|
| Held-out bad releases caught within 1 h | 16/100 | 27/100 |
| Findings per control repo, scan day | 22.5 | 11.0 |

The cause is the framing, not the technique. We predicted from metadata (timing, downloads, publisher history). npm deletes the code of bad releases, so 97% of the positives had no package contents. The tools and research that work read the release's **code**: what changed against the previous version, or what it does in a sandbox. That is a solved, crowded field, so we reuse it.

## 1. Layers

| Layer | Source | Ours or reused | Output |
|---|---|---|---|
| **Known-bad** | OSV feed (OpenSSF malicious-packages `MAL-*`, GitHub advisories incl. CWE-506), Datadog dataset manifest, Backstabber's Knife Collection name list, our incident KB, CISA KEV, FIRST EPSS | reused feeds; our sync and index | **Critical**, with the record's links. Always wins. |
| **Pre-advisory detectors** | **GuardDog** (Datadog, Apache-2.0) static rules on the release's code and metadata; **OpenSSF package-analysis** sandbox results where published; our explainable release signals (`publisher_change`, new install script, `provenance_dropped`, `dependency_added`) | reused detectors, plus our signals | A finding with the detector and rule named, and evidence. Never "critical" without a known-bad match. |
| **Blast radius and who's behind it** | stored inventories, reach in words, ownership chain, org alerts, Slack | **ours** | "Hits 3 of 12 projects, 2 in production, brought in by X; owned by org Y, funded by Z" |

The "never execute" rule stands. GuardDog reads code with Semgrep rules and never runs it. Sandbox evidence only ever comes from OpenSSF's published results; Blastradius runs no sandbox of its own.

## 2. Known-bad feeds: a pipeline that scales

This uses the same methods as osv-scanner's offline databases and the Grype and Trivy vulnerability databases: incremental sync of OSV-format records, a compiled match index, and a versioned artifact with a checksum that clients poll.

### 2.1 Sources (all checked 2026-10-08)

| Source | How we pull it | Size / cadence | Licence |
|---|---|---|---|
| **OSV per ecosystem** (`osv-vulnerabilities.storage.googleapis.com/npm/`) | Bootstrap from `all.zip`. Then **incrementally** read `modified_id.csv`, which lists `timestamp,id` newest first: stop at the last timestamp synced and fetch only `<id>.json` for changed ids. | about 230k npm records; changes hourly (e.g. MAL-2026-17648 modified 10:45 UTC today) | CC-BY-4.0 / per source |
| **OpenSSF malicious-packages**, **GitHub advisory-database** | Already inside OSV. Kept as a git-mirror fallback (`git fetch` is incremental and gives an audit trail). | | Apache-2.0 / CC-BY-4.0 |
| **Datadog malicious-software-packages-dataset** | `git fetch`. Reads `samples/npm/manifest.json`: `null` means every version is malicious; a version list means compromised versions. | small; weekly | Apache-2.0 |
| **Backstabber's Knife Collection** | Its public name list (`data/packages.json`, by ecosystem) feeds the known-bad index. The **samples** need an access request by email from an institution's own address (`ohm@cs.uni-bonn.de`); Gmail-type addresses are refused. We have not requested them. | 174 packages, 2015–2019 | per authors, cite DIMVA 2020 |
| **Our incident KB** | in repo (YAML) | curated | ours |
| **CISA KEV**, **FIRST EPSS** | daily files | daily | CC0 / attribution |

### 2.2 Store: idempotent, with history

- **Raw record store.** One row per `(source, id)` with `modified`, content hash, `firstSeenAt`, `lastSeenAt` and `withdrawnAt`. An upsert only writes when `modified` is newer or the hash differs, so the sync is idempotent and safe to re-run. Withdrawn records become tombstones; nothing is deleted, so "what did we know at time T" can always be answered (this is what the replay proof needs).
- **Compiled match index.** `(ecosystem, name) →` every-version flag / exact versions / OSV ranges (introduced, fixed, last_affected), with the ids of the source records. This is pack v2's shape, now built incrementally. Range-only advisories stay ranges (the fsevents lesson).
- **Precedence.** KB curated > GitHub reviewed > OSV `MAL-*` > dataset manifests. A record that a higher source contradicts (e.g. a range-only record against an "every version" one) is kept, flagged, and does not override.
- **NOTICE.** Every artifact carries a source / licence / snapshot table.

### 2.3 Distribution: versioned artifact, polled by clients

- A scheduled job (GitHub Actions cron, hourly, in the private repo) runs the sync and publishes `pack-<UTC timestamp>.json.gz` with its `.sha256`, plus a **`listing.json`**: version, built-at, record counts, per-source high-water marks and URL. This is the Grype `listing.json` pattern.
- Servers poll `listing.json` with `If-None-Match`, download only a newer pack, verify the SHA-256 and swap atomically. The **AlertWatcher already re-checks every org on pack change** and posts new alerts to Slack once.
- Later, if packs grow, add deltas: changed index entries since version N.
- **Freshness target:** an OSV record changing → an org alert within 90 minutes (sync ≤ 60 min plus poll ≤ 30 min). It is measured on every run: the listing records the newest `modified` it contains.

### 2.4 Scale

- Sync cost is proportional to what changed, not to the size of the database (it uses `modified_id.csv`).
- Matching is a name-keyed lookup per component. Today an org-wide check takes about 10 ms per incident with no re-scan.
- Gates that run in CI, as the replay proof does now: replaying a recorded day of `modified_id.csv` yields the same index as a full rebuild; a withdrawn record clears its alerts' "active" state but keeps history; the pack is byte-identical for the same inputs.

## 3. Pre-advisory detectors: adopt behind a gate

Adoption follows the same rule as the model: **prove it first**. A detector ships only if, on the replay incidents plus Datadog's npm *compromised* samples:

1. **Catch:** it flags more bad releases before the advisory than our current signals do (today 11/16 on the replay set), or flags different ones, so the union is higher.
2. **Noise:** run on the exact package versions in the control repos' lockfiles (microsoft/TypeScript, mochajs/mocha, the replay controls), it adds no more than 1 finding per repo at medium or above.
3. **Cost:** it scans only **new or changed** versions per scan (a lockfile diff), with a per-scan time budget.

**GuardDog first.**
- What it is: `guarddog npm scan <tarball>`, Semgrep and metadata rules, v3.2.0, Apache-2.0.
- Where samples come from: Datadog samples are encrypted zips (password `infected`). They are unpacked only inside the scan job and never executed or committed.
- Who runs it: the proof runs in CI or the private repo's Actions, not on user machines.

**OpenSSF package-analysis next:** read its published results for the versions we see, if they can be queried per version. To verify.

## 4. What happens to the model work

- `data-ml/model` stays as **evaluation infrastructure**: the labelled dataset (5,136 positives, 55 campaigns), the time- and campaign-held-out split, and the gate. It is how we score GuardDog or any detector we consider. No model ships.
- DATA-ML.md §2 steps 4–8 (train our own model) are superseded by this document. Its §4 "Reuse, not reinvent" table was right, and we now follow it.

## 5. Delivery steps (report after each)

1. **Feeds sync.** OSV incremental sync, raw store, compiled index, pack and `listing.json`; Datadog manifest and BKC names as extra sources. CI gates as in §2.4. Hourly workflow in the private repo.
2. **Pack polling in the server.** Use `listing.json` with ETag, verify the SHA-256, swap; the AlertWatcher reacts. Freshness measured end to end.
3. **GuardDog proof.** Catch / noise / cost as in §3 on replay incidents, Datadog npm compromised samples and control repos. Adopt only if it passes.
4. **If it passes,** a GuardDog finding source on lockfile diffs, shown with rule names and evidence, never as "critical" on its own.
5. **OpenSSF package-analysis results** as evidence, if queryable.
