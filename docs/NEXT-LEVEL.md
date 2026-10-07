# Next level: prove it on recorded real events

**Goal.** A security team asks one question during a supply-chain incident: *are we hit, where, and who pulled it in?* Blastradius has to answer that across a whole organisation within minutes of disclosure. Where possible it should also warn *before* disclosure. We prove this on **recorded real events**, replayed offline. Nothing is fetched at test time, so the proof runs in plain CI on every push.

## What "proven" means (acceptance)

For each replayed incident the proof report must show:

1. **Detection.** Every affected project in the org is found, with its production/dev status and "brought in by". No unaffected project is flagged.
2. **Time to answer.** This is measured from the moment the advisory exists in the replay clock to the moment the alert names the affected projects. It must work without re-scanning repos (the stored inventories are re-checked).
3. **Early warning.** For each incident, report which pre-disclosure signal fired and how many hours before the advisory, or state plainly that none did. Examples of signals: new publisher, missing trusted publishing, new install script, maintainer added just before a release.
4. **Noise.** Control repos get 0 critical/high findings. Upkeep-only signals stay out of findings.

A CI job runs the whole replay and fails if any of these regress.

## The replay world (mock data source built from real events)

All of this lives under `blastradius/test/replay/`:

- **Recorder (`record.ts`, run once by hand, needs network).** It takes the real records and trims each one to what the scan reads, keeping licences intact (npm metadata, OSV CC-BY/Apache):
  - npm packuments for the incident packages, cut to the versions around the incident window. It keeps `time`, `_npmUser`, `maintainers`, install scripts and attestations.
  - OSV/GHSA advisories with their real `published` times.
- **Dataset (`data/`, committed).** It contains:
  - `incidents.json`: the timeline per incident. Each entry records the bad release (time and publisher), when the advisory was published, and which earlier signals existed.
  - `registry/*.json`: the trimmed packuments.
  - `advisories/*.json`.
  - `org.json`: the "Acme" org of real public repos at pinned commits (taken from the verified hammer scenarios), covering both affected and control repos.
- **Replay server (`server.ts`).** A local HTTP server that answers like registry.npmjs.org and the OSV API, as of a **simulated clock**. Anything published after the clock is invisible. The engine talks to it over real HTTP through its normal client. Only the base URLs change, so no code path is faked.
- **Incidents covered**, chosen because their npm data still exists today:

  | Incident | Bad releases | Signal we expect |
  |---|---|---|
  | event-stream 2018 | event-stream 3.3.6, flatmap-stream 0.1.1 | new maintainer (right9ctrl) weeks before |
  | ua-parser-js 2021 | 0.7.29, 0.8.0, 1.0.0 | none by publisher (same account); install script added |
  | coa / rc 2021 | coa 2.0.3, rc 1.2.9 | install script added; dormant package suddenly releasing |
  | node-ipc 2022 | 10.1.1, 10.1.2 (and 9.2.2 via peacenotwar) | new dependency on peacenotwar |
  | chalk / debug 2025 | 18 packages, same account (qix) | none by publisher; honest miss, caught by the advisory |
  | eslint-config-prettier 2025 | 8.10.1, 9.1.1, 10.1.6, 10.1.7 | install script added on Windows-only path |
  | nx 2025 (s1ngularity) | nx 20.9.0 … 21.8.0 | trusted publishing missing on the bad versions |

The exact versions are checked against the recorded data. Any that can't be confirmed are dropped, not guessed.

## Build steps (about 30 minutes each, report after each)

1. **Recorder and dataset.** Record the incidents above and the Acme org, and commit the trimmed data with its provenance (source URL and fetch time on every file).
2. **Replay server and simulated clock.** The engine runs against it unchanged. Scanning Acme at the start of each incident window gives a correct "before" state.
3. **Org-wide incident mode.**
   - Store each project's resolved inventory (already kept per scan).
   - `checkAdvisories(newAdvisories)` matches new advisories against all stored inventories without re-scanning and writes **alerts**: project, asset, production/dev, brought in by, advisory.
   - API: `GET /api/search/exposure?purl=` ("is X anywhere?") and `GET /api/alerts`.
   - Optional webhook in Slack-compatible JSON.
4. **Early-warning signals.** Check the existing signals against the replay. Add the missing ones: a trusted-publishing downgrade, a new dependency added in a patch release, and a maintainer added shortly before a release. Upkeep-only signals stay out of findings.
5. **Proof run and report.**
   - `npm run proof` replays every incident: it advances the clock from before the bad release, through the release, to the advisory.
   - At each step it records findings, signals and alerts, then writes `proof.md` and `proof.json`.
   - It's a CI job with no network and no secrets.
6. **UI.**
   - An "Is X anywhere?" search on Home.
   - An Alerts page.
   - The blast number replaced by "N projects · M in production".
   - The replay org is loadable as a demo (`serve --demo replay`).

## Status (2026-10-07)

Done, all offline and enforced in CI (`test/replay/*.test.ts`); see [PROOF.md](PROOF.md):

1. **Recorded dataset.** 7 incidents, 16 bad releases and a 6-repo org, with provenance in `manifest.json`.
2. **Replay server.** The engine runs against it unchanged.
3. **Org-wide incident mode.** Engine and server: `/api/search/exposure`, `/api/alerts` and `/api/alerts/check`. Matching takes about 10 ms per incident and needs no re-scan.
4. **New signal and matching fix.** `provenance_dropped` is a new signal. Advisory ranges now match (node-ipc).
5. **Proof run.** 15/15 bad releases are critical after their advisory, and 11/16 were flagged before any advisory existed. An earlier count of 12/16 included chalk 5.6.1 by mistake: the recorded data had dropped qix's 2016–2017 chalk releases, so qix looked like a new publisher. The recorder now keeps each earlier publisher's last release. node-ipc 9.2.2 has no advisory naming it, so it counts for early warning only.
6. **UI.** Home has "Is it anywhere?" and an Alerts card.
7. **Automatic alerts.** The server re-checks all orgs when the pack refreshes, on a timer and after every scan. New alerts go once to a Slack-compatible webhook (see [WEB-API.md](WEB-API.md)).
8. **New dependency in a patch release** (`dependency_added`, weight 0.4, SARIF rule BR011). It fires when a patch release adds a runtime dependency the previous release didn't have, **and** that dependency was brand new on npm (first released 30 days or less before). It is dropped when deps.dev shows the dependency has since reached 500 or more dependents. It fires on event-stream 3.3.6 (flatmap-stream) and node-ipc 9.2.2 (peacenotwar). On a real repo (telefonicaid/logops), the plain "any new dependency" version gave 16 medium findings. Requiring a brand-new dependency cut that to 6, all ljharb packages adopting has-tostringtag and call-bind the day they were released. The dependents check removes those when deps.dev is reachable.
9. **Who's behind it, for every package.** Each finding and upkeep entry now carries `behind`: the package's own documented links, up to two hops (npm accounts and repo owner, then their orgs and funders). This no longer depends on an incident. The table's "Behind" column falls back to the repo owner. On the logops scan, 17/17 findings and 402/402 upkeep entries have a chain.

**Honest misses** (shown in the report, not hidden):
- flatmap-stream: a brand-new package. Its parent event-stream 3.3.6 is flagged instead.
- node-ipc 10.1.x: the same maintainer, with no install script.
- chalk 5.6.1 and debug 4.4.2: the same publisher (qix, phished), with no install script. Only the advisory catches them.

**Not yet done:**
- Org membership and funders need the GitHub and Open Collective APIs. Without a GitHub token, the chain stops at npm accounts and repo owner. The hammer runs with a token.

## Out of scope for this round

- The funder graph and the trained model. The replay dataset is what will later train and gate the model.
- PyPI and containers.

Each of these comes back once the proof run is green.
