# enrich/npm — npm registry enricher

`createNpmEnricher(opts?)` reads `GET https://registry.npmjs.org/{name}` once per package (memoised per
`HttpClient`) and emits, for each scanned version (source `npm`):

| kind | subject | derivation |
|---|---|---|
| `maintainers` | unversioned | top-level `maintainers` |
| `publisher` | versioned | `versions[v]._npmUser` (+ `trustedPublisher` for npm OIDC publishing) |
| `publisher_change` | versioned | the scanned version's publisher first published this package ≤ `changeWindowDays` (365) before it, after other accounts had. Extra fields: `scannedVersion`, `firstSeenVersion`, `daysBeforeRelease`, `previousPublishers`, `addedDependencies`. Trusted-publishing releases are not flagged. |
| `maintainer_change` | versioned | per-version `maintainers` differs from the previous version that lists maintainers (within the window, ≤5, newest first; `via: 'version-history'`) |
| `maintainer_change` | unversioned | top-level maintainers differ from the previous snapshot (`via: 'snapshot'`) |
| `install_script` | versioned | `scripts.preinstall/install/postinstall` (+ implicit `node-gyp rebuild` for `gypfile`); commands ≤500 chars, untruncated `lengths`, static regex `flags` (network, obfuscated, eval, pipe_to_shell, background_process, env_access, credential_files, runs_package_file, native_build, long_command). Never executed. |
| `provenance` | versioned | `dist.attestations` (`slsa-v1` etc.); explicit `false` when absent |
| `release_age` | versioned | `time[v]` vs `ctx.now` |
| `repo`, `funding` | unversioned | `repository`, `funding` of the scanned version |

History-based signals ignore versions published after `ctx.now`, so backtests see history as it was.
E-mails are dropped unless `includeEmails: true`.

Snapshots: `.blastradius-cache/snapshots/npm/<encoded name>.json`, last 30 summaries per package (no e-mails).
`snapshots: 'auto'` (default) uses them only when `ctx.offline` is false.

Pure helpers for backtests: `packumentFacts(packument, name, version, { now })`, `versionHistory`,
`derivePublisherChange`, `deriveMaintainerChanges`, `analyzeInstallScripts`, `parseRepoUrl`.
Fixtures: `test/fixtures/npm/` (event-stream as of 2018-11, ua-parser-js as of 2021-10-22, yocto-queue).
