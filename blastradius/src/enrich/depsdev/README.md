# enrich/depsdev

`createDepsDevEnricher(opts?)` → Enricher `depsdev`. deps.dev v3 GetVersion → `provenance` (versioned) + `repo`;
GetProject → `scorecard` (falls back to api.securityscorecards.dev for GitHub repos, source `scorecard`);
v3alpha `:dependents` → `dependents`. Package-level facts use the unversioned purl, one per package.
Fixtures: `test/fixtures/depsdev/`.
