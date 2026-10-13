# e2e-repo (test fixture)

A minimal app used by `test/e2e`. It is scanned statically and never installed or run.

- `package.json` / `package-lock.json` (v3): depends on `ms` (healthy) and on `event-stream@3.3.6`,
  which pulls in `flatmap-stream@0.1.1` transitively (the 2018 incident,
  https://github.com/dominictarr/event-stream/issues/116).
- `.github/workflows/pr-check.yml`: `pull_request_target` with a PR-head checkout and tag-pinned actions.

Lockfile `resolved`/`integrity` values come from the recorded registry packuments in
`test/fixtures/npm`; event-stream 3.3.6 and flatmap-stream 0.1.1 were removed from the registry,
so they have no integrity value here.
