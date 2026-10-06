# kb/incidents — curated incident knowledge base (PLAN §3.4)

One incident per YAML file, field names exactly as the `Incident` type (src/core/types.ts).
Validate with `blastradius kb validate` (src/incidents/loader.ts → `validateKbDir`).

Rules enforced by the validator (src/incidents/schema.ts):
- `id` is `INC-YYYY-NNNN`, unique across files, and its year matches `date` (ISO `YYYY-MM-DD`).
- At least one public `https` evidence URL (always required for `confirmed`).
- `affected[].purl` is an unversioned canonical purl; `versions` are exact (versions or commit SHAs), or `["*"]`. Only exact entries trigger the malware override; `["*"]` also covers releases made after a fix, so it is scored as a decaying `incident_affected` reason instead. Prefer exact lists.
- `entities[].ref` uses entity id conventions; `confidence` is 0–1; `role` is a factual snake_case label.
- Titles are factual: judgement words ("malicious", "evil", "rogue", ...) are rejected.
- `sanctions` incidents must cite an official list (OFAC).

Editorial rules: describe projects and events, not people. Do not name or characterise individuals;
add an account ref only with a public source and a reviewed entry. Mark anything unverified with a
`TODO(kb-review)` comment rather than inventing identifiers or URLs.
