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

## 6. Status

### Step 1, feeds sync: done (branch `feeds/incremental-sync`)

`blastradius feeds sync --store feeds.db --out <dir> [--offline-from <dir>] [--ecosystem npm]` (code in `blastradius/src/feeds/`).

- **OSV** per ecosystem: bootstrap from `all.zip` (own ZIP64 reader, no dependency), then `modified_id.csv` read only down to the high-water mark minus a 2 h overlap. Only ids whose stored `modified` is older than the CSV row are fetched, so the overlap costs no downloads.
- **Raw store** (`node:sqlite`): `(source, id)` → `modified`, SHA-256, `firstSeenAt`, `lastSeenAt`, `withdrawnAt`, deflated JSON. Writes happen only when `modified` is newer or the hash differs. Withdrawn records and names dropped from a dataset become tombstones and are never deleted. High-water marks are kept per source (OSV: newest `modified`; git sources: commit and date; KB: content hash).
- **Datadog manifest** and **BKC names** come in by blob-less `git fetch`, so the Datadog sample archives are never downloaded.
- **BKC decision.** `data/packages.json` is `ecosystem → [names]`, with no versions, and now holds 14,678 npm names (not 174). It also lists compromised *legitimate* packages: `chalk`, `debug`, `event-stream`, `node-ipc`. Marking every version of those as malicious would be wrong, so BKC is a label source only (`pack.labels[name] = ["bkc"]`, "named in a known attack dataset"). Labels are evidence for people and never produce a match. The repository states no licence, so only the names are used, with the DIMVA 2020 citation in NOTICE.
- **Index.** The pack v2 shape is unchanged, and v2 loaders read it. OSV records go through the existing builder (`addOsvRecord`), and range-only advisories stay ranges. Precedence: KB > GitHub reviewed > OSV `MAL-*` / unreviewed GHSA > dataset manifests.
  - A lower-ranked "every version" claim is a **conflict** when a higher-ranked source names only versions or ranges. It goes to `pack.conflicts` with the ids that contradict it, and it does not match.
  - An open range from `0.0.0` counts as "every version", which is how GHSA writes it.
  - Dataset entries only fill gaps. Anything a higher source already covers counts as corroborating, so the same version is not alerted twice.
  - KB refs (`source: "kb"`) give org-wide alerts for KB incidents. The scan enricher skips them because a scan reads the KB itself.
- **Artifact.** The output is `pack-<UTC ts>.json.gz`, `.sha256` and `listing.json` (version, builtAt, counts, high-water marks, `newestModified`, url, NOTICE).
  - `builtAt` is the newest source timestamp, not the wall clock, so the same inputs give the same bytes and a re-run with nothing new writes nothing.
  - If a different pack would get an existing name, a hash suffix is added. A published pack is never overwritten.
- **Gates** (`src/feeds/feeds.test.ts`) run on a trimmed recording of real data: the 2026-10-07 slice of `modified_id.csv` with its records. They cover:
  - incremental replay giving byte-for-byte the same pack as a full rebuild;
  - a CSV-walk bootstrap giving the same pack as a zip bootstrap;
  - an idempotent re-run (0 store writes, 0 files);
  - withdrawn records becoming tombstones that are absent from the index;
  - determinism;
  - precedence and conflicts.
- **Workflow template:** `blastradius/test/hammer/ci/feeds.yml` runs hourly. It keeps the store as a release asset and publishes to a `feeds` release. It is not wired up.

**Real run, 2026-10-08:**

| | |
|---|---|
| Bootstrap | 45 s total. OSV npm 25 s: 218 MB `all.zip`, 230,147 records, 729 withdrawn. |
| Bootstrap sources | Datadog 48,516 entries (46,443 every version, 5,257 versions). BKC 14,678 npm names. KB 16 incidents. |
| Store | 308 MB |
| One-day incremental | 2.5 s for OSV: 150 CSV rows read, 148 records fetched. 20 s end to end, of which 10 s is compiling. The pack is byte-identical to the full bootstrap of the same moment. |
| No-change re-run | 24 s. OSV 0.3 s, compile 13 s. 0 store writes, 0 files written. |
| Pack | 3.35 MB gzipped |
| Malware index | 210,612 every-version packages; 27,379 bad versions of 14,668 packages; 579 range-only advisories |
| Datasets | 3,744 dataset-only entries; 44,717 corroborated |
| Conflicts | 3,235 in total: 3,226 Datadog "every version" against an OSV `MAL-*` that lists versions; 8 `MAL-*` against a reviewed GHSA; 1 GHSA against the KB (`flatmap-stream`) |

### Step 2, pack polling: done (small)

`src/server/pack-poll.ts`. With `BLASTRADIUS_PACK_LISTING_URL` and `BLASTRADIUS_PACK` set, the server:

1. polls the listing with `If-None-Match` every `BLASTRADIUS_PACK_POLL_MINUTES` (default 30);
2. downloads only a newer pack;
3. verifies its SHA-256 and that it loads;
4. renames it into place;
5. runs `AlertWatcher.checkAll()`.

**Next:**

- Freshness end to end: an alert's time minus the listing's `newestModified`.
- Skip the compile when no source moved, which saves about 13 s per hourly run.
- Compiling from the store at a time T, for "what did we know at T".
- CISA KEV and EPSS.
- The supplychain-attack-data incidents. The old `pack:build` carried them; the feeds sync does not yet.
