# enrich/osv

`createOsvEnricher(opts?)` → Enricher `osv`. POST `/v1/querybatch` (≤1000 npm queries per call, follows
`next_page_token`), then GET `/v1/vulns/{id}` per distinct id. Emits `vuln` (severity from a CVSS v3 vector, else
`database_specific.severity`) and `malware` (MAL-* ids/aliases, `database_specific["malicious-packages-origins"]`,
`database_specific.malicious === true`, CWE-506). Free-text summaries are never used for malware detection.
`MAL-*` records yield only `malware`. EPSS/KEV are left unset. Fixtures: `test/fixtures/osv/`.
