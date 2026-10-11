# test/fixtures/licenses

Recorded once with `npx tsx test/licenses/record.ts` (and `--e2e`), replayed offline by the tests
and by `serve --dev-seed`. Responses are trimmed to the fields the licences enricher reads.

- `recorded/`: licence validation subjects (`test/licenses/subjects.ts`): deps.dev GetPackage,
  GetVersionBatch and GetProject, and ClearlyDefined definitions. Recorded 2026-10-11.
  `pypi-*`: PyPI JSON API per-version responses for the sentry releases around deps.dev's licence
  data gap (`record.ts --registry`, trimmed to the licence fields and file upload times).
- `e2e-repo/`: the dev-seed fixture repository (`test/fixtures/e2e-repo`) as of 2018-11-27.
- `spdx-2.3.schema.json`: the SPDX 2.3 JSON schema from https://github.com/spdx/spdx-spec (tag
  v2.3, `schemas/spdx-schema.json`), used to validate the SPDX export. The SPDX specification is
  licensed CC-BY-3.0 (LICENSE at that tag).

Data terms: deps.dev — Google API Terms of Service, caching expressly permitted, generated data
CC-BY 4.0 (https://docs.deps.dev/api/v3/#terms); ClearlyDefined — data distributed under CC0
(https://docs.clearlydefined.io/docs/resources/faq); PyPI JSON API — public package metadata as
uploaded by the package authors (https://docs.pypi.org/api/json/).
