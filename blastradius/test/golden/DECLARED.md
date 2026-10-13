# Declared golden differences

`npm run golden:check` fails on any difference between the replayed outputs and `snapshots/` that is not listed here. A refactor stage that changes output on purpose adds one row per change, in the same PR, then runs `npm run golden:update`. Remove the rows once the PR has merged and the snapshots carry the change: this list describes the diff of one PR, not history.

**Path format:** `<case>/<format> <json path>`.
- `<case>`: `parse-server`, `jitsi-meet`, `superset`, `flask`, or `*`.
- `<format>`: `json`, `sarif`, `cyclonedx`, `spdx`, `html`, or `*`.
- `<json path>`: as `golden:check` prints it, for example `$.findings[purl=pkg:npm/proxy-addr@2.0.7].level`. `*` matches within one segment, `**` matches anything, and a path also covers everything below it. For HTML, use `$.line` (any line).

| Path | Reason | Stage |
|---|---|---|

## What the goldens cover (partial, owner decision 2)

The goldens replay what was recorded, nothing more. Every source the recordings lack is an offline miss, which the scan reports in `coverage.sources` and `warnings` the same way on every run:

| Case | Recorded | Missing (shows as partial or failed coverage) |
|---|---|---|
| parse-server, jitsi-meet, superset (`fixtures/tier05`) | OSV, deps.dev package and version data, the npm packuments listed in `test/tier05/targets.ts` | GitHub (403 when recorded), the other npm packuments, the licence enricher's deps.dev and ClearlyDefined lookups |
| flask (`fixtures/tier0/flask` + `stability/recorded/tier05-pypi-flask`) | OSV, deps.dev, ClearlyDefined, Scorecard, PyPI JSON and Simple API | deps.dev dependents counts (partial); GitHub makes no lookups for this slice, so it reports ok with no facts |

Not in the goldens at all: git history (`--history`) and the agentic gap-filler (`--agentic`), which the default plugin set leaves off. They stay covered by the history and agentic replays (`test/history`, `test/stability`, `test/agentic`). The full recording (GitHub, history, ClearlyDefined for all four repositories) waits for a GitHub token (ARCHITECTURE §6.1 option b).

The bundled incident KB (`kb/incidents`) is part of the default plugin set, so a KB data change also changes the goldens: update the snapshots in that PR.
