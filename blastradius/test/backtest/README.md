# Backtests

Historical replays used to sanity-check (and later calibrate) the scoring model, PLAN §6.
Each case scans a small lockfile under `repos/` fully offline, with a fixed reference time
(`scan({ now })`, CLI `--as-of`). `backtest.test.ts` runs them as part of `npm test`.

| Case | Lockfile | Reference time | Expectation |
| --- | --- | --- | --- |
| (a) event-stream 3.3.6 | `repos/event-stream-2018` (app → event-stream 3.3.6 → flatmap-stream 0.1.1 + its other deps) | 2018-11-27, after the public disclosure | event-stream and flatmap-stream **critical**, top reason `malware`; `publisher_change` (right9ctrl after dominictarr) is among the reasons |
| (a′) same, pre-disclosure | same | 2018-09-10, the day after 3.3.6 was published | no advisory yet; event-stream still ranks first with top reason `publisher_change` (scores **high**, 72.9 at the time of writing). This is informational: it shows what the history signal alone gives |
| (b) ua-parser-js 0.7.29 | `repos/ua-parser-js-2021` | 2021-10-23, the day after the compromised releases | **critical**, top reason `malware` (KB incident INC-2021-0001); GHSA-pjwm-rvh2-c87w shows up as a critical `vuln` (it is CWE-912, not CWE-506, so OSV alone does not mark it as malware); the `preinstall` hook shows up as `install_script` |
| (b′) same, pre-advisory | same | 2021-10-22T13:00Z, after the 12:15Z publish and before the 20:38Z advisory | no `malware`/`vuln` and no KB hindsight; `install_script` is flagged because `preinstall` is new in 0.7.29 (0.7.28 had none) |
| (c) healthy control | `repos/healthy-control` (ms, once, wrappy, inherits, yocto-queue) | 2026-01-01 | no critical/high finding, no malware/vuln reason |

## How time travel works

- **npm registry history:** versions published after `now` are ignored when deriving `publisher_change`, `maintainer_change` and `release_age` (src/enrich/npm).
- **Incident KB:** incidents are dropped unless their whole `date` day has passed by `now` (`incidentsKnownAt` in src/pipeline.ts), so an intraday replay on the incident day does not see them.
- **OSV advisories:** `vuln`/`malware` facts whose advisory `published` date is after `now` are dropped (`factsKnownAt`). GHSA-9x64-5r7x-2q53 (flatmap-stream) was published in 2019, so in the 2018 replay flatmap-stream is flagged through GHSA-mh6f-8j2x-4483 and the KB incident instead.
- **Not time-travelled:** deps.dev Scorecard/dependents and GitHub repo metadata describe the state when the fixture was written. Treat those factors as approximate in replays.

## Fixtures are reconstructions, not recordings

The API fixtures in `test/fixtures/` are rebuilt from public records. They are **not** captures of what the APIs returned in 2018 or 2021:

- `test/fixtures/npm/event-stream.json` and `ua-parser-js.json` come from the live registry. npm later removed event-stream 3.3.6 and ua-parser-js 0.7.29/0.8.0/1.0.0, so those versions were rebuilt from neighbouring versions and the published advisories. Each file's `note` says so.
- `test/fixtures/npm/{ms,once,wrappy,inherits,duplexer,from,map-stream,pause-stream,split,stream-combiner,through}.json` were recorded from registry.npmjs.org and trimmed: at most the last 25 versions, only the fields the enricher reads, and email addresses removed. There is no flatmap-stream packument: npm replaced the package with a security holder, and that metadata does not reflect 2018.
- `test/fixtures/osv/*` (including the `querybatch-bt-*.json` envelopes used here) and `test/fixtures/depsdev/*` follow the documented API shapes but are hand-written, because api.osv.dev and api.deps.dev are not reachable from the recording environment. Advisory ids, summaries, published dates and affected ranges follow the public GHSA records. Scorecard scores and dependents counts are representative placeholders.
- `test/fixtures/github/*`: the FUNDING.yml responses were recorded live. Repo metadata and Open Collective responses are illustrative (api.github.com returned 403).
- Lockfile `resolved`/`integrity` values come from the recorded packuments. Versions npm removed have no integrity value.

The OSV querybatch fixture is matched on the exact request body. If you change a lockfile under `repos/`, regenerate its `test/fixtures/osv/querybatch-bt-*.json`: one query per npm component, sorted by purl.

## Adding a case

1. Add `repos/<case>/package.json` and `package-lock.json` (v2/v3).
2. Add fixture envelopes `{ "request": { "url", "method?", "body?" }, "status?", "response" }` under `test/fixtures/<source>/`, each with a note saying where the data came from.
3. Add a `replay('<case>', '<ISO time>')` test with the expected level and top reason.
