# enrich/licenses

`createLicenseEnricher(opts?)` → Enricher `licenses`: `license` facts (versioned; one per source:
`depsdev`, `clearlydefined`, `registry`, `lockfile`, `sbom`) and `license_change` facts
(unversioned, `depsdev`, or `registry` when registry metadata placed the change).

- deps.dev GetPackage (release list) and GetVersionBatch (`POST /v3alpha/versionbatch`, 100 versions
  per request) give each release's declared licences; changes are found in version order
  (`src/licenses/history.ts`), from 20 releases before the oldest version in use to the latest.
- A change found across releases without deps.dev licence data is a range (`unknownBetween`).
  For PyPI and npm those releases (and the two around them) are then asked of the registry
  (`registry.ts`: PyPI JSON API `info.license_expression` / `info.license` / License classifiers;
  npm packument `versions[v].license`); a change placed that way keeps deps.dev's range in `primary`.
- ClearlyDefined `POST /definitions?expand=-files` is the second source (CC0 data, 250 POSTs/min).
- GitHub Actions: deps.dev GetProject's repository licence, marked `basis: 'repository'`; skipped in replays.
- Replays (`ctx.historical`) ignore releases published after `ctx.now`.

Normalisation, categories, policy and the per-scan report live in `src/licenses/`. Fixtures:
`test/fixtures/licenses/` (recorded by `test/licenses/record.ts`).
