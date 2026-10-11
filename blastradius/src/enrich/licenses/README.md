# enrich/licenses

`createLicenseEnricher(opts?)` → Enricher `licenses`: `license` facts (versioned; one per source:
`depsdev`, `clearlydefined`, `lockfile`, `sbom`) and `license_change` facts (unversioned, `depsdev`).

- deps.dev GetPackage (release list) and GetVersionBatch (`POST /v3alpha/versionbatch`, 100 versions
  per request) give each release's declared licences; changes are found in version order
  (`src/licenses/history.ts`), from 20 releases before the oldest version in use to the latest.
- ClearlyDefined `POST /definitions?expand=-files` is the second source (CC0 data, 250 POSTs/min).
- GitHub Actions: deps.dev GetProject's repository licence, marked `basis: 'repository'`; skipped in replays.
- Replays (`ctx.historical`) ignore releases published after `ctx.now`.

Normalisation, categories, policy and the per-scan report live in `src/licenses/`. Fixtures:
`test/fixtures/licenses/` (recorded by `test/licenses/record.ts`).
