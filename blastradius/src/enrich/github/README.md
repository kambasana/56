# enrich/github — GitHub repo + funding enricher

`createGithubEnricher(opts?)` emits (source `github`, unversioned subjects):

- `repo_owner`, `archived` from `GET https://api.github.com/repos/{owner}/{repo}` (`GITHUB_TOKEN` sent as a
  bearer token to the API host only).
- `repo_transfer` when the canonical owner GitHub returns (it follows renames/transfers) differs from the
  owner declared in package.json `repository` (or the action reference).
- `funding` (`via: 'FUNDING.yml'`) from `raw.githubusercontent.com/{o}/{r}/HEAD/.github/FUNDING.yml`
  (also `funding.yml`, then the owner's `.github` repository).
- `funding` (`via: 'opencollective'`) — backers/sponsors of collectives declared in FUNDING.yml or
  package.json#funding, via Open Collective GraphQL v2. Organisations only unless
  `includeIndividualBackers: true`.

Repos are resolved from npm packuments (shared memoised fetch), from earlier `repo`/`funding` facts
(`repoFacts: () => facts`), or a custom `resolveTargets`. GitHub Actions components map to their owner/repo.
A 403/429 from the API stops further lookups for the scan (one warning). Fixtures: `test/fixtures/github/`.
