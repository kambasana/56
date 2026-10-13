# test/fixtures — shared recorded API responses; each enricher agent owns its own subdirectory (osv/, depsdev/, npm/, github/, repos/, licenses/, history/, stability/).

history/recorded/: pseudonymised git histories (test/history/record.ts, format in test/history/fixture.ts): ids are GitHub no-reply logins or hashes under a discarded random salt; no names, emails, messages or per-person time zones.

stability/recorded/: P3 stability fixtures (test/stability/record.ts, format in test/stability/fixture.ts): trimmed npm packuments (no e-mail addresses; repository fields normalised; e-mail addresses in deprecation messages removed), deps.dev / Scorecard Maintained checks, and pseudonymised histories (P2 format plus `npmPublishers`, the npm accounts whose registry e-mail hashes to an id in the history). `control.json.gz` holds the production dependencies of the control repositories in test/replay/data/org.
