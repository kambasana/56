# Replay dataset (recorded real events)

Recorded once by `record.ts` (network), then used offline by the replay server and the proof run
(docs/NEXT-LEVEL.md). Nothing here is fetched at test time.

- `incidents.config.json`: hand-curated incident timeline. Release times come from the npm
  registry `time` map; advisory times come from OSV/GHSA `published`.
- `data/registry/`: real packuments, slimmed like the engine slims them and trimmed to each
  incident window. npm **unpublished** the malicious versions, so those entries are rebuilt from
  the advisory and carry `_replay.reconstructed` with the source URL. Every other entry is as
  recorded.
- `data/advisories/`: real OSV records (npm entries only).
- `data/org/`: `package.json` + `package-lock.json` of real public repos at pinned commits. This is
  the "Acme" org.
- `data/manifest.json`: provenance for every file (URL, commit and fetch time).

Re-record: `npx tsx test/replay/record.ts --osv-dir <dir of OSV npm JSON>` (needs network).

Account-level proof (`account/`, docs/ACCOUNT-PROOF.md): `record-account.ts` records package timelines
(publish time, `_npmUser`, `maintainers`), account package lists, OSV records and five 2025 lockfiles into
`account/data/`. `proof-account.ts` replays them offline (`npm run proof:account`). The methods are
pre-registered in `account/PREREGISTRATION.md`.
