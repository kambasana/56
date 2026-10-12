# Who is behind it, and how stable it is: plan

**Status:** plan, 2026-10-11. Owner direction (verbatim intent, summarised): security signals are
**inputs from others**, shown with their source; we do **not** build detection. What only we do is
**who is behind each package and how stable it is**: funding, stability, issues around it,
maintainer continuity, licences, and a roll-up by repo/org.

**How to read the citations.** Every external fact has a URL. **[v]** = checked on 2026-10-11 in
this session (fetched, or confirmed through a search result that quoted the page). **[u]** =
unverified: the URL is from memory or the page could not be reached from this environment
(several official doc hosts did not resolve here). Each [u] item is re-checked in phase P0 before
code depends on it. **[v P0]** = re-checked in P0 (2026-10-11) from the primary source named next
to it (official docs, an API response, a licence file at a release tag).

**P0 result (2026-10-11).** 34 unverified items: 28 are now [v P0]; 6 stay [u] with the reason
inline (Sponsors field visibility and Tidelift need a token or a JavaScript-only page; the HashiCorp
blog answers 429 here, the licence files at the tags verify the event instead; the SPDX
license-list-data licence is not stated in its repos, and P1 uses CC0 npm packages instead; two
are data expectations that only P2/P4 can measure; P2 measured the express one). One expectation
was corrected: `request`'s repository is not archived. Gate results for P0, P1, P2 and P3 are in §10, with the agentic gap-filler's pipeline, gate and guardrails.

---

## 1. Audit: what exists today

Paths are under `blastradius/`. "Exists" = shipped and tested; "partial" = some of it, or data is
fetched but not used; "missing" = nothing in code.

| Focus item | State | Where | Data source |
|---|---|---|---|
| Maintainer → org → funder graph | **exists** | `src/entities/resolve.ts` (deterministic links: npm `maintainers`/`publisher`, `repo_owner`, `funding`; probabilistic email-domain/handle links held unreviewed), `src/entities/graph.ts`, `src/entities/review.ts` | npm packuments, GitHub repo API, FUNDING.yml, Open Collective |
| Who's behind it screen | **exists** | `web/src/pages/Behind.tsx` (graph + table, confidence in words, sources, disclaimer "Not a finding of wrongdoing"); API `GET /api/packages/behind` (`src/server/routes/incidents.ts`) | entity graph |
| FUNDING.yml parsing | **exists** | `src/enrich/github/funding-yml.ts` (13 documented platforms incl. github, open_collective, tidelift, thanks_dev, polar, custom) | raw.githubusercontent.com |
| package.json `funding` | **exists** | `src/enrich/npm/repo.ts` (`fundingFromManifestField`) | npm packument |
| Open Collective backers | **partial** | `src/enrich/github/opencollective.ts`: collective, fiscal host slug, total backer count, top 20 organisational backers by total donated (individuals off by default). **No amounts kept, no time series, no trend.** | OC GraphQL v2 |
| GitHub Sponsors | **partial** | only the FUNDING.yml `github:` handle → `linked_to` account. No Sponsors API call (listing, sponsor count). | FUNDING.yml |
| thanks.dev, Tidelift | **partial** | declared handle/URL only (FUNDING.yml). | FUNDING.yml |
| funding.json (FLOSS/fund) | **missing** | — | — |
| Corporate backer / employer | **partial** | repo owner type User vs Organization (`repo_owner` fact). No profile `company`, no foundation membership. | GitHub repo API |
| Funder concentration / roll-up | **missing** for funders. **Exists for accounts:** `src/server/accounts.ts` `concentration()` → Exposure page "which accounts can publish the largest share of production dependencies" (`web/src/components/viz/Concentration.tsx`), H3 in `docs/ACCOUNT-PROOF.md` | npm packuments |
| Account index ("account X compromised → exposure") | **exists** | `src/server/accounts.ts`, `src/server/store/accounts.ts`, `src/accounts/registry.ts`, `web/src/pages/Account.tsx` | npm packuments, npm user listing |
| Single maintainer | **exists** (registry accounts only) | `src/scoring/intrinsic.ts` factor `single_maintainer` (weight 0.15, `src/scoring/weights.ts`) | npm `maintainers` |
| Bus factor from git history | **missing** | ingest clones `--depth 1` (`src/ingest/git.ts`), so no history | — |
| Maintainer activity / abandonment | **partial** | `abandoned` factor: no release ≥ 730 days (`ABANDONED_DAYS`) or repo archived; npm `deprecated` message shown; staleness alone adds 0 risk (`ABANDONED_VALUES.staleOnly`) | npm `time`, GitHub `archived`/`pushed_at` |
| Release regularity | **missing** (only days since latest release, `release_age` fact) | `src/enrich/npm/packument.ts` | npm `time` |
| Ownership / maintainer changes | **exists** | facts `publisher_change`, `maintainer_change` (snapshot diff), `repo_transfer` (GitHub redirect) → `intrinsic.ts` ownership factor, 90-day decay; Changes page | npm, GitHub |
| Burnout / stepping away / funding cut / relicensing / governance events | **partial** | incident KB (`kb/incidents/*.yaml`, `src/incidents/schema.ts`) has types `abandonment`, `maintainer_sabotage`, `malicious_handover`, `sanctions`; status confirmed/alleged/disputed/retracted; judgement-word lint (`findJudgementWord`). No types for funding cut, relicensing, stepping away, governance. | curated KB |
| Contributor continuity, signed commits, time-zone patterns | **missing** | — | — |
| Org/funder jurisdiction, sanctions policy | **partial** | `sanctions` incident type requires an official OFAC host as evidence (`OFFICIAL_SANCTIONS_HOSTS`, `src/incidents/schema.ts`). No list ingestion, no org location facts, no user policy. | — |
| Individual location | **missing** (correctly; see §5) | — | — |
| Licences (declared, per version) | **partial: fetched, unused** | `src/enrich/depsdev/types.ts` has `DepsDevVersion.licenses` and `DepsDevProject.license`, but no `license` fact is emitted, nothing in scoring, UI or reports | deps.dev |
| Licence change, compatibility, obligations | **missing** | — | — |
| SBOM ingest | **partial** | static npm/Actions/Docker parsers; optional Syft CycloneDX merge (`src/ingest/syft.ts`). No SBOM **export** with licences; licence fields from Syft not kept. | Syft |
| OpenSSF Scorecard | **exists** | `src/enrich/depsdev/index.ts` (deps.dev project scorecard, fallback `api.securityscorecards.dev`); `intrinsic.ts` "weak posture" with lowest checks named | deps.dev, Scorecard API |
| deps.dev | **exists** | provenance, repo, scorecard, dependents facts | deps.dev v3 |
| Security feeds (OSV, MAL-*, GHSA CWE-506) | **exists** (input, with source) | `src/enrich/osv/`, knowledge pack `src/pack/` (records source + licence per feed), `src/incidents/osv-import.ts` | OSV, OpenSSF malicious-packages, tstromberg/supplychain-attack-data |
| Maintenance ("Upkeep signals") view | **exists** | noise rule: posture-only components go to the "Maintenance" tab (`web/src/pages/Findings.tsx`, `web/src/pages/d-parts/HealthTable.tsx`), never counted as risk (`docs/NEXT-LEVEL.md` item 4) | intrinsic factors |
| Stability view, Funding view, repo/org roll-up of people + funders | **missing** | — | — |

**Summary.** The graph, account index, change facts and Scorecard input are solid. The big gaps are
(1) anything from **git history** (bus factor, continuity, signed commits, time-zone patterns,
activity), (2) **funding depth** (amounts, trend, Sponsors, funding.json, employer), (3) **licences**
(data is already fetched from deps.dev and dropped), and (4) a **roll-up** across people and funders.

---

## 2. Principles

1. **Shown from others vs computed by us** is explicit on every value (§7 table). External values
   carry their source name, URL and fetch date, as facts already do (`Fact.source`, `evidence`).
2. **Stability is not risk.** Stability and funding signals stay out of Findings and the risk score
   (same noise rule as today's Maintenance tab). They get their own label and views.
3. **Explainable rules, no ML.** Each label is a short rule over facts, with thresholds in one file
   (as `src/scoring/weights.ts`), and each output names the facts that triggered it.
4. **Confidence in three words.** *High*: a registry or API states it (npm maintainers, licence in
   deps.dev, archived flag). *Medium*: we derive it from public data with an identity step that can
   be wrong (git author → GitHub login, CAF). *Low*: declared or text-derived (README says
   "looking for maintainers", profile `company` field). Low never drives a label alone.
5. **Behaviour of a repo, never a label on a person.** Patterns are aggregated per repo and shown as
   a change over time.
6. **Organisation-level facts only for jurisdiction**, from declared public records.

---

## 3. Signals

Format per signal: **definition · source (terms, limits) · computation and confidence · screen**.
IDs are used by the phases in §6.

### 3.1 Funding (F)

**F1 Declared funding channels** (extend existing)
- Definition: every channel a package/repo/owner declares: FUNDING.yml, package.json `funding`,
  funding.json, GitHub Sponsors listing, Open Collective, Tidelift, thanks.dev, Polar, custom.
- Sources:
  - FUNDING.yml format: https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/displaying-a-sponsor-button-in-your-repository [v P0: page lists github, patreon, tidelift, polar, buy_me_a_coffee, thanks_dev, custom …] (already implemented).
  - funding.json manifest (FLOSS/fund): https://floss.fund/funding-manifest/ [v: exists, has
    "funding plans" section, validator at fundingjson.org]; field names (`entity`, `projects`,
    `funding.channels/plans/history`) [v P0: JSON schema v1.1.0, https://fundingjson.org/schema/v1.1.0.json:
    top level `version`, `entity`, `projects`, `funding` (required: entity, funding); `funding` has
    `channels`, `plans`, `history`; project items have `guid`, `name`, `webpageUrl`, `repositoryUrl`,
    `licenses`, `tags`].
  - GitHub Sponsors via GraphQL `Sponsorable` interface: `hasSponsorsListing`,
    `sponsorshipsAsMaintainer` [v, via schema docs generated from GitHub's GraphQL schema:
    https://jsr.io/@luxass/github-schema/doc/~/Sponsorable; official reference
    https://docs.github.com/en/graphql/reference/interfaces#sponsorable [v P0: GitHub's published
    schema file https://docs.github.com/public/fpt/schema.docs.graphql has `interface Sponsorable`
    with `hasSponsorsListing`, `sponsorshipsAsMaintainer`, `sponsors`, and also
    `monthlyEstimatedSponsorsIncomeInCents` / `estimatedNextSponsorsPayoutInCents`]. Which fields are
    visible to a third party (private sponsors, income estimates) is [u: the schema does not say
    and checking needs a token; settle in P4 with a real query]: assume only listing existence and
    public sponsor counts; never show amounts unless the API exposes them publicly.
  - GitHub GraphQL limit: 5,000 points/hour per user token [v,
    https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api].
  - thanks.dev: no public API found [v: search found none; how it works:
    https://www.theregister.com/2023/04/07/thanksdev_open_source_funding/]. Show the declared
    link only.
  - Tidelift: declared link only (no public data API assumed) [u: https://tidelift.com/docs/api
    renders only with JavaScript here; api.tidelift.com answers 404 without a subscriber token. Not
    needed before P4].
- Computation: union of channels per package with the file/URL each came from. Confidence high
  (declared by the project itself). Declared is not received: wording "declares", not "is funded".
- Screen: Who's behind it rail ("Funding channels"), Package page, new Funding view.

**F2 Received funding and concentration** (new, Open Collective only at first)
- Definition: for collectives with public books, money received in the last 12 months, the share
  from the largest funder ("top funder share"), and number of funders giving ≥ 5 %.
- Source: Open Collective GraphQL v2 https://graphql-docs-v2.opencollective.com/ [v P0 by schema
  introspection of https://api.opencollective.com/graphql/v2: `Account` has `stats`,
  `transactions`, `members`, `location`, `legalName`; `Member.totalDonations`; `AccountStats` has
  `totalAmountReceived`, `totalAmountSpent`, `balance`, `yearlyBudget`, `contributionsCount`]. Personal tokens: https://docs.opencollective.com/help/developers/personal-tokens
  [v]. Published rate limit: not found [v: searched] → keep current cache + concurrency limits,
  send `Api-Key` when configured. OC ledgers are public by design; we store organisation funders
  only (individual backers stay off, as today).
- Computation: sum of incoming contributions by funder over 12 months; `topShare = max/total`;
  label "concentrated" when topShare ≥ 0.5 (rule in weights file). Confidence high for the numbers
  OC publishes; note that OC is one channel, so the screen says "of the money visible on Open
  Collective".
- Screen: Funding view (bar per package: total, top-funder share), Package page.

**F3 Funding trend** (new)
- Definition: last 12 months vs the 12 months before, from the same OC data; GitHub Sponsors
  public sponsor count snapshots over time (we snapshot weekly; trend needs ≥ 2 snapshots).
- Computation: `growing` (≥ +20 %), `flat`, `declining` (≤ −20 %), `stopped` (0 in last 6 months
  after > 0 before). Thresholds in the weights file. Confidence high (OC), medium (our snapshots).
- Screen: sparkline in Funding view; Overview tile "funding declining for N production deps".

**F4 Who backs it: employer, foundation, corporate owner** (new)
- Definition: (a) repo owned by an Organization (exists); (b) project hosted by a foundation
  (OpenJS, Apache, Linux Foundation, CNCF, Eclipse) from a curated, sourced list of their projects;
  (c) OC fiscal host (exists as slug); (d) contributors' **self-declared** GitHub profile `company`
  field, shown only aggregated per repo ("3 of the 5 most active contributors declare company X").
- Sources: GitHub users API/GraphQL `company` field [v P0: `User.company: String` in the GraphQL
  schema file above; `"company"` in the REST "Get a user" response example,
  https://docs.github.com/en/rest/users/users]; OpenSSF Scorecard's Contributors check
  uses the same field ("at least 3 different companies in the last 30 commits") [v,
  https://github.com/ossf/scorecard/blob/main/docs/checks.md]. CHAOSS Elephant Factor = minimum
  number of companies whose employees make a given share of commits [v,
  https://github.com/chaoss/wg-risk/blob/main/focus-areas/business-risk/elephant-factor.md].
- Computation: Elephant Factor at 50 % over last 24 months of commits, companies from declared
  `company` (normalised: strip `@`, case-fold, alias table). Confidence low/medium (self-declared,
  often empty); show "unknown" share explicitly.
- Screen: Who's behind it (company/foundation nodes as `org:` entities, relation `member_of`),
  Funding view column "Backed by".

**F5 One funder ties many dependencies** (roll-up, new)
- Definition: for a project/org scope, funders and backing orgs ranked by how many production
  dependencies they fund or own; same shape as today's account concentration.
- Computation: from entity links `funds`/`owns`/`member_of` in the scope's latest inventories,
  reusing `scopeExposure` in `src/server/accounts.ts`. Confidence = weakest link on the path.
- Screen: Exposure page, second concentration section ("Funders and backers").

### 3.2 Stability (S)

**S1 Registry maintainers** (exists): count of npm `maintainers`. The `single_maintainer` factor
and its scoring stay as they are (proven); the count is also shown in the Stability view next to
S2, because publish rights and real contribution often differ. Confidence high.

**S2 Contributor Absence Factor (bus factor)** (new)
- Definition (CHAOSS): the smallest number of contributors whose combined contributions make
  50 % of the total; renamed from "Bus Factor" in 2024 [v, https://chaoss.community/?p=3944].
- Source: the repo's git history. Fetch with a **blobless clone**
  (`git clone --filter=blob:none --no-checkout --bare`), which gives every commit's author,
  committer, timestamps with UTC offsets and signature headers without file contents (git
  partial clone docs: https://git-scm.com/docs/partial-clone [v P0: the "filter" capability and
  `--filter=<filter-spec>` on clone/fetch]). No API quota used. GitHub
  GraphQL is used only to map commits to logins and read `verification` (budgeted, cached).
- Computation: commits on the default branch in the last 24 months, excluding bots
  (`[bot]` logins, `dependabot`, `renovate`, `github-actions`), merge commits counted once;
  identity = GitHub login when the API maps it, else the normalised author email **hash** (never
  stored in clear, see §5). Output CAF and the top-k shares. Also CAF over all history for context.
  Confidence medium (identity mapping). Cross-check: Scorecard Contributors check, and GrimoireLab/
  Augur numbers on 3 repos ([v P0: both resolve; Augur via its README at
  raw.githubusercontent.com/chaoss/augur/main], https://chaoss.github.io/grimoirelab/ ,
  https://github.com/chaoss/augur) — used as a test reference only, not deployed.
- Screen: Stability view column "Rely on", Package page, roll-up.

**S3 Maintainer activity and abandonment** (extend)
- Definition: days since the last commit by any top-CAF contributor, last release, last issue/PR
  response by a member; repo archived; npm deprecated; declared maintenance status.
- Sources: git history (S2), npm `time` + `deprecated` (exists), GitHub `archived` (exists),
  Scorecard **Maintained** check (≥ 1 commit/week over 90 days for full score; archived = lowest)
  [v, https://github.com/ossf/scorecard/blob/main/docs/checks.md].
- Computation (labels, rules in weights file):
  - `inactive`: no commit and no release in 18 months (owner example uses 18 months).
  - `ended`: archived, or npm `deprecated` on the latest version, or README/`package.json`
    declares deprecation (text match on a short fixed list → low confidence, needs a second fact).
  - `quiet`: no commit for 6 months but a release in 18 months.
  Confidence high for archived/deprecated, medium for derived dates.
- Screen: Stability view, Maintenance tab (existing) shows the label, Overview tile.

**S4 Release regularity** (new)
- Definition: median days between releases over the last 10 releases and their spread
  (coefficient of variation); "irregular" when CV > 1.5 and the latest gap > 3× median.
- Source: npm packument `time` (already fetched). Confidence high.
- Screen: Package page sparkline of release dates; Stability view column.

**S5 Ownership and maintainer handovers** (exists; add one signal)
- Exists: `publisher_change`, `maintainer_change`, `repo_transfer` facts.
- New **S5a release-continuity**: a release published (npm `_npmUser`) or tagged by an account
  whose first commit in this repo is < 180 days before the release, or with no commits at all.
  Source: npm packument + git history (S2) + GitHub login mapping. Confidence medium. Wording:
  "Release 3.3.6 was published by an account first seen in this repository 0 days earlier."
- Screen: Changes page (existing), Account page "First seen in these repos".

**S6 Licence change** → see L2.

### 3.3 Maintainers and commit origins (C)

**C1 Contributor continuity**: per repo, share of commits in the last 12 months by contributors
who were already active ≥ 2 years earlier ("long-standing") vs first seen < 12 months ago, and the
same for release tags. A change of > 30 points in a year is shown as "contributor base changed".
Source: git history. Confidence medium.

**C2 Signed/verified commits and releases**: share of commits on the default branch with a
signature header (local), and GitHub's `verification.verified` for the most recent 100 (GraphQL
`Commit.signature: GitSignature`, [v P0: in the published schema file]
https://docs.github.com/en/graphql/reference/objects#commit). Show the
share and a **change** ("signed share fell from 95 % to 10 % after 2024-02"). Scorecard
Signed-Releases is shown as input (signature/provenance files on the 30 latest releases; it does
not verify signatures) [v, checks.md above]. Confidence high for "has signature header",
medium for "verified" (depends on key upload).

**C3 Commit time-zone pattern, aggregated per repo**: histogram of UTC offsets recorded in commit
timestamps (git stores the committer's configured offset) and of commit hour-of-week, per repo per
12-month window. Shown only as a repo-level chart with **change** between windows (total variation
distance ≥ 0.3 flags "pattern changed"). Rules: no per-person histogram is shown or stored; repos
with < 5 contributors in the window or < 100 commits show nothing (k-anonymity floor); never
translated to a country; never an input to any score. Confidence low by definition (offsets are
user-set and trivially changed). Purpose: context for C1 (e.g. xz, §8), never a verdict.

**C4 Organisation jurisdiction (declared public facts only)**
- Org-level fields only: GitHub org `location` (self-declared, shown as such) [v P0: `"location"`
  in the REST "Get an organization" example, https://docs.github.com/en/rest/orgs/orgs, and
  `Organization.location` in the GraphQL schema]; OC collective and fiscal host location/legal
  entity [v P0: `Account.location`, `Account.legalName` by introspection]; foundation/company legal
  entity from the project's own legal pages or an official company register the customer chooses
  (e.g. UK Companies House API https://developer.company-information.service.gov.uk/ [v P0:
  resolves, developer portal]). Each value shows
  its source and "declared by the organisation".
- Individual location: **off by default**; if a customer enables it, only the profile `location`
  string, labelled "self-declared on public profile", never parsed into a country, never used in a
  policy or score.

**C5 Sanctions and jurisdiction policy (org-level)**
- Lists: OFAC SDN list (XML, enhanced XML) [v, https://sanctionslist.ofac.treas.gov/Home/static/sdn.html];
  OFAC consolidated non-SDN lists [v, https://sanctionslist.ofac.treas.gov/Home/static/consolidated.html];
  EU consolidated financial sanctions list
  https://data.europa.eu/data/datasets/consolidated-list-of-persons-groups-and-entities-subject-to-eu-financial-sanctions [v P0:
  the dataset record answers from https://data.europa.eu/api/hub/search/datasets/consolidated-list-of-persons-groups-and-entities-subject-to-eu-financial-sanctions];
  UK sanctions list https://www.gov.uk/government/publications/the-uk-sanctions-list [v P0: page
  lists CSV, ODS and other downloads with update notes].
- Matching: only `org:`/`funder:` entities (companies, fiscal hosts, foundations), exact normalised
  legal-name match plus one more identifier (country of registration or address) → status
  "possible match, needs review". A person entity is never matched automatically.
- User policy: rules on declared org facts, e.g. `funderCountry in [..]` or
  `sanctionsMatch == confirmed` → a policy finding with the rule name. Country of a person can
  never be a policy input (enforced in the rule schema).
- Existing `sanctions` incident type and `OFFICIAL_SANCTIONS_HOSTS` stay; add EU/UK hosts after
  verification.

### 3.4 Licences and bill of materials (L) — all from others

**L1 Declared licence per component version**: deps.dev `GetVersion` returns licences [v,
https://docs.deps.dev/api/v3/; v P0: `licenses[]` are "SPDX 2.1 expressions", "non-standard" when
there is no SPDX identifier, empty when unknown, relationship between several "unspecified"; npm
licences are "read from the package metadata", Go licences come from the licensecheck package;
v3alpha adds `licenseDetails[]` = author's string + SPDX mapping and `GetVersionBatch`
(POST /v3alpha/versionbatch, answered in pages of 100)]; already fetched in `src/enrich/depsdev`.
Fallback: npm per-version `license` field. Normalise to SPDX expressions using the SPDX License List data
(https://github.com/spdx/license-list-data, JSON `licenses.json` with `isOsiApproved`,
`isDeprecatedLicenseId` [v via secondary sources]; data licence stated as CC-BY-3.0 by a secondary
source [u: the repo README says "see the respective repositories for licensing information" and
neither repo states one; P1 uses the CC0-1.0 npm packages spdx-license-ids and
spdx-expression-parse instead, so nothing depends on it]). deps.dev terms [v P0: "Use of the
deps.dev API is subject to the Google API Terms of Service. Clients are expressly permitted to cache
data served by the API"; generated data CC-BY 4.0; contact depsdev@google.com]; rate limits not
published [v: searched]; keep the existing cache and concurrency. Confidence high (declared).
Transitive coverage: everything in the inventory (npm lockfile is already full-tree; Syft adds
other ecosystems).

**L2 Licence change**: a component whose declared SPDX expression differs between the version in
use and (a) the previous version used by this project, (b) the latest version. Category change
(permissive → copyleft → source-available/non-OSI) is called out. Source: deps.dev versions list +
L1. Confidence high. This catches Terraform MPL-2.0 → BUSL-1.1 type events (§8).

**L3 Discovered licences** (optional, later): ClearlyDefined definitions (`licensed.declared`,
discovered expressions, a licence score) from `https://api.clearlydefined.io` [v: host and
curated-definition model, https://github.com/clearlydefined/service; v P0: POST /definitions takes
a list of coordinates and returns `{coordinate: definition}` (OpenAPI at
https://api.clearlydefined.io/schemas/swagger.yaml), `?expand=-files` drops the file list; rate
limits POST /definitions 250/min, other endpoints 2,000/min (https://docs.clearlydefined.io/docs/get-involved/using-data,
and `ratelimit-policy: 2000;w=60` on responses); "all the data is distributed under CC0"
(https://docs.clearlydefined.io/docs/resources/faq)]. P1 already uses it as the second source.
We do **not** run our own scanner; customers who need file-level results run ScanCode
(https://github.com/aboutcode-org/scancode-toolkit [v P0: README via raw.githubusercontent.com]) or ORT
(https://github.com/oss-review-toolkit/ort [v P0: README via raw.githubusercontent.com]) and we import their output (ScanCode JSON, ORT
evaluated model, or SPDX/CycloneDX SBOM).

**L4 Compatibility and obligations (policy, not legal advice)**: a customer-editable policy maps
SPDX ids/categories to `allow` / `review` / `deny` per distribution type (SaaS, distributed
binary, internal). Defaults ship as a conservative template modelled on ORT's rule approach [v P0:
ORT evaluates `evaluator.rules.kts` policy rules against `license-classifications.yml`,
https://oss-review-toolkit.org/ort/docs/configuration/evaluator-rules];
obligations text links to the licence text on spdx.org. Output: "component X (AGPL-3.0-only)
needs review for distributed use", with the policy rule named.

**L5 SBOM in and out**: import CycloneDX/SPDX SBOMs (Syft today; add file import); export a
CycloneDX 1.5/1.6 SBOM with licences and our stability/funding annotations as properties [v P0 spec
URL https://cyclonedx.org/specification/overview/: current version 1.7 (2025-10-21), media type
`application/vnd.cyclonedx+json`; P1 exports 1.6 with the OWASP library and validates it against
the 1.6 schema].

### 3.5 Issues around it (I) — curated events with sources

Extend the incident KB (`src/incidents/schema.ts`) with event types that are **not incidents**:
`funding_change`, `maintainer_stepping_away`, `relicensing`, `going_commercial`,
`governance_dispute`, `sponsor_in_difficulty`. Each event: subject entities, date, status
(`confirmed` / `reported` / `disputed` / `retracted`), confidence, ≥ 1 source URL, and a neutral
one-line summary that passes the existing judgement-word lint.

Some are **proposed automatically** from facts and need a reviewer before display as an event:
licence category change (L2) → `relicensing`; archived/deprecated (S3) → `maintainer_stepping_away`
proposal only if the deprecation text says so; funding `stopped` (F3) → `funding_change`. The
rest (blog posts, governance disputes) are curated with sources, as the incident KB is today.

---

## 4. Scoring and labels (explainable, no ML)

Stability is a **separate label per package**, not part of the risk score:

| Label | Rule (any) | Shown as |
|---|---|---|
| **Fragile** | (CAF = 1 **and** S3 `inactive`, on a package that is **not** small and finished) · (CAF = 1 **and** F3 `stopped`) · S3 `ended` while a production dependency · an open OSV advisory with no fixed release on a version in use **and** S3 `inactive` or `ended` | amber, with the triggering rules |
| **Watch** | CAF = 1 **and** S3 `inactive` on a small, finished package ("small, finished package: single maintainer, no recent activity") · CAF = 1 · S3 `quiet` · F2 concentrated ≥ 0.5 with F3 `declining` · S5a release-continuity · L2 category change · C1/C2 change | neutral with dot |
| **Steady** | none of the above with ≥ medium-confidence data for S2 and S3 | plain |
| **Unknown** | no git history or no repo | grey, says what is missing |

Rules and thresholds live in one file (`src/stability/rules.ts`) like `weights.ts`. Every label
lists its reasons with source and confidence; a label from low-confidence facts only is capped at
Watch. **P3 clarifications** (built as written in §10): S3 `inactive` with CAF ≠ 1 (or CAF
unknown) is Watch, since the table would otherwise make an inactive package Steady while a quiet
one is Watch; `quiet` is "no commit for 6 months, not inactive" (the table's wording left out a
package with a commit in the last 18 months but no release); C1 counts only together with another
signal (CAF = 1, S3 quiet/inactive, S4 irregular, a new top committer, S5a, C2), alone it is context
(P2 found it on healthy express); C2 counts only when the signed share fell; S5a, C1, C2 and L2
count when dated within the last 12 months; C3 never counts. F2/F3 are not assessed before P4. The existing intrinsic risk score is unchanged (it is proven); the only cross-over is that
S5a can be shown beside an existing ownership-change finding.

Roll-up (R1) per project/org scope, production dependencies only by default:
- distinct people in the union of each package's CAF set ("these 12 rely on 3 people");
- distinct funders/backers covering them (F5);
- counts by label and by S3 state ("2 had no maintainer activity for 18 months");
- licence policy counts (L4).
Numbers link to the filtered list behind them.

---

## 5. Privacy and legal guardrails

Builds on `docs/PLAN.md` §7 (legitimate-interest assessment, public professional data only,
retention, objection route, sources and status on every claim, no nationality profiling).

- **Minimisation.** Store GitHub logins and npm handles (already public account ids). Git author
  emails and names are used in memory to map identities and are **stored only as salted hashes**
  for de-duplication; never shown, never exported. Per-person data kept = counts per window and
  first/last-seen dates per repo. No per-person time-zone or hour-of-day data is stored (C3 is
  aggregated before storage).
- **Retention.** Raw blobless clones are a cache, deleted after aggregation or after 30 days.
  Per-person aggregates kept 12 months after the package leaves all inventories; repo aggregates
  as long as the repo is in scope. Funding amounts only for organisations.
- **No inference of nationality, ethnicity or country** from name, time zone, email, IP or
  language. Enforced by tests: the person entity type has no country field; policy rule schema
  rejects person-level location; C3 output has no per-person shape.
- **Not an accusation.** Fixed wording patterns: "declares", "was published by an account first
  seen…", "pattern changed", "reported by <source>". The existing judgement-word lint runs on all
  generated text. Every view carries the existing disclaimer ("Public links with sources. Not a
  finding of wrongdoing.").
- **Terms of sources.** ecosyste.ms data is CC BY-SA 4.0, code AGPL; free tier 300 requests/hour,
  more with an API key or paid plan [v, https://ecosyste.ms/pricing ,
  https://docs.ecosyste.ms/docs/usage/]. Share-alike means anything we **redistribute** that is
  derived from it must carry the same licence: use it as a fallback lookup (repo URL resolution,
  funding links, dependents), attribute it on screen, and do not mix it into exported data
  without a commercial licence. GitHub: authenticated tokens, back-off on 403/429 (exists).
  Open Collective, deps.dev: cache, low concurrency, identify via User-Agent.
- **Objection/correction.** A person or org can ask to hide or correct a link; the entity review
  table (`src/entities/review.ts`) gets a `suppressed` state that wins over any automatic rule.
- **Sanctions.** Org-level only, official lists only, "possible match, needs review" until a
  human confirms; never automated against people.
- **Agentic gap-filler (§10 "Agentic gap-filler"), enforced in code and tested.** No task, prompt
  or tool may infer or store an individual's nationality, ethnicity or country, from a name, email,
  time zone, IP, language or any other indirect signal. Why: national origin is a protected
  characteristic (and ethnicity special-category data under GDPR Art. 9); values inferred from such
  signals are unreliable (a name, a time zone or an email domain says little about a person); and
  storing them would create GDPR exposure for every customer who runs a scan (profiling, Art. 22,
  and data they would have to justify, secure and answer access requests for). Enforcement:
  task registration refuses person-level tasks other than the two below and any prompt that asks
  for protected attributes or location inference; request screening refuses such questions before
  any model call; every proposed value is screened (nationality, ethnicity, citizenship, religion,
  time zone, UTC offset, IP keys or values are refused and **not stored at all**, not even as an
  unverified proposal; location keys only in the org jurisdiction task); the gate binds task and
  subject to the request. Person-level data is limited to (a) `person_self_declared_location`: the
  location field as the person wrote it on their own profile, the whole field, labelled
  "self-declared", with the profile URL; and (b) `contributor_identity` (owner scope, 2026-10-11):
  what a contributor published themselves (account and creation date, display name, company,
  website, bio, organisation memberships, location as (a), signing keys, and roles on public pages
  that name the account). Both are off unless person tasks are turned on (`--agentic-people`),
  shown only to `manage_projects`, removable on request (value, quote and URL wiped for good), and
  never parsed into a country or used in any score or policy. Time zones stay repo-level (P2).

---

## 6. Phases (small steps, each with a gate)

Effort in developer-days (1 dev). Each phase lands behind its own test/gate and is shippable.

| Phase | Scope | Gate (must pass to merge) | Effort |
|---|---|---|---|
| **P0 Verify and record** | Re-check every [u] source in this doc; record API fixtures (offline, existing `HttpClient` fixtures) for the 12 validation subjects in §8; add fact kinds `license`, `license_change`, `contributors`, `release_cadence`, `funding_detail`, `org_profile` to `src/core/types.ts` | All [u] resolved or removed; fixtures replay offline; type tests | 2 |
| **P1 Licences (L1, L2, L4)** | Emit `license` facts from deps.dev (already fetched) + npm fallback; SPDX normalisation with a vendored, version-pinned licence list; `license_change`; policy file; Licences tab on project; licence columns in JSON/HTML reports | Unit tests on SPDX parsing; on fixtures, L2 reports MPL-2.0→BUSL-1.1 for Terraform, Apache-2.0→SSPL/Elastic for Elasticsearch, BSD-3→RSAL/SSPL for Redis (§8, via deps.dev for their ecosystems); 0 licence changes on the 5 control repos that are not real | 4 |
| **P2 Git history collector (S2, C1, C2, C3)** | Blobless bare clone cache (hook-free, size cap, timeout, same safety as `src/ingest/git.ts`); per-repo aggregates; GitHub GraphQL login mapping + verification with a point budget; hashed emails | CAF within ±1 of a hand count on 3 repos; xz and event-stream expectations in §8; storage test proves no clear-text email and no per-person time-zone rows; budget ≤ 2,000 GraphQL points per 300-repo scan | 5 |
| **P3 Stability labels (S3, S4, S5a)** | `src/stability/` rules; labels on Maintenance tab and Package page; Changes page shows S5a | §8 expectations for request, moment, left-pad, colors, core-js; on control repos, 30 random Fragile/Watch labels reviewed by hand: ≥ 27/30 have correct facts (gate is factual accuracy, not "risk") | 4 |
| **P4 Funding (F1–F5)** | funding.json; GitHub Sponsors listing; OC 12-month totals, top share, trend; weekly snapshots; foundation list; employer aggregate; funder roll-up | §8 expectations for core-js, babel, webpack, express; snapshot job idempotent; individual backers still excluded by default (test) | 5 |
| **P5 Issues around it (I)** | KB schema types + proposals from facts; review queue reuses incident review | `kb validate` passes; judgement-word lint on all templates; seeded events for HashiCorp, Elastic, Redis, core-js, colors/faker carry sources | 3 |
| **P6 Views and roll-up (R1)** | Stability view, Funding view, Overview tile, Exposure "Funders and backers" section, Who's behind it rail additions, Package page sections, Account page "first seen in repos" | Component tests + e2e on fixtures; every chart has a table view (existing ViewToggle pattern); roll-up numbers equal API counts (contract test) | 6 |
| **P7 Org jurisdiction and policy (C4, C5)** | Org profile facts; OFAC SDN/consolidated import (and EU/UK once verified) into a versioned list pack; matcher; policy rules | Synthetic list test (true match, near miss, person name never matched); schema test rejects person-level location in policy | 4 |
| **P8 Privacy ops** | LIA update, retention jobs, suppression state, export excludes hashes | Retention test with fake clock; suppression wins over rules | 2 |

Total ≈ 35 dev-days. Order: P0 → P1 (quick win, data already fetched) → P2 → P3 → P4 → P6;
P5, P7, P8 can run in parallel once P0 is done. Each phase reports its gate result in this doc.

---

## 7. What we show from others vs what we compute

| Shown from others (source named on screen) | Computed by us (rule named on screen) |
|---|---|
| OSV / GHSA / OpenSSF malicious-packages records, CISA KEV, EPSS | Which projects, paths and owners are exposed (exists) |
| OpenSSF Scorecard score and checks (Maintained, Contributors, Signed-Releases) | Stability label (§4) and its reasons |
| deps.dev declared licences, provenance, dependents | Licence change between versions (L2); policy result (L4) |
| ClearlyDefined / ScanCode / ORT licence findings (imported) | — (never our own scanner) |
| npm maintainers, publishers, deprecation, release dates | Release regularity (S4); release-continuity (S5a) |
| FUNDING.yml, funding.json, package.json funding, Sponsors listing | Funding channel union (F1) |
| Open Collective ledger numbers | Top-funder share, trend (F2, F3) |
| GitHub profile `company`, org `location` (self-declared) | Elephant Factor (F4); never a person's country |
| Official sanctions lists | Org-level match proposal (C5) |
| Git history (raw commits) | CAF (S2), continuity (C1), signed share (C2), repo time-zone pattern change (C3) |
| Curated news/blog sources for events | Event proposals from facts (I) |
| — | Roll-up across people and funders (R1, F5) |

---

## 8. Validation on real repos (expected outputs)

Pre-registered: these expectations are written before P1–P4 code. A phase passes when its rows
match; a miss is either fixed or written up here with the reason. Dates are "as of" the event,
replayed with the existing historical mode (`ctx.historical`) where data allows.

| # | Subject | Known event (source) | Expected output |
|---|---|---|---|
| 1 | `event-stream` (npm) | Handed to a new maintainer in 2018; malicious dependency `flatmap-stream` added (https://github.com/dominictarr/event-stream/issues/116, in KB `kb/incidents/2018-event-stream.yaml`) | S1: 1 maintainer before; `maintainer_change` (exists); **S5a** for 3.3.6: published by an account first seen in the repo < 180 days before; C1 "contributor base changed"; label Watch before the event, no claim of intent. **P2 result (git part, met):** see §10. **P3 result: met** (Watch at 2018-11-26: CAF 1 and S5a; the npm side names 3.3.5, not 3.3.6: the account's first npm release, published 1 day after it was first seen in the repository) |
| 2 | xz-utils (git history only, mirror `github.com/tukaani-project/xz`) | Backdoor CVE-2024-3094 in 5.6.0/5.6.1 (https://nvd.nist.gov/vuln/detail/CVE-2024-3094 , https://www.openwall.com/lists/oss-security/2024/03/29/4) | S2: CAF 1–2 over 2019–2021 (one long-standing maintainer); C1: a contributor first seen ~2021 becomes top committer and tags releases by 2024; C2/C3 shown as aggregate repo changes if present; wording "contributor base changed", no statement about any person. **P2 result: met**, with two corrections: the account's first commit is 2022-02 (not ~2021), and the C1 share rule fires on scans dated 2023-08 to 2024-02 but not at 2024-03-28 (see §10) |
| 3 | `colors` and `faker` (npm) | Maintainer-published sabotage releases, January 2022 (GHSA-gh88-3pxp-6fm8, GHSA-5w9c-rv96-fr7g; KB `2022-colors-faker.yaml`) | Before: S1 = 1, S2 CAF = 1, label Watch; `faker` later deprecated → S3 `ended`; community fork `@faker-js/faker` shows org owner and OC collective (F1) [v P0: collective `fakerjs`, type COLLECTIVE, OC API]. **P3 result: two misses** — colors at 2021-12-31 is **Fragile**, not Watch (CAF 1 and no commit or release since 2019-12-31 / 2019-09-22, the plan's own Fragile rule); faker is **Unknown**: its repository is no longer public and no faker release is deprecated on npm (see §10) |
| 4 | `left-pad` (npm) | Unpublished March 2016 (https://blog.npmjs.org/post/141577284765/kik-left-pad-and-npm) | S1 = 1, CAF = 1; latest version deprecated → S3 `ended` [v P0: 1.3.0 is deprecated, message "use String.prototype.padStart()"]. **P3 result: met** (S3 ended: npm deprecation and Scorecard "project is archived"; Fragile in production; CAF of the last active 24 months is 2, CAF 1 at the 2016 unpublish per P2; S1 today is 2) |
| 5 | `core-js` (npm) | Maintainer's 2023 funding statement (https://github.com/zloirock/core-js/blob/master/docs/2023-02-14-so-whats-next.md); README says not backed by a company [v via README text] | S2 CAF = 1; F1 ≥ 3 declared channels incl. Open Collective; F4 owner is a User, no company backer; F2/F3 from OC; I: `funding_change` event (curated, source = the post). **P3 result: met for S2** (CAF 1, label Watch with "funding not yet assessed"; F/I rows are P4/P5) |
| 6 | `request` (npm) | Deprecated Feb 2020 (https://github.com/request/request/issues/3142) | S3 `ended` (npm deprecated [v P0: 2.88.2 "request has been deprecated, see https://github.com/request/request/issues/3142"]; repo archived: corrected, the repo is **not** archived [v P0: OpenSSF Scorecard 2026-10-05 Maintained check reports "0 commit(s) and 0 issue activity … in the last 90 days", not "project is archived"]); label Fragile if in production; high dependents (deps.dev) shown. **P3 result: met** (Fragile, rule "S3 ended while a production dependency", fact: the npm deprecation of 2.88.2; the README's "Deprecated!" is shown as low-confidence context) |
| 7 | `moment` (npm) | Project declared maintenance mode in 2020 (https://momentjs.com/docs/#/-project-status/ [v P0: docs say "Moment.js is a legacy project in maintenance mode"]) | S3 `quiet`/`ended`-declared (low confidence text + release gap); S4 irregular; label Watch, not Fragile (team still exists). **P3 result: label met, reasons missed** — Watch, not Fragile, but through CAF 1 and S5a: moment released 2.31.0 on 2026-09-15 after a 993-day gap, so the declared maintenance mode has no second fact (context only), S3 is active and S4 is not irregular (CV 1.32 < 1.5); the S5a observation is an e-mail change of a long-standing maintainer (§10) |
| 8 | Terraform (Go module `github.com/hashicorp/terraform`) | MPL-2.0 → BUSL-1.1, August 2023 (https://www.hashicorp.com/blog/hashicorp-adopts-business-source-license [u: answers 429 here]; [v P0: LICENSE at tag v1.5.7 is "Mozilla Public License, version 2.0", at v1.6.0 the Business Source License]); OpenTofu fork | L2: category change permissive/weak-copyleft → source-available at v1.6.0 [v P0 version]; I: `relicensing` proposal. **P1 result: not visible through deps.dev**, see the P1 gate below |
| 9 | Elasticsearch | Apache-2.0 → SSPL/Elastic License in 2021, AGPL option added 2024 (https://www.elastic.co/blog/elasticsearch-is-open-source-again [v P0: Shay Banon, 2024-08-29]; LICENSE.txt at v7.10.2, v7.11.0, v8.16.0 [v P0]) | L2 twice: to non-OSI (2021), then OSI option added (2024) |
| 10 | Redis | BSD-3 → RSALv2/SSPLv1 on 2024-03-20 (https://www.theregister.com/2024/03/22/redis_changes_license [v]); AGPLv3 option in Redis 8 (2025) [v P0: announced 2025-05-01, https://redis.io/blog/agplv3/; LICENSE.txt at tag 8.0.0]; Valkey fork | L2 at 7.4 [v P0: LICENSE.txt at tag 7.4.0 states RSALv2/SSPLv1 from 7.4]; `pkg:docker/redis` image licence shown as "declared by image metadata or unknown". **P1 result: not visible through deps.dev**, see the P1 gate below |
| 11 | `@babel/core`, `webpack` (npm) — positive controls | Long-funded via Open Collective [v P0 slugs: `babel`, `webpack`, both COLLECTIVE] | F1 OC channel; F2 multiple funders, top share < 0.5 [u: a P4 measurement]; S2 CAF ≥ 2 (**P2: miss for webpack**, 24-month and all-history CAF = 1, see §10); label Steady. **P3 result:** @babel/core Steady (CAF 2 on the whole babel repository); webpack **Watch** (CAF 1, follows the P2 miss) |
| 12 | `express` (npm) — foundation control | OpenJS Foundation project [v P0: listed on https://openjsf.org/projects] | F4 foundation backer; CAF ≥ 2 [measured P2: CAF = 6 over the 24 months to 2026-10-11, hand count 6]; label Steady or Watch with reasons. **P3 result: met** (Steady; the 2025 "contributor base changed" is outside the 12-month window and alone would only be context) |

Estate roll-up check: on the existing control repos and the logops scan used in
`docs/NEXT-LEVEL.md`, R1 sentence numbers must equal a hand count from the API rows for one repo.

**Licence ecosystem note.** Our inventory is npm + GitHub Actions + Docker (+ Syft for others).
Rows 8–10 are checked through the deps.dev licence history of their own ecosystems (Go, Maven,
Docker image labels) in a test harness, which tests L2's logic; they become product rows only
where Syft brings those components into an inventory.

---

## 9. Top risks

1. **Identity mapping errors** (git email → login) skew CAF and continuity. Mitigation: medium
   confidence, show "N commits unmapped", never label on an unmapped-only set.
2. **Misreading stability as risk or blame.** A single-maintainer, well-kept package is normal.
   Mitigation: separate label, no effect on risk score, factual wording, Steady is the default.
3. **Time-zone signal misuse.** Even aggregated, it can be read as nationality. Mitigation: k-floor,
   change-only display, no score input, tests that block per-person shapes; drop C3 if review
   finds it misleading on the validation set.
4. **Funding opacity.** Sponsors amounts are mostly private; OC is one channel. Mitigation: say
   "visible on Open Collective"; declared ≠ received.
5. **Source terms.** ecosyste.ms CC BY-SA share-alike on redistribution; deps.dev/OC limits
   unpublished. Mitigation: attribution, no redistribution without licence, cache, back-off.
6. **Licence data quality.** Declared licences are often missing or wrong. Mitigation: show
   "declared" vs "discovered" (imported ScanCode/ClearlyDefined), "unknown" counted, policy says
   "review", never "allowed" on unknown.
7. **Sanctions false matches.** Mitigation: org-level, exact + second identifier, human confirm.
8. **Cost of history.** Blobless clones of large repos (hundreds of MB of commits). Mitigation:
   size cap, shallow-since 3 years (`--shallow-since`), shared cache across projects.
9. **Coverage.** npm-first; Go/PyPI/Maven only via Syft. Stated on every roll-up.

---

## 10. Gate results

### P0 Verify and record (2026-10-11)

- **[u] resolved:** 28 of 34 now [v P0] from primary sources (official docs, API responses and
  introspection, licence files at release tags); 6 left [u] with the reason inline. Nothing P1
  depends on is still unverified.
- **Fixtures (replay offline):** `blastradius/test/fixtures/licenses/recorded/` (deps.dev
  GetPackage + GetVersionBatch, ClearlyDefined definitions, deps.dev GetProject for two actions) for
  the licence validation subjects in `blastradius/test/licenses/subjects.ts`, and
  `test/fixtures/licenses/e2e-repo/` for the dev-seed repository as of 2018-11-27. Recorded once
  by `test/licenses/record.ts`, trimmed to the fields read. P2–P4 subjects get their fixtures in
  their own phases (their collectors do not exist yet, so there is nothing to replay).
- **Fact kinds:** `license`, `license_change`, `contributors`, `release_cadence`,
  `funding_detail`, `org_profile` in `src/core/types.ts` with value types; a type test builds one
  of each.

### P1 Licences (2026-10-11)

Built with established tools only: deps.dev (primary) and ClearlyDefined (second source) data,
spdx-expression-parse 5.0.0 and spdx-correct 3.2.0 (corrections that add a version are refused),
Blue Oak Council list and copyleft guide (@blueoak/list 15.0.0, @blueoak/copyleft 10.0.0, CC0-1.0)
for categories, ScanCode LicenseDB categories (CC-BY-4.0) for licences Blue Oak does not cover,
SPDX expression semantics for policy (cross-checked against spdx-satisfies 6.0.0 in tests), the
OWASP CycloneDX library 10.3.0 for the CycloneDX 1.6 export and the SPDX 2.3 JSON schema for the
SPDX export. Migration 11 adds the org licence policy table.

Gate, on recorded deps.dev data (`test/licenses/licenses.test.ts`):

| Subject | deps.dev shows | Result |
|---|---|---|
| Elasticsearch (`org.elasticsearch:elasticsearch`, Maven) | Apache-2.0 → Elastic-2.0 + SSPL-1.0 at **7.11.0 (2021-02-10)**; AGPL-3.0 added at **8.16.0 (2024-11-12)** | both changes reported; first is a category change (permissive → source-available); second adds AGPL-3.0 but deps.dev does not say the three are alternatives, so the category stays source-available (most restrictive) |
| React (npm) | BSD-3-Clause → MIT at **15.6.2 (2017-09-26)** | reported; for 15.6.1 in use it is "upgrading past it changes the licence"; ClearlyDefined's `BSD-3-Clause AND LicenseRef-scancode-facebook-patent-rights-2` for 15.6.1 is shown as a source disagreement |
| immutable (npm) | BSD-3-Clause → MIT at **3.8.2 (2017-10-03)** | reported |
| sentry (PyPI) | "BSD" for 9.1.2, **no licence data for the 7 releases 10.0.0–20.8.0**, "BSL-1.1" from 20.10.1 (both non-standard) | **corrected 2026-10-11.** First result was wrong: we reported the change *at 20.10.1*, the first release deps.dev had data for again. PyPI's own metadata says `info.license` "BSL-1.1" (classifier "Other/Proprietary License") for 10.0.0, uploaded **2020-01-07**, and "BSD" for 9.1.2. Now reported at **9.1.2 → 10.0.0** from source `registry` (evidence `https://pypi.org/pypi/sentry/10.0.0/json`), with deps.dev's own view shown beside it: "between 9.1.2 and 20.10.1, 7 releases without licence data". For 10.0.0 in use it now says "already in the version you use" (before: "upgrading past it changes the licence") |
| Terraform (Go, row 8) | MPL-2.0 (+ BSD-3-Clause from v1.1.0) for every release, also after v1.6.0 | **miss, explained:** deps.dev derives Go licences with licensecheck, which does not report BUSL-1.1; the LICENSE at tag v1.6.0 is BUSL-1.1 [v P0]. The deps.dev project record says `non-standard` today. Not fixable without our own scanner (out of scope); ClearlyDefined has MPL-2.0 for v1.5.7 |
| Redis (row 10) | not in deps.dev (no Docker or C sources; the Go module `github.com/redis/redis` stops at 2010) | **not measurable through deps.dev**; the change is verified from LICENSE.txt at tags 7.4.0 and 8.0.0 [v P0] |
| Controls: express, lodash, webpack, @babel/core, chalk (npm) | one licence across the releases compared | **0 changes** each |

Gaps (correction, 2026-10-11): a change found across releases without licence data is a range
("changed between 9.1.2 and 20.10.1; 7 releases in between had no licence data"), never pinned to
the next release with data; a version in use inside the range is "cannot place it". Gaps are
filled from the package registry's own declared metadata, source `registry` with an evidence URL:
PyPI JSON API `info.license_expression` (PEP 639), else `info.license`, else the License
classifiers; npm packument `versions[v].license`. Asked only for the releases around a gap a change
was found across (sentry: 9 PyPI requests, recorded in `test/fixtures/licenses/recorded/pypi-*`).
Values from the two sources are compared like with like when the registry has both sides, so a
different spelling of the same licence is not a change. Elasticsearch, React, immutable and the
controls are unchanged (no gaps there, no registry request). Tests added: 4 history unit tests
(range wording and placement, registry fill, partial fill, like-with-like), 7 gate tests (sentry
at 10.0.0 from the registry with deps.dev's range; the same data without the registry as a range;
the in-use relation for 9.1.2 / 10.0.0 / 20.7.0; the registry asked only for sentry; synthetic
npm-packument and PyPI field-order cases), range wording in the HTML report and SBOM, 1 web test.

Also (new tests): 40 unit tests in `src/licenses/licenses.test.ts` (19 SPDX parsing and
normalisation cases, categories, policy incl. "unknown is never allowed" and an spdx-satisfies
cross-check over 196 expressions, history, values and report), 9 gate tests above, 7 SBOM tests
(CycloneDX 1.6 validated against the official schema, SPDX 2.3 against the published schema,
CycloneDX round-trip through the SBOM import), 8 API tests (policy applied at read time,
validation, permissions, audit, SBOM downloads), 5 web component tests and 5 Playwright e2e tests
for the Licences view (including axe, light and dark).

Deferred: per-distribution-type rules (SaaS / distributed / internal) in the policy (L4); "previous
version used by this project" (L2 a) needs a scan-to-scan licence diff on the Changes page;
`relicensing` event proposals (P5); ScanCode/ORT result import (L3).

### P2 Git history collector (2026-10-11)

Built from established methods only: git partial clone (`--filter=blob:none`,
https://git-scm.com/docs/partial-clone), git's fixed log formats (https://git-scm.com/docs/pretty-formats,
https://git-scm.com/docs/git-for-each-ref) and `.mailmap` (https://git-scm.com/docs/gitmailmap); the
CHAOSS Contributor Absence Factor (https://chaoss.community/?p=3944, its worked example is a unit
test) and Occasional Contributors (https://chaoss.community/?p=3466, filter "minimum number of
contributions" set to 3: 1–2 commits = occasional, the rest regular); GitHub's documented no-reply
address forms (https://docs.github.com/en/account-and-profile/reference/email-addresses-reference [v])
and GraphQL cost formula (https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api,
read from the docs source; worked example 5,101 requests → 51 points is a unit test); the field
names `Commit.history`, `Commit.author.user`, `Commit.signature.isValid`, `Repository.object(oid:)`
checked in GitHub's published schema file; `npm version`'s default commit message `"%s"`
(https://docs.npmjs.com/cli/v10/using-npm/config#message [v]) to see untagged releases.

Code: `src/history/` (clone cache and reader `git.ts`, identities `identity.ts`, aggregates
`aggregate.ts` with every threshold in `HISTORY_RULES`, GraphQL mapping `graphql.ts`, report
`report.ts`), enricher `src/enrich/history/` (opt-in `--history`), fact kind `commit_history` next
to P0's `contributors`, and `ScanResult.history`. No migration: the aggregates are stored inside
the scan result, like licences (highest migration stays 11).

How it reads history. Bare blobless clone of the default branch plus all tags, hook-free (same
config as `src/ingest/git.ts`, plus `--template=`, no working tree), killed past a size cap (300 MB
default) or a timeout; cached 30 days. Reads run with `protocol.allow=never`, so nothing can fetch
blobs; the only blob fetched on purpose is `.mailmap`. Three `git log` passes: people (author and
committer with mailmap, committer date, subject; **no time zone**), signature headers
(`gpgsig`/`gpgsig-sha256` presence), and time zones (author offset and hour of week, **no person
fields**, summed per month at once). Emails become `hash:` + HMAC-SHA256 under an installation
secret (or the login in a GitHub no-reply address) as they are read; names, messages and emails are
never returned. Windows use the committer date, as `git log --since` does.

**Gate: CAF within ±1 of a hand count on 3 repositories — met (difference 0 on all three).**
Method: on the recorded head, `git shortlog -sne --since=2024-10-12T00:00:00Z
--until=2026-10-11T23:59:59Z <head>` (the computed window: 24 months to the recording time
2026-10-11T19:52Z), remove bots, merge by hand the entries that are one person (same email under
two names, or the same name under two emails), sort, and take the smallest number of people that
reach 50 % (CHAOSS).

| Repository (head) | Hand count | Computed |
|---|---|---|
| xz (`3b1efb04`) | 446 commits, 16 people, no bots or duplicates; top person 426 (95.5 %) → **CAF 1** | 446 commits, CAF **1**, top share 0.955 |
| core-js (`b848c61f`) | 1,635 commits, 15 entries, one person under two emails (5 + 4) → 14 people; top 1,513 (92.5 %) → **CAF 1** | 1,635 commits, CAF **1** (the two-email person stays split: 15 ids, no effect) |
| express (`a419aa73`) | 196 entries, 55 dependabot commits removed → 141; merged: one email under two name spellings (15 + 3), one email under two names (14 + 2), one name under two emails (1 + 1); top 21, 18, 16, 8, 7, 4 → cumulative 70 < 70.5 at five, 74 at six → **CAF 6** | 141 commits, CAF **6**, same top counts (one email = one id merges the first two pairs; the two-email person stays split, outside the CAF set) |
| xz, 24 months to 2021-12-31 | 104 commits, top 96 (92.3 %) → **CAF 1** | 104 commits, CAF **1** |

**Gate: §8 rows on recorded real data (`test/history/history.test.ts`) — met, two corrections.**

- Row 2, xz-utils: CAF 1 over 2019–2021 (every 12-month window). The account that later released
  5.6.0 first appears in the history on 2022-02-06 (committer date; the plan said ~2021). Its first
  release is v5.2.11 on 2023-03-18, 405 days after first seen ("release handover"). Scans dated
  2023-08-01 to 2024-02-01 report "contributor base changed" (long-standing share 85 % → 52 % at
  2023-08-01, 78 % → 29 % at 2024-02-01); from 2023-12-01 the window's top committer is a recent
  account that also made most of the window's releases (`release_takeover`; 8 of 8 at 2024-02-01,
  9 of 9 at 2024-03-28); from 2023-09-01 the repo-level time-zone pattern changed (distance 0.48 at 2024-02-01; both
  windows above the k-floor). **Limitation found:** at 2024-03-28 the C1 share rule no longer fires,
  because that account passes the 24-month "long-standing" line in 2024-02 and its commits count as
  long-standing again (share back to 95 %); the takeover observation still shows. C2: signed share
  stayed at 0–1 % around the event (no change to report); it rose from 0 % to 98 % in the 12 months
  to 2025-10-11.
- Row 1, event-stream, scan of 2018-11-26: CAF 1 (24 months, 22 commits); "contributor base
  changed" 33 % → 0 %; `release_takeover`: the top committer, first seen 2018-09-04, made 4 of the 4
  releases of the year (3.3.5, 3.3.6, 4.0.0, 4.0.1 — the version commits `npm version` makes and two
  lightweight tags); S5a git part: 3.3.6 was made 5 days after that account was first seen (its
  first release, 3.3.5, 1 day after). No takeover on a scan of 2018-08-01. The npm-publisher side
  of S5a is P3.
- Controls express, webpack, core-js: no `release_takeover` in the last three years. express
  shows "contributor base changed" (50 % → 16 %, 12 months to 2025-10-11); checked by hand by
  name, it is real (the three most active people of that year first committed between 2024-02 and
  2024-10), so it is a factual C1 observation, not a false flag (row 12 allows Watch with reasons).
- Other rows measured: core-js CAF 1 (row 5, met); left-pad CAF 1 at the 2016-03-23 unpublish
  (row 4, met; 2 over all history today); **webpack CAF 1** over 24 months (top 58.7 %) and over all
  history, so row 11's "CAF ≥ 2" is a miss: the expectation does not hold on the real history.
- Every generated sentence passes the existing judgement-word lint and contains no id or email.

**Gate: storage privacy — met** (`src/server/history-privacy.test.ts`). A real local repository
(known names, emails, offsets, a `.mailmap`, a bot, a signature header) is read by the real reader
and stored as a scan with the recorded xz history; the test then reads the SQLite file bytes and
finds none of the contributor emails or names (the only email-shaped string is the app user's own
login), walks every stored JSON value and finds no object with a person key (`id`, `login`,
`author`, `by`, …) that has an offset, zone, hour, location or country field, finds time zones only
as `windows[].timeZones` with ≥ 5 contributors, and finds no such column in any table. Other
guardrail tests: history facts do not change the risk score; the history code contains no
country, location or IANA-zone mapping; per-person rows are exactly `{id, firstSeen, lastSeen,
commits, commits24m, releases}`. No location is collected in P2 at all.

**Gate: GraphQL budget ≤ 2,000 points per 300-repository scan — met by measurement through the
enricher with a stub transport: 300 points in 300 requests.** Each repository needs one request
(`history(first: 100)` = 1 connection request, `object(oid:)` lookups are not connections → 1 point
by the documented formula) while it has ≤ 100 people to map; the people looked up per recorded
repository are 28, 19, 53, 24, 75 and 18 (CAF window, release makers, top 20). The budget charges the
predicted cost before sending and GitHub's `rateLimit.cost` after. [u: GitHub's GraphQL API and the
REST API for third-party repositories answer 403 from this environment ("GitHub GraphQL is not
available from Claude Code sessions"; MCP access is limited to this repository), so no real
GraphQL response could be recorded: login mapping and `signature.isValid` verification are tested
on the documented response shape only, and the real `rateLimit.cost` was not observed. Without
mapping, identities fall back to `.mailmap`, no-reply logins and salted hashes, which the hand
counts above show is enough for CAF on these repositories.]

Fixtures: `blastradius/test/fixtures/history/recorded/` (xz, event-stream, express, core-js,
webpack, left-pad), recorded once by `test/history/record.ts` (≈ 1.7 MB in all): per commit only
the shortened oid, parent count, pseudonymous author/committer ids (salt discarded after
recording), day, signature-header flag and version subject; release tags; per-month time-zone
counts without persons.

Tests: 30 unit tests (`src/history/history.test.ts`: CAF incl. the CHAOSS example, identities,
release points, time-zone floor and change, the reader on a real local repository, clone safety
and cache, GraphQL query/cost/budget), 22 gate tests (`test/history/history.test.ts`), 4 storage
privacy tests: 56 new, 702 in blastradius in all; web unchanged (297 unit, 52 e2e incl. axe).

Deferred: the "Maintainers and commit origins" screen (P6 views; the data is in
`ScanResult.history`); S5a's npm-publisher side and labels (P3); real GraphQL recording once a
token can reach it (`npx tsx test/history/record.ts --graphql`); `--shallow-since` for very large
repositories (the size cap is the guard today); monorepo subdirectories (`repo.directory` facts
are skipped).


### P3 Stability labels (2026-10-11)

Built from established methods only: OpenSSF Scorecard's **Maintained** check
(https://github.com/ossf/scorecard/blob/main/docs/checks.md; `checks/evaluation/maintained.go`
returns the reason "project is archived" for archived repositories and counts commits and issue
activity over 90 days [v]); **npm's deprecation semantics** (`npm deprecate <pkg>@<range> <message>`
marks versions or ranges, https://docs.npmjs.com/cli/v10/commands/npm-deprecate [v], so only a
deprecated **latest** release says the package as a whole is deprecated; moment's deprecated 2.10.5
and 2.19.0 do not); **CHAOSS Release Frequency** (https://chaoss.community/kb/metric-release-frequency/
[v]) measured as the median gap and the coefficient of variation of the gaps between the last 10
stable releases (plan S4); the **CHAOSS Contributor Absence Factor** from P2; the plan's 6/18-month
and 180-day lines.

Code: `src/stability/` (thresholds in `STABILITY_RULES`, rule names in `LABEL_RULES`, both in
`rules.ts`; S4 and the npm publisher timeline `cadence.ts`; README status `declared.ts`; the only
reader of fact values `signals.ts`; S3, S5a and the label `label.ts`; production reach
`production.ts`; `ScanResult.stability` `report.ts`). New npm facts `release_cadence` (S4),
`release_publishers` (who published each package's releases; S5a input) and `declared_status`
(README, low confidence), `release_age.latestDeprecated`; `commit_history` gains `cafAtLastCommit`
(the CAF of the last active 24 months) and the S5a npm side (`src/history/continuity.ts`). The
Maintenance tab shows the labels above the upkeep signals with a side panel of the rules and facts
(`/api/projects/:id/stability`), the Package page has a Stability section (`stability` in
`/api/packages/reach`), and the Changes page lists S5a observations (`continuity` in
`/api/changes`). No migration: labels live in the stored scan result (highest migration stays 11).

How a label is made. S3: `ended` with high confidence when the latest npm release is deprecated or
the repository is archived (GitHub `archived`, or Scorecard Maintained "project is archived");
`inactive` = no commit (bots excluded) and no release in 18 months; `quiet` = no commit in 6 months,
not inactive; a README status from a short fixed phrase list ("# Deprecated", "fully deprecated",
"this package is no longer maintained", "legacy project / maintenance mode") counts only with a
second fact (no release in 18 months, no commit in 6 months, or S4 irregular) and stays low
confidence, so it can reach Watch, never Fragile. S2 for the rules: the 24-month CAF when that
window has ≥ 5 commits, else the CAF of the 24 months up to the last commit. S5a: a release made
(tag or `npm version` commit, P2) or published on npm (`_npmUser`, new here) by an identity first
seen in the repository < 180 days earlier, in the last 12 months. The npm account is matched to
the history only through its registry e-mail address, hashed in memory with the same salt as
commit e-mails; unmatched accounts and npm trusted publishing give no observation. Funding (F2,
F3) is P4: its two rules are listed and never applied, and every label says **"funding not yet
assessed"**. "Contributor base changed" alone is context (it never reaches Fragile; with another
signal it is Watch). A replay of an earlier date does not read a later archival back: a Scorecard
run dated more than a month after the scan, and a GitHub `archived` flag on a repository pushed to
after the scan, are not used. Every label names the rules that fired and each fact's source,
confidence and evidence URL; wording is factual ("No commit and no release in 18 months (last
commit 2019-03-27, last release 2019-03-27)"), names no person, and passes the judgement-word lint.

**Gate: §8 expectations on recorded real data (`test/stability/stability.test.ts`) — request,
left-pad, core-js, event-stream, express met; moment label met with other reasons; colors and
faker missed (written up, code not bent).** Recorded 2026-10-11T20:50Z; P2 histories reused for
left-pad, core-js, express and webpack.

| Subject (row) | Label | Triggering facts (source) |
|---|---|---|
| request (6) | **Fragile** | npm marks the latest release (2.88.2) deprecated: "request has been deprecated, see https://github.com/request/request/issues/3142" (npm, high); production dependency. Context: README "Deprecated!" (low), Scorecard Maintained 0/10 "0 commit(s) and 0 issue activity … 90 days" (not archived, as P0 found), CAF 2 in the last active 24 months |
| moment (7) | **Watch** (not Fragile) | CAF 1 (68 commits, 24 months; git, medium); S5a: release 2.31.0 (2026-09-15) made by an identity first seen 51 days earlier (git). Context only: README "Moment.js is a legacy project, now in maintenance mode" (no second fact), S4 regular (median 80 days, CV 1.32, latest gap 993 days), Scorecard Maintained 10/10. **Miss on the reasons:** the plan expected quiet/declared and S4 irregular; moment released 2.31.0 in September 2026 and has commits every month. **Miss on S5a by person:** 2.31.0 was tagged on a commit by a maintainer active in the repository since 2014 under another e-mail address (the new address was first used on 2026-07-26); without GitHub login mapping (blocked here) a new address is a new identity. CAF 1 alone keeps the label Watch |
| left-pad (4) | **Fragile** | npm deprecation of 1.3.0 "use String.prototype.padStart()" (npm, high) and Scorecard "project is archived" (run 2026-08-24, high); production dependency. CAF of the last active 24 months 2 (24 commits to 2019-03-14) |
| colors (3), scan 2021-12-31 | **Fragile** | CAF 1 (116 commits, 2018-01-01 to 2019-12-31) and no commit or release in 18 months (last commit 2019-12-31, last release 1.4.0 on 2019-09-22). **Miss:** the plan expected Watch; on the real history colors had been inactive for two years before January 2022, which is the plan's own Fragile rule. Today: Watch (inactive; the January 2022 commits are the only ones in their window, < 5, so no CAF) |
| faker (3) | **Unknown** | **Miss:** `github.com/Marak/Faker.js` is no longer public (clone answers with an authentication prompt; deps.dev has no Scorecard for it) and no faker release is deprecated on npm (latest 6.6.6 of 2022-01-05, 0 of 29 versions deprecated), so "later deprecated → S3 ended" does not hold on today's data; the label says the history could not be read |
| core-js (5) | **Watch** | CAF 1 (1,635 commits, 24 months; git, medium). The package sits in `packages/core-js`: P3 reads the whole repository's history for monorepo packages (P2 skipped them) and says so in the label |
| event-stream (1), scan 2018-11-26 | **Watch** | CAF 1 (22 commits); S5a: "Release 3.3.5 was published on npm by an account first seen in this repository 1 days earlier (release 82 of the package; account matched by its registry e-mail address)" (npm + git), and release 3.3.5 made by the same identity (git); with them, contributor base changed 33 % → 0 %. Today: Fragile (CAF 1 and inactive since 2018; Scorecard "project is archived") |
| express (12) | **Steady** | no rule: commits within 6 months, CAF 6; the 2025 "contributor base changed" is older than 12 months and alone would be context |
| @babel/core (11) | **Steady** | no rule: CAF 2 over 953 commits of the babel repository (monorepo, whole-repository facts) |
| webpack (11) | **Watch** | CAF 1 (2,289 commits; the P2 miss carries over) |

**Gate: hand review on the control repositories — 30 of 30 facts correct as stated; 27 of 30 under
a strict per-person reading (≥ 27 needed): met.** Control repositories: the six real public
repositories of the replay "Acme" org (`test/replay/data/org`, docs/NEXT-LEVEL.md). Their 227
production npm dependencies were recorded (packuments, Scorecard via deps.dev, 219 histories; 5
repositories under `github.com/substack/` are no longer public) and labelled as of the recording
time: **72 Fragile, 131 Watch, 8 Steady, 16 Unknown** (Unknown: 9 with fewer than 5 commits in
their last active 24 months, 6 without a readable history, 1 without a declared repository). Rules
that fired: CAF 1 and inactive 59, ended in production 21, inactive 61, quiet 30, CAF 1 44, S5a
10, C1 with another signal 6. The sample is 30 of the 203 Fragile/Watch labels (one per package),
drawn with a seeded shuffle (mulberry32, seed 20261011; `test/stability/sample.ts`, asserted in
the gate test). Method, independent of the code: a fresh blobless clone per repository,
`git log` committer dates in UTC with bot commits removed by hand, `git -c mailmap.blob=HEAD:.mailmap
shortlog -sne --since --until` over the label's window with the 50 % rule counted by hand, tags
with `git for-each-ref`; the npm registry document (`dist-tags.latest`, `versions[latest].deprecated`,
`time`); the deps.dev project's Scorecard Maintained check.

| # | Package (in use) | Label | Facts checked against the primary source | Result |
|---|---|---|---|---|
| 1 | clone-stats 1.0.0 | Watch: inactive | last commit 2016-05-17, last release 2016-05-17 (git log; npm time) | correct |
| 2 | finalhandler 1.1.1 | Watch: CAF 1, S5a | 33 of 38 non-bot commits by one address (24 months); tag v2.1.1 (lightweight) on a commit by an author whose first commit here is that day, 2025-12-01 (any address, by name too) | correct |
| 3 | hoek 2.16.3 | Fragile: ended in production | latest 6.1.3 deprecated "This module has moved and is now available at @hapi/hoek…" | correct |
| 4 | once 1.4.0 | Watch: quiet | last commit 2025-10-25, last release 2016-09-06 | correct |
| 5 | rimraf 2.6.2 | Watch: CAF 1 | 29 of 38 commits, 24 months | correct |
| 6 | aurelia-event-aggregator 1.0.3 | Watch: inactive | last commit and release 2019-03-27; CAF 2 (9 + 5 of 22) | correct |
| 7 | path-is-absolute 1.0.1 | Fragile: ended in production | latest 2.0.0 deprecated "This package is no longer relevant as Node.js 0.12 is unmaintained."; Scorecard 2026-08-24 "project is archived" | correct |
| 8 | concat-with-sourcemaps 1.1.0 | Watch: inactive | last commit 2018-05-02 (UTC; 2018-05-03 in the committer's zone), release 2018-05-02; CAF 2 by address (5 + 2 of 11) | correct as stated; **per person CAF 1** (one person, two addresses): the label would be Fragile |
| 9 | jsprim 1.4.1 | Watch: inactive | last commit 2021-11-17 (UTC), last release 1.4.2 on 2021-11-29 | correct |
| 10 | forwarded 0.1.2 | Watch: quiet | last non-bot commit 2025-07-23 (two dependabot commits on 2026-03-01 excluded), last release 2021-05-31 | correct |
| 11 | aurelia-http-client 1.3.1 | Watch: inactive | last commit and release 2019-03-27; CAF 3 by address (11, 7, 7 of 43) | correct as stated; **per person CAF 2** (one person, two addresses); label unchanged |
| 12 | debug 2.6.9 | Watch: CAF 1, quiet | 5 of 9 commits; last non-bot commit 2026-04-01; last release 4.4.3 on 2025-09-13 | correct |
| 13 | jsonpointer 4.0.1 | Watch: CAF 1 | 5 of 6 commits | correct |
| 14 | vue-router 3.5.3 | Watch: quiet | `vuejs/vue-router` (the repository of 3.5.3) last commit 2025-11-28; last npm release 5.4.0 on 2026-10-07 | correct (the current release line lives in `vuejs/router`; the label is about the repository the version in use names) |
| 15 | accepts 1.3.5 | Watch: quiet | last non-bot commit 2026-04-02, last release 2.0.0 on 2024-08-31 | correct |
| 16 | buffer-from 1.1.1 | Watch: inactive | last commit and release 2021-07-29 | correct |
| 17 | inherits 2.0.4 | Watch: quiet | last commit 2025-10-25, last release 2019-06-19 | correct |
| 18 | http-https 1.0.0 | Fragile: CAF 1 and inactive | 5 of 5 commits (2012-01-03 to 2014-01-02); last commit 2014-01-02 (UTC), release 2014-01-02 | correct |
| 19 | requirejs 2.3.6 | Watch: CAF 1, quiet | `jrburke/r.js`: 5 of 5 commits (2023-12-01 to 2025-11-30); last commit and release 2025-11-30 | correct |
| 20 | graceful-fs 2.0.3 | Watch: quiet | last commit 2025-10-25, last release 2023-03-16 | correct |
| 21 | aurelia-bootstrapper 1.0.1 | Watch: inactive | last commit and release 2024-04-19 | correct |
| 22 | semver 5.5.1 | Watch: C1 with a new top committer | long-standing share 64 % (7 of 11) → 19 % (3 of 16), 12 months to 2026-10-11; top committer first seen (as committer) 2026-05-07 | correct |
| 23 | event-stream 3.3.6 | Fragile: CAF 1 and inactive; ended | 16 of 22 commits; last commit 2018-09-20, last release 4.0.1 on 2018-09-29; Scorecard "project is archived" | correct |
| 24 | getpass 0.1.7 | Fragile: CAF 1 and inactive | 15 of 15 commits; last commit and release 2017-04-25 | correct |
| 25 | aurelia-pal-browser 1.8.1 | Fragile: CAF 1 and inactive | 14 of 26 commits by one address (two name spellings); last commit 2019-02-01, release 2019-01-18 | correct |
| 26 | destroy 1.0.4 | Fragile: CAF 1 and inactive | 46 of 47 commits; last commit and release 2022-03-20 | correct |
| 27 | aurelia-router 1.7.1 | Watch: inactive | last commit 2022-04-12, last release 2019-05-03 | correct |
| 28 | aurelia-polyfills 1.3.4 | Watch: inactive | last commit and release 2019-03-26; CAF 2 (19 + 6 of 43; per person also 2) | correct |
| 29 | glob 7.1.3 | Watch: CAF 1 | 66 of 71 commits | correct |
| 30 | co 4.6.0 | Watch: inactive | last commit 2016-10-17 (UTC), last release 2015-07-09; CAF 4 by address | correct as stated; **per person CAF 2** (one person, three addresses); label unchanged |

What the review found: every date, count, deprecation message and archived flag matched its
primary source. The three per-person differences are all one known limitation (P2's identity is
the commit e-mail address or no-reply login; GitHub's login mapping is blocked here): a CAF above
1 can overstate the number of people, never understate it, and one of them (row 8) hid a CAF 1.
The CAF facts now say "contributor identities (e-mail addresses or GitHub logins; one person may
use several)", and every label with CAF, S5a or C1 facts carries that caveat as context. The same limitation
gives moment's false S5a above.

**Gate: guardrails — met** (`src/stability/stability.test.ts`). Labels read repo- and org-level
fields only: a test wraps every fact value so that reading any per-person field (`top`, `people`,
maintainer, publisher and account names, ids, logins, e-mails, time-zone fields, location,
country) throws, and makes facts about a person (`publisher`, `publisher_change`,
`maintainer_change`, `release_publishers`) throw on any read; all labels build. A source scan of
`src/stability/` finds no location, country, nationality or time-zone read. Time zones exist only
as P2's repo-level aggregates and C3 is never a label input. Labels, facts and the recorded
fixtures contain no e-mail address (deprecation messages that name one are shown with it removed)
and no contributor id. Stability adds no reason to any finding.

Fixtures: `blastradius/test/fixtures/stability/recorded/` (`subjects.json`, `history/` for request,
moment, colors, event-stream and babel with the npm publisher links, `control.json.gz` ≈ 1 MB),
recorded once by `test/stability/record.ts` with the P2 collector and a discarded salt. The
dev-seed replay now also replays recorded P2 histories, so the e2e fixture shows event-stream as
Watch on the Maintenance tab, the Package page and the Changes page.

Tests: 26 unit tests (`src/stability/stability.test.ts`: S4 maths, README phrases, S3 states and
their as-of guards, every label rule, C1 alone, funding never applied, wording lint, the
per-person guard, production reach, the S5a npm side), 12 gate tests
(`test/stability/stability.test.ts`), 5 API tests (`src/server/stability.test.ts`): 43 new, 756 in
blastradius in all (with the P1 fix merged); web 303 unit (5 new) and 56 Playwright e2e (4 new, axe
in light and dark).

Misses and limits, written up rather than fixed: colors (Fragile, not Watch), faker (Unknown),
moment's reasons and its S5a by person (above); webpack Watch follows P2's CAF 1. Registry
deprecations carry no date, so a replay of an earlier date uses today's deprecation state (none of
the dated subjects is affected). Monorepo packages get whole-repository facts. vue-router-style
cases: the repository named by the version in use can differ from the current release line.

Deferred: F2/F3 rules (P4, "funding not yet assessed"); the Stability view and roll-up (P6);
GitHub login mapping to merge one person's addresses (needs GraphQL, blocked here); the Account
page "first seen in these repos" (P6); event proposals from S3 (P5); per-package history for
monorepo subdirectories.

### P3 refinement: small, finished packages (2026-10-11)

**Why.** On the 227 production dependencies of the control repositories P3 gave 72 Fragile, 131
Watch, 8 Steady and 16 Unknown. The facts were right (30 of 30 in the hand review above), but 51 of
the 72 Fragile labels were "CAF = 1 and S3 inactive" alone, and most of those are small npm
packages that have had nothing to change for years (escape-html, utils-merge, unpipe). A third of
the dependencies marked Fragile is not something a user can act on. The owner approved a tier for
small, finished packages.

**Definition: finished / low-surface** (`finishedTest` in `src/stability/label.ts`, thresholds in
`STABILITY_RULES`). Published or deterministic facts only; every condition must hold, and any
unknown input means "not shown finished" (the label stays as it was and says what is missing):

| Condition | Threshold | Source |
|---|---|---|
| Small | every version in use ≤ 32 KiB unpacked and ≤ 10 files | npm `dist.unpackedSize` / `dist.fileCount`; for versions published before npm recorded them (2018), the same two numbers read from the published tarball, computed as npm publish computes them (`npm/cli` `lib/utils/tar.js`: sum of entry sizes, entry count) [v: equal to npm's numbers on destroy 1.2.0, inherits 2.0.4, path-is-absolute 2.0.0, psl 1.1.29, aurelia-framework 1.3.1] |
| Few dependencies of its own | ≤ 2 runtime + optional dependencies | the version's manifest on npm |
| Not deprecated, not archived | S3 not `ended`; no version in use deprecated | npm, GitHub / Scorecard (as S3) |
| No open advisory | no OSV advisory affects a version in use, **and** the scan's OSV lookup completed | the scan's OSV `vuln` facts (OpenSSF Scorecard's Vulnerabilities check uses the same source for "open, unfixed vulnerabilities" [v, checks.md]) |
| Long history | first release ≥ 36 months before the scan (twice the 18-month inactive line) | npm `time` |
| No release churn | ≤ 3 stable releases in the final 12 months of its release history | npm `time` (CHAOSS Release Frequency, counted at the end of the history: a burst of releases right before a package stopped is not a finished package) |

Reasoning for the thresholds. Abdalkareem et al., "Why Do Developers Use Trivial Packages? An
Empirical Case Study on npm" (ESEC/FSE 2017, doi:10.1145/3106237.3106267 [v via
neverworkintheory.org: "no more than 35 lines of code and a McCabe complexity score no greater than
10"]) found 16.8 % of npm packages trivial, and that developers' main concern with them is the
dependency overhead, not their upkeep: a trivial package has little that can need changing. The
registry has no line counts, so the bound is on bytes; 32 KiB holds a few hundred lines together
with the README, licence and package.json, a deliberate margin above the 35-line trivial line
rather than a fit to this data. The dependency bound follows the same study (dependencies are the
part of a small package that does change). The advisory condition needs the OSV lookup to have run:
a missing `vuln` fact proves nothing offline. Tarballs are read only for packages whose newest
release is older than the inactive line (the only ones the test can change), through the shared
HTTP client (cached, rate-limited; `HttpClient.fetchBytesOrNull`, a binary GET; the tar headers are
read, contents never interpreted, decompressed size capped at 64 MB).

**Rules.** For a small, finished package, "CAF = 1 and inactive" gives **Watch** with the rule
"Watch: small, finished package: single maintainer, no recent activity" and the size, history and
advisory facts. **Fragile stays** for deprecated or archived packages in production; for CAF = 1 and
inactive on packages that are not small and finished (the label's context names the condition that
failed, e.g. "Not a small, finished package: 443.5 kB unpacked (more than 32.0 kB); 26 files (more
than 10)"); and, new, for an **open OSV advisory with no fixed release** on a version in use of a
package that is inactive or ended ("Fragile: open advisory with no fixed release, and S3 inactive or
ended"; "open" = affects the version in use, "no fixed release" = OSV lists no `fixed` event for
this package). Release-takeover signals (S5a, including `release_takeover`) are unchanged: they are
Watch, as in P3 and §8 row 1, and a finished package never hides them (S5a is its own Watch rule).
`rulesVersion` is 2.

**Label choice: Watch, not a fifth "Steady (finished)" label.** Watch is the clearer option for
users: a single maintainer with no activity for 18 months is still a fact a user should see when
an advisory arrives (nobody may publish the fix), which is what Watch means ("look at the facts"),
while "Steady" says no rule fired. A fifth label would also make the label set, its colours, the
filters and the counts larger for a distinction the rule name already carries. The Watch row says
"Small, finished package: single maintainer, no recent activity", and the side panel shows the
finished test ("Small, finished package: Yes · 3.6 kB, 5 files, 0 dependencies", or which condition
was not met).

**Gate: label distribution on the 227 control production dependencies — before 72 Fragile, 131
Watch, 8 Steady, 16 Unknown; after 46 Fragile, 157 Watch, 8 Steady, 16 Unknown.** 26 labels changed,
all Fragile → Watch through the finished rule; none went up. Rules that fired after: CAF 1 and
inactive 33 (was 59 counting packages also ended), finished 26, ended in production 21, open
advisory with no fixed release 2 (hoek and request, both already Fragile as deprecated), inactive
61, quiet 30, CAF 1 44, S5a 10, C1 with another signal 6. The 33 that stay Fragile through CAF 1
and inactive fail a condition: size or files (the aurelia packages, json, dashdash, psl,
follow-registry, delayed-stream), dependencies (cloneable-readable, concat-stream, mississippi),
release churn (aws4 30 releases in its final year, ee-first, fast-deep-equal, punycode, serr,
isstream, remove-trailing-separator, davlog, har-schema), an open advisory (json-schema,
tunnel-agent, aurelia-framework), or deprecated / archived (also Fragile through the ended rule).
New inputs recorded with the existing recorder (`test/stability/record.ts --augment`, 2026-10-11,
real registry, tarball and OSV data; added to the existing fixtures without re-recording what was
there, so the labels keep their recording time): `dist.unpackedSize` / `fileCount` and dependencies
for the versions in use and the latest release, tarball sizes for versions without them, and the
OSV records affecting each version in use (64 records, trimmed to what the OSV enricher reads; no
credits).

**Gate: §8 subjects — met.** request **Fragile** (ended in production; now also the open advisory
GHSA-p8p7-x288-28g6, SSRF, which OSV lists as affecting request up to 2.88.2 with no fixed release
[v OSV API]); left-pad **Fragile** (deprecated 1.3.0 and Scorecard "project is archived"; small,
but deprecated, so never finished); event-stream at 2018-11-26 **Watch** with the S5a fact (release
3.3.5 published by an account first seen 1 day earlier); express and @babel/core **Steady**;
core-js and moment **Watch**. All asserted in `test/stability/stability.test.ts`.

**Gate: hand review of every changed label (26, fewer than 30) — 26 of 26 correct.** Method,
independent of the code: a Python script (not the product code) reading the npm registry document
(`dist`, the manifest's dependencies, `time`, `deprecated`), each tarball through Python's
`tarfile` where the registry has no size, the OSV API (`/v1/query` per version in use), the deps.dev
project's Scorecard Maintained check, and a fresh blobless clone per repository (`git log`, bot
commits removed, author e-mail addresses counted over the label's CAF window, top identity ≥ half).

| # | Package (in use) | CAF 1 and inactive (git, npm) | Small and settled (npm, tarball) | Advisories (OSV), deprecation, archive | Result |
|---|---|---|---|---|---|
| 1 | aws-sign2 0.5.0, 0.7.0 | 7 of 10 commits (2015-04-13 to 2017-04-12); last commit 2017-04-12, last release 2017-04-12 | 13.8 kB, 4 files (tarball), 0 deps; first release 2013-12-04, 1 in final year | none; not deprecated; Scorecard not archived | correct |
| 2 | browser-request 0.3.3 | 35 of 59 commits (2012-02-14 to 2014-02-13); last commit 2014-02-13, last release 2014-11-24 | 30.0 kB, 7 files (tarball), 0 deps; first release 2011-12-21, 2 in final year | none; not deprecated; Scorecard not archived | correct |
| 3 | bytes 3.0.0 | 27 of 29 commits (2020-01-29 to 2022-01-28); last commit 2022-01-28, last release 2022-01-28 | 10.5 kB, 5 files (tarball), 0 deps; first release 2012-06-11, 2 in final year | none; not deprecated; Scorecard not archived | correct |
| 4 | combined-stream 0.0.7, 1.0.6, 1.0.7 | 9 of 14 commits (2017-05-13 to 2019-05-12); last commit 2019-05-12, last release 2019-05-12 | 10.8 kB, 7 files (dist, tarball), 1 deps; first release 2011-05-24, 2 in final year | none; not deprecated; Scorecard not archived | correct |
| 5 | cookie-signature 1.0.6 | 8 of 12 commits (2022-10-30 to 2024-10-29); last commit 2024-10-29, last release 2024-10-29 | 3.8 kB, 5 files (tarball), 0 deps; first release 2012-10-15, 1 in final year | none; not deprecated; Scorecard not archived | correct |
| 6 | core-util-is 1.0.3 | 8 of 9 commits (2019-09-01 to 2021-08-31); last commit 2021-08-31, last release 2021-08-31 | 4.9 kB, 4 files (dist), 0 deps; first release 2013-08-26, 1 in final year | none; not deprecated; Scorecard not archived | correct |
| 7 | depd 1.1.1, 1.1.2 | 53 of 53 commits (2019-11-13 to 2021-11-12); last commit 2021-11-12, last release 2018-10-26 | 29.8 kB, 9 files (tarball), 0 deps; first release 2014-06-15, 2 in final year | none; not deprecated; Scorecard not archived | correct |
| 8 | destroy 1.0.4 | 46 of 47 commits (2020-03-21 to 2022-03-20); last commit 2022-03-20, last release 2022-03-20 | 5.1 kB, 4 files (tarball), 0 deps; first release 2014-08-15, 3 in final year | none; not deprecated; Scorecard not archived | correct |
| 9 | ecc-jsbn 0.1.2 | 5 of 6 commits (2016-07-30 to 2018-07-29); last commit 2018-07-29, last release 2018-07-29 | 27.1 kB, 10 files (dist), 2 deps; first release 2014-03-06, 2 in final year | none; not deprecated; Scorecard not archived | correct |
| 10 | escape-html 1.0.3 | 17 of 17 commits (2017-01-12 to 2019-01-11); last commit 2019-01-11, last release 2015-09-01 | 3.6 kB, 4 files (tarball), 0 deps; first release 2012-08-20, 2 in final year | none; not deprecated; Scorecard not archived | correct |
| 11 | extend 3.0.2 | 4 of 5 commits (2024-10-11 to 2026-10-11); last commit 2025-03-06, last release 2018-07-19 | 22.9 kB, 10 files (dist), 0 deps; first release 2011-05-14, 2 in final year | none; not deprecated; Scorecard not archived | correct |
| 12 | from 0.1.7 | 6 of 8 commits (2015-03-12 to 2017-03-11); last commit 2017-03-11, last release 2017-03-11 | 8.3 kB, 8 files (tarball), 0 deps; first release 2012-07-04, 1 in final year | none; not deprecated; Scorecard not archived | correct |
| 13 | from2 2.3.0 | 26 of 33 commits (2014-08-16 to 2016-08-15); last commit 2016-08-15, last release 2016-08-15 | 9.1 kB, 6 files (tarball), 2 deps; first release 2014-02-10, 3 in final year | none; not deprecated; Scorecard not archived | correct |
| 14 | getpass 0.1.7 | 15 of 15 commits (2015-04-26 to 2017-04-25); last commit 2017-04-25, last release 2017-04-25 | 5.5 kB, 6 files (tarball), 1 deps; first release 2016-04-21, 2 in final year | none; not deprecated; Scorecard not archived | correct |
| 15 | http-https 1.0.0 | 5 of 5 commits (2012-01-03 to 2014-01-02); last commit 2014-01-02, last release 2014-01-02 | 2.3 kB, 5 files (tarball), 0 deps; first release 2014-01-02, 1 in final year | none; not deprecated; Scorecard not archived | correct |
| 16 | is-property 1.0.2 | 6 of 7 commits (2012-12-26 to 2014-12-25); last commit 2014-12-25, last release 2014-12-25 | 13.3 kB, 5 files (tarball), 0 deps; first release 2013-07-18, 3 in final year | none; not deprecated; Scorecard not archived | correct |
| 17 | json-schema-traverse 0.3.1 | 14 of 18 commits (2019-01-06 to 2021-01-05); last commit 2021-01-05, last release 2020-12-13 | 16.4 kB, 10 files (tarball), 0 deps; first release 2017-06-04, 2 in final year | none; not deprecated; Scorecard not archived | correct |
| 18 | json-stringify-safe 5.0.1 | 15 of 19 commits (2013-05-21 to 2015-05-20); last commit 2015-05-20, last release 2015-05-19 | 12.4 kB, 9 files (tarball), 0 deps; first release 2013-02-19, 1 in final year | none; not deprecated; Scorecard not archived | correct |
| 19 | oauth-sign 0.6.0, 0.9.0 | 3 of 5 commits (2016-08-03 to 2018-08-02); last commit 2018-08-02, last release 2018-08-02 | 15.7 kB, 5 files (dist, tarball), 0 deps; first release 2013-03-01, 1 in final year | none; not deprecated; Scorecard not archived | correct |
| 20 | patch-package-json 0.0.4 | 9 of 10 commits (2013-10-17 to 2015-10-16); last commit 2015-10-16, last release 2015-10-16 | 8.5 kB, 7 files (tarball), 0 deps; first release 2014-05-02, 2 in final year | none; not deprecated; Scorecard not archived | correct |
| 21 | safe-buffer 5.1.2 | 16 of 16 commits (2018-10-30 to 2020-10-29); last commit 2020-10-29, last release 2020-05-10 | 30.9 kB, 5 files (dist), 0 deps; first release 2016-01-13, 2 in final year | none; not deprecated; Scorecard not archived | correct |
| 22 | stream-combiner 0.2.2 | 12 of 24 commits (2013-06-06 to 2015-06-05); last commit 2015-06-05, last release 2015-06-05 | 5.4 kB, 7 files (tarball), 2 deps; first release 2012-11-27, 1 in final year | none; not deprecated; Scorecard not archived | correct |
| 23 | stream-each 1.2.3 | 8 of 9 commits (2016-07-30 to 2018-07-29); last commit 2018-07-29, last release 2018-07-30 | 6.6 kB, 7 files (dist), 2 deps; first release 2015-10-18, 3 in final year | none; not deprecated; Scorecard not archived | correct |
| 24 | stream-shift 1.0.0 | 3 of 5 commits (2022-01-18 to 2024-01-17); last commit 2024-01-17, last release 2024-01-17 | 3.8 kB, 7 files (tarball), 0 deps; first release 2016-07-08, 2 in final year | none; not deprecated; Scorecard not archived | correct |
| 25 | unpipe 1.0.0 | 55 of 55 commits (2016-06-30 to 2018-06-29); last commit 2018-06-29, last release 2015-06-14 | 4.2 kB, 5 files (tarball), 0 deps; first release 2015-06-14, 1 in final year | none; not deprecated; Scorecard not archived | correct |
| 26 | utils-merge 1.0.1 | 5 of 5 commits (2018-06-18 to 2020-06-17); last commit 2020-06-17, last release 2017-09-20 | 3.6 kB, 5 files (tarball), 0 deps; first release 2013-07-11, 1 in final year | none; not deprecated; Scorecard not archived | correct |

What the review found: every size, file and dependency count, first-release date, final-year count,
last commit and release date and CAF window count matched. Two notes: destroy's first release is
1.0.0 of 2014-08-15 (the registry's `time.created` is 2013-10-03, from versions no longer listed);
stream-combiner's top identity has exactly half of the window's commits (12 of 24), which is CAF 1
by the CHAOSS definition. CAF by e-mail address can overstate the number of people, never
understate it, so none of these CAF 1 values hides a CAF above 1. The three earlier sample rows
that changed (http-https, getpass, destroy) are now Watch through the finished rule; the P3 sample
test records it.

Tests: blastradius 879 (13 new: 4 label unit tests for the finished tier and the advisory rule, 4
tarball and package-size tests, 2 HttpClient tests for binary bodies and manual redirects, 3
verification-gate redirect tests; the gate tests assert the new counts, the 26 changed packages and
the §8 rows), proof and build green; web 308 unit (1 new: the finished rule and the panel row), 60
Playwright e2e including axe in light and dark.

Also in this change (coordinator request, `src/agentic/verify.ts`): the verification gate re-fetches
a proposal's source URL with redirects followed by hand (at most 5); any hop or final URL that is
not plain https on the task's evidence domains rejects the proposal with "redirected off allowed
domain", and the final URL is recorded as the evidence (`src/agentic/redirect.test.ts`). The HTTP
client's manual-redirect responses are cached under their own key, so a followed response is never
served in their place.

### Agentic gap-filler (2026-10-11)

Owner direction: "a reusable pipeline to do it agentically" with all our data sources. The
deterministic collectors stay the primary path (deps.dev, npm registry, OSV, GitHub advisories,
Scorecard, Open Collective, git history, licences); a Claude agent with tools fills only what they
leave missing, and **the app, not the model, decides what is kept**. Off by default: `--agentic`
plus `ANTHROPIC_API_KEY` in the environment (read from the environment only, never logged; errors
are reduced to the SDK error class and status). Built with the Anthropic TypeScript SDK
(`@anthropic-ai/sdk` 0.128.0): Messages API with adaptive thinking and explicit effort, client tools
plus the server-side `web_search_20260209` / `web_fetch_20260209` tools limited to each task's
evidence domains, top-level prompt caching (fixed system prompt and tool list per task, the request
in the first user message), the server-side refusal fallback, `pause_turn` resumed and `refusal`
handled. Model: `$BLASTRADIUS_AGENT_MODEL`, default the most capable current Opus model; effort
`$BLASTRADIUS_AGENT_EFFORT` (default high).

**Pipeline** (`blastradius/src/agentic/`): a typed fact request (subject, task, question, context)
→ privacy screen → result cache (7-day TTL, on disk) and in-flight de-duplication → one agent run
with the task's fixed tools (`agent.ts`, a manual loop that checks the shared per-scan budget before
every request) → `submit_facts` (value, source URL, exact quote, confidence note; retrieval time
from the web_fetch result, else the run time) → **verification gate** (`verify.ts`) → facts and
proposals. Reusable: one pipeline, a **task spec** per fact type (`tasks.ts`: prompt, allowed
tools, evidence domains, strict zod value schema, deterministic value ↔ quote rules); a new fact
type is one `TaskRegistry.register(spec)`, which runs the privacy registration checks.

**Tools.** Our collectors wrapped as tools, so the agent reuses them before browsing:
`collected_facts` (everything this scan's collectors found for the subject; git history and
person-level fields are not passed), `npm_package`, `pypi_package`, `depsdev_project`,
`osv_query`, `opencollective_account` (our OC collector's query; organisations only),
`github_user` (GitHub users API for the subject's own login only, with the configured token);
`registry_fetch` (GET on registry.npmjs.org, pypi.org, api.deps.dev, api.osv.dev,
api.securityscorecards.dev, raw.githubusercontent.com only); `web_search` and `web_fetch`. All
client tools go through the scan's `HttpClient` (cache, rate limits, offline fixtures).

**Verification gate** (deterministic, `verify.ts`): task and subject bound to the request (the
model cannot change them) → privacy screen of the value (a refusal keeps nothing) → strict schema →
source domain allowed for the task (its own list plus, for some tasks, domains our collectors
derived for the subject, e.g. the npm homepage; never domains the model picked) → quote of 12–1,500
characters → **the app re-fetches the source URL itself** → the quote is on the page after
normalising HTML (scripts removed, block tags as spaces, inline tags dropped, entities decoded),
Unicode, typographic quotes and dashes, whitespace and case → the task's rules (e.g. the
organisation, amount and currency are in the quote; foundation membership only from that
foundation's own site; a registry's country matches the record; licence families in a relicensing
quote; neutral summaries pass the judgement-word lint; a location is the whole self-declared
field). Pass → `verified` (an `agent_fact` with source `agent:<task>`, the evidence URL and the
quote) or `pending_confirmation`; fail → `unverified` proposal, kept for review only.

**Task specs shipped** (7): `funding` (funding.json, GitHub Sponsors, Open Collective, Tidelift,
thanks.dev, corporate backers, foundations; P4), `governance` (foundation membership, governance
documents, owner), `org_jurisdiction` (public registries only: Companies House, OpenCorporates, SEC
EDGAR, foundation and charity filings, the organisation's own legal page; **always
`pending_confirmation` until a person confirms it in the UI or API; P7 sanctions checks read only
confirmed values**, `confirmedJurisdictions()`), `lifecycle_events` (relicensing, deprecation,
end of life, archival, maintenance mode; P5), `incident_writeups` (post-mortems and advisories
about compromise or sabotage; P5), `person_self_declared_location` and `contributor_identity` (see
§5; off by default).

**Integration.** `src/enrich/agentic` runs after every other enricher and plans only what is still
missing: funding for direct dependencies with no funding facts, governance with no repository
owner, lifecycle events when the collectors flag deprecation, archival or a licence change,
incident write-ups for packages with malware facts, org jurisdiction for GitHub organisations that
own direct dependencies; with `--agentic-people`, contributor identity for people git history
already maps to a login (no-reply addresses, .mailmap, GraphQL mapping when a token is set; salted
hashes are never sent). Budgets per scan: 60 model requests, 1.5 M tokens, 25 runs (exceeding one
is reported in `ScanResult.agentic.budgetExhausted` and a warning). Proposals are stored per org
(migration 12, `agent_proposal`); API `GET /api/agentic/proposals`, `POST …/:id/confirm|reject|remove`
(`review_entity_links`, audited, decisions survive rescans, person-level rows only for
`manage_projects`); web view **Proposed facts** (`/proposed-facts`, linked from the Overview).

**Gate on real recorded pages** (`blastradius/test/agentic/gate.test.ts`; pages fetched once by
`test/agentic/record.ts` on 2026-10-11 and trimmed, Open Collective "Individuals" lists and mail
headers cut): **16 real quotes verified** (2 of them `pending_confirmation`) and **27 proposals
rejected**:

| Page | Accepted (real quote → value) | Rejected |
|---|---|---|
| opencollective.com/babel | fiscal host Open Source Collective; Airbnb $217,858 USD; Sovereign Tech Agency $207,511.35 USD | fabricated host, "funded entirely by Google", amount ×10 (quote not on page); real quote with the wrong backer or amount (rules) |
| opencollective.com/webpack | fiscal host; trivago $389,985 USD | "sponsored by Microsoft" |
| opencollective.com/fakerjs | Indeed $29,000 USD | $290,000 |
| momentjs.com/docs | "Moment.js is a legacy project in maintenance mode." | "reached end-of-life … archived"; real quote as `deprecation` (rules); real quote without the homepage domain (domain) |
| redis.io AGPL post (2025) and dual-licence post (2024) | AGPL option from Redis 8; RSALv2/SSPLv1 from 7.4 | MIT; "Redis 7.2 … AGPLv3"; Redis page cited for a funding fact (domain) |
| elastic.co (2024, 2021) | AGPL added next to ELv2 and SSPL; Apache 2.0 → SSPL and Elastic License | "back to Apache 2.0"; GPL-3.0 |
| oscollective.org | "registered in the USA. EIN 82-2037583" → US, pending confirmation | "registered in the United Kingdom"; real quote as GB (rules); quote "the USA" (too short); used for another org (domain) |
| SEC EDGAR, Elastic N.V. | "State location: CA" → US-CA business address, pending confirmation | NY; NL from an EDGAR record (rules) |
| openjsf.org/projects | Express in the OpenJS Foundation | "owned by Google LLC"; Linux Foundation (rules) |
| openwall.com oss-security (xz) | "The upstream xz repository and the xz tarballs have been backdoored." | "no release was affected"; summary with a judgement word (rules) |
| blog.npmjs.org (left-pad) | unpublished by its author during a name dispute | "removed … because it contained malware" |
| github.com issue (event-stream #116) | — | **blocked**: GitHub answers 403 here (recorded as blocked), so nothing from it verifies |

**Guardrail and safety tests.** Nationality, ethnicity, person country and person time-zone
requests, and questions asking to infer a location from a name, email, time zone, IP or language,
are refused before any model call (11 cases); registering a person-level task, a protected-attribute
task or an inference prompt fails; proposed values with nationality, time zone, a person object or a
country in a person task are refused and not stored; a person-level location without the person's
own profile quote, a shortened location ("Portugal" from "Lisbon, Portugal") and a value the quote
does not support are rejected. **Prompt injection:** a fetched page that tells the agent to ignore
its instructions, switch to nationality, call an exfiltration URL and submit a nationality
(`test/fixtures/agentic/synthetic/injection-readme.json`) is returned wrapped as untrusted data
(its fake closing tag neutralised); the injected tool calls are refused by code (host not allowed,
tool not in the task); the system prompt and tools never change; only the real npm-blog fact is
kept and both injected values are refused without being stored. Costs: request, token and run
budgets, cache with TTL (re-verified on every hit), de-duplication; all tested.

Tests: 126 in blastradius for this work (`src/agentic/agentic.test.ts`, `test/agentic/*.test.ts`,
`src/server/agentic.test.ts`, migration test), 866 in all after merging the P1 fix and P3; web 307 unit (+4 for this work) and 60 e2e (+4: the
Proposed facts list for AppSec, confirm and reject as org admin, axe light and dark). Model turns in
tests are hand-written stubs replayed by `ReplayModel` (`test/fixtures/agentic/model/stubbed.json`)
because no API key is available here; every page and registry document they lead to is a real
recording, except the clearly marked synthetic person and injection pages and the stubbed GitHub
users API responses. **Live runs: untested** (`ANTHROPIC_API_KEY` is not set in this
environment) [u]. GitHub's users API is not reachable from here (403), so `github_user` is tested
on the documented response shape only; live use is [u].

**Live run (2026-10-12)** (`blastradius/test/agentic/live-run.ts`, replayed offline by
`live-replay.test.ts` from `test/fixtures/agentic-live/`). Model turns were produced by a Claude Code
agent acting as the model on the live web (no API key; it followed each task's prompt and evidence
domains and wrote the `submit_facts` calls); everything else was the real pipeline, with the gate
re-fetching every source live. 18 requests (funding ×5, governance ×3, lifecycle ×4, incidents ×4,
org jurisdiction ×2; contributor identity and self-declared location skipped): **29 proposals, 29
kept** (26 verified, 3 `pending_confirmation`), each checked by hand against its page. Gate latency
0.05–1.7 s per request (one 31–92 s outlier when oscollective.org was slow; once it timed out and
the fact stayed unverified). Before two fixes the gate made **2 false rejects** (an SEC 10-K stating
"The Netherlands … (State or other jurisdiction of incorporation)" was refused because `sec_edgar`
implied US; a ProPublica IRS record "Covina, CA" was refused because `foundation_filing` implied no
country) and **2 false accepts** (core-js's Open Collective backer accepted as a funder of express;
npm's left-pad post accepted as an express incident). Fixes in `tasks.ts`: the implied country is per
registry host (sec.gov, ProPublica and IRS → US; Companies House and Charity Commission → GB) and
another country is accepted only when the quote names it; funding, lifecycle and incident sources
must name the subject (package name, npm scope, repository owner or name) on the page or in the URL
path. Adversarial attempts rejected: wrong amount (rules), wrong-subject quotes ×3 (rules), Wikipedia
source (domain). **Open:** a wrong `date` with a real quote is still kept (dates are not checked
against the page; pinned by the replay test); pages that render with JavaScript (NVD detail pages,
SEC EDGAR company pages) cannot verify, so the NVD and EDGAR JSON or filing documents must be cited.

Deferred: a live smoke run on 2–3 §8 subjects (needs a key; `RecordingModel` saves a live run as a
replay fixture); the Maintainers screen that shows contributor identity (P6; the data is in the
proposals API); feeding verified `funding` / `governance` facts into the F1/F4 views (P4) and
`lifecycle_events` / `incident_writeups` into KB event proposals (P5); the sanctions matcher itself
(P7, which reads `confirmedJurisdictions()`); following HTTP redirects is not re-checked against
the domain list (the stated URL is).

---

## 11. Tier 0 trust pass

Trust fixes to P1–P3 before any new phase (teardown, 2026-10-12: real CLI scans of parse-server,
jitsi-meet, superset and flask, and the web app on the same data). Measured on parse-server at
the pinned commit `23d7bbca` (re-scan without `--history`; the GitHub API answered 403 in the
recording session, as it did in the teardown).

### Entities, who is behind, account pivot (teardown problems 7 and 6)

| Item | Before (teardown) | After (re-scan / web on the migrated DB) |
|---|---|---|
| `reviewed` | All 6,683 health links `method: deterministic, reviewed: true` | 0 of 5,927 machine links reviewed. `reviewed` is set only by a `--review` file or `POST /api/packages/behind/review` (org table `entity_link_review`, audited, needs Triage). `method` says how a machine found the link (`deterministic`, `probabilistic`, `agent:<task>`). KB incident hops stay reviewed (hand-curated); OSV-imported incident hops are not. UI and HTML say "Machine-derived (method)" or "Reviewed by X", never both |
| Owner types | Every owner of unknown type typed `org:github/<login>`: kevva, alexei, kornelski, feross recorded as orgs | Unknown type is `owner:github/<login>` (type `owner`, "type unknown"), never an org: 0 `org:` and 332 `owner:` entities. Orgs only from deterministic sources (`repo_owner` ownerType Organization, an `org_profile` fact). `isKnownOrg()` is the check for org rules, roll-ups, policy and jurisdiction (the agentic `org_jurisdiction` planner already requires ownerType Organization). npm scopes and deps.dev projects carry no deterministic owner type (checked: `/-/org/<scope>/user` answers `{}` for real orgs and `{self: owner}` for users; deps.dev project has no owner type), so they are not used |
| Funding | 19 `funds` edges from `org:github/chalk` to the backers of `opencollective.com/sindresorhus` (casinoacademia, storis, …); `opencollective/babel` typed as a funder of babel | No `funds` edges, no `funder` entities, "casino" in no output. Only `pkg --receives_funding_at--> funding:<platform>/<handle>` when the package's own `funding` field or its repo's FUNDING.yml names it (chalk: its FUNDING.yml's GitHub Sponsors and `opencollective/sindresorhus`; babel packages: `funding:opencollective/babel`). Backer lists (`via: opencollective`) make no links until P4 models direction |
| `GET /api/packages/behind?name=debug` | `{"usedIn":3,"links":[]}` (read only the finding table); chalk, express, agent-base the same | qix and tootallnate (maintains), `owner:github/debug-js` (owns), each with evidence, `deterministic`, unreviewed; plus `publishRights` (qix, tootallnate), `lockedVersions` (4.4.3 by qix, `_npmUser`, production; 2.6.9 and 3.1.0 by tootallnate) and `review` counts. chalk: sindresorhus, owner chalk, 4 funding pages; express: 5 maintainers, `owner:github/expressjs`, `funding:opencollective/express`. Reads the health graph through `scan_package_behind` (migration 13, filled at scan completion and backfilled) |
| Package page | No who-is-behind section; breadcrumbs "Incidents > react-redux" | "Who is behind it": can publish now, who published each locked version (with known-bad badge), repository owner, funding pages, machine-derived/reviewed counts, link to every link with sources. Breadcrumbs (package, who's behind, account) go through Exposure; the sidebar marks Overview |
| Account pivot `/api/accounts/npm/qix` | `incident: null`; color-convert 3.1.1 not flagged; counts 18 vs 7 | `knownBad`: INC-2025-0002 (KB) with its OSV MAL ids (MAL-2025-46971 … fetched per package by the account index into `registry_advisory`) and 8 of qix's packages; color-convert@3.1.1, color@5.0.1, color-string@2.1.1, is-arrayish@0.3.3, simple-swizzle@0.2.3, backslash@0.2.1 flagged in place (also on package and exposure rows). Counts in one unit (package names): can publish 79 (after its listing), in your projects 7, in production 7 = concentration 7 of 1,917 (the 18 was name@version). Definitions in `ACCOUNT_COUNT_DEFINITIONS`, shown on the page |
| HTML report | 0 matches for stabil, fragile, funding, behind | "Who is behind" (top npm accounts by production reach, repository owners with type, funding pages, machine-derived vs reviewed), "Stability" (34 production Fragile with action and evidence), NOT ANALYSED banner hook (reads `notAnalysed` or `coverage.notAnalysed`) |

**Stored data (migration 13).** Every stored scan result, finding row and hash is rewritten:
machine links `reviewed: false`, `org:github/` → `owner:github/` (stored data cannot tell known
orgs from unknown ones; a rescan restores known orgs), `funds` edges and `funder:` nodes removed,
GitHub Sponsors `account:github/<h> linked_to` → `funding:github/<h> receives_funding_at`. On the
teardown web DB (3 scans, 81 MB) it runs in about 2 s.

**Tests on recorded real data** (parse-server @ `23d7bbca`): `test/fixtures/entities/`
(`parse-server-facts.json.gz`: the real entity facts, e-mails removed; `parse-server-server.json.gz`:
the real scan result and inventory plus live npm packuments and OSV answers;
`teardown-parse-server-before.json.gz`: the pre-Tier 0 engine output), recorders
`test/entities/record*.ts`, tests `test/entities/tier0.test.ts` and `server-tier0.test.ts`; web
`src/pages/tier0-real.test.tsx` on recorded API answers (`src/test/real/tier0-api.json`) and e2e
`e2e/screens-f-tier0.spec.ts` (with axe, light and dark).

**Deferred.** Owner types stay unknown while the GitHub API is unreachable (no token in the
recording session); a "GitHub Sponsors" handle is shown as a funding page, not typed as a person or
org. Funding direction, amounts and backers are P4. `funds` stays in the relation type so old review
files parse. Stored scans keep the old owner typing of known orgs only until rescanned.

### Scope, exposure-gated scoring, coverage (teardown problems 1, 2 and 8)

Real re-scans without `--history` at the pinned commits (`scans/target-commits.txt`): parse-server
`23d7bbca`, jitsi-meet `36d4c1c7`, flask `d086db85`, superset `42bbfa49` (requirements/ only, sparse
checkout). "Before" is the teardown scan of the same commit.

**One scope per (project, package)** (`src/core/scope.ts`): `runtime`, `peer`, `optional`, `ci`
(workflows, Docker build stages), `dev`, `unreachable`. A path is as weak as its weakest link (a
project in `test/`/`examples/` is dev, a workflow is CI); a package takes its strongest path; only
runtime is production. Findings (`scope`, `gate`), SARIF (`properties.scope`), the CycloneDX
`scope` (required / optional / excluded) and `blastradius:scope`, SPDX package comments,
`/api/search/exposure`, `/api/packages/reach` (through `pathsTo`), the web finding rows
(`prodAssets`, production filter and sort) and `InventorySummary.byComponentScope` read it. Paths
list the strongest path first, so the runtime introducer is named before a dev tool.
`productionSet()` is the helper for the stability production flag (stream B owns
`src/stability/production.ts`, which still counts optional and peer as production until it switches).

**Exposure gate** (`src/scoring/index.ts`): the level comes from signals only; a runtime advisory
with CVSS >= 9 and a fix is raised to critical and ranks above every non-runtime finding; peer and
optional stay below critical, dev / CI / unreachable below high; posture and provenance
(Scorecard, no provenance, single maintainer, abandoned) add at most 0.9 points, never change the
level and produce no SARIF result. Lists are production first (CLI, JSON order, HTML, web `-score`
sort). Exception, stated in the gate detail: a malicious or compromised release runs at install time
and ranks with runtime findings in any scope.

| Item | Before (teardown) | After (re-scan) |
|---|---|---|
| parse-server top 10 | 1 of 10 runtime; all 6 HIGH dev-only (decompress, sprintf-js on weak_posture, http-cache-semantics ×2, braces, source-map-js) | 10 of 10 runtime (exactly the 10 runtime findings); 0 HIGH |
| proxy-addr@2.0.7 (GHSA-jqcg-44mw-7w3h, CVSS 9.1, fixed 2.0.8) | MEDIUM 54.3, rank 13 | CRITICAL 80.2, rank 1: "Runtime dependency (brought in by express) with GHSA-jqcg-44mw-7w3h (CVSS 9.1) and a fix available (2.0.8): raised to critical and ranked above every non-runtime finding." |
| parse-server levels / SARIF | high 6, medium 45, low 4; 173 SARIF results, 111 posture (BR005–BR008) | critical 1, medium 33, low 21; 62 SARIF results, 0 posture |
| agent-base 7.1.4 | production true / false / true in search, reach, stability | runtime in every view (search production true via @parse/push-adapter, reach production true, `productionSet` true) |
| debug "brought in by" | @babel/core (dev) | the runtime introducer first (express / @parse/push-adapter), dev tools after |
| fsevents | "3 prod" | scope dev (optional under @babel/cli → chokidar); never production |
| parse-server scopes | none | runtime 350, peer 2, optional 81, dev 1,120, ci 16 |
| jitsi-meet levels / SARIF | high 7, medium 81, low 2; 288 SARIF results, 190 posture; top 10: 7 runtime | medium 56, low 27; 91 SARIF, 0 posture; top 10 all runtime (31 runtime findings); sources osv ok, depsdev ok, npm partial (@jitsi/excalidraw 404), github partial (300-repo cap, 403) |

**Placeholders.** Only lockfile-resolved versions become components. A `package.json` without a
lockfile, `0.0.0` placeholders and ranges are one "unresolved manifest entries" warning per manifest
and a not-analysed entry; a lockfile `0.0.0` installed from a GitHub release tarball takes the
release tag (lib-jitsi-meet → `v2223.0.0+a8e7d0b1`, `download_url` qualifier).

| jitsi-meet | Before | After |
|---|---|---|
| Findings at 0.0.0 | 7, incl. @xmldom/xmldom "CVSS 9.8" | 0; no @xmldom/xmldom finding (the locked 0.8.15 has no advisory) |
| Components / CDX components / licence rows at 0.0.0 | 75 / 75 / 75 (71 of 81 review rows) | 0 / 0 / 0 |
| Warnings | none for react-native-sdk | "react-native-sdk/package.json: 75 unresolved manifest entries (75 placeholder 0.0.0) …" |

**No false all-clear.** Every manifest found but not analysed is listed with an approximate package
count in the CLI summary (`!! NOT ANALYSED: …`), the JSON (`notAnalysed`), the HTML banner, SARIF
run properties and an error notification, CycloneDX metadata properties, the SPDX creation comment
and the web project header (`GET /api/projects/:id/coverage`). Per-source coverage
(`coverage.sources`: osv, depsdev, npm, licenses, github, … with ok / partial / failed, facts,
problems, reason) is shown next to it ("!! SECURITY SOURCE INCOMPLETE: osv failed …"). `--strict`
exits 3 when anything was not analysed or a security source (OSV, the knowledge pack) failed or
answered in part. The HTTP client's default transport now installs the HTTPS_PROXY dispatcher
itself (`ensureEnvProxy`), so library and server callers no longer skip every host silently.

| Repo | Before | After |
|---|---|---|
| flask (uv.lock) | 9 components (all GitHub Actions), "critical 0 \| high 0 \| medium 0 \| low 0", uv.lock and pyproject.toml ignored, no warning | 108 components (99 PyPI); runtime blinker, click, colorama, itsdangerous, jinja2, markupsafe, werkzeug; werkzeug 3.1.8 GHSA-g6x2-hccm-hh4m; NOT ANALYSED examples/javascript and examples/tutorial pyproject.toml (no lockfile, ~4 packages); `--strict` exits 3 |
| superset requirements/base.txt | byEcosystem docker 11, githubactions 36, npm 3,096; 146 pins dropped | 312 PyPI components (base 146 runtime with the pip-compile `# via` graph, development.txt dev); paramiko 3.5.1 `LGPL-2.1-or-later` and pyxlsb 1.0.10 `LGPL-3.0-or-later` (deps.dev "LGPLv3+"), weak copyleft; certifi MPL-2.0 |
| jitsi-meet | silent on Ruby, Gradle, CocoaPods and the SDK manifest | NOT ANALYSED: Gemfile.lock ~133, ios/Podfile.lock ~215, react-native-sdk/package.json 75, 6 Gradle files ~28 (~451 packages) |

Python ingestion (`src/ingest/python.ts`, `toml.ts`): requirements*.txt (exact `==` pins, `-r`
includes, `--hash` → SRI integrity, `# via` graph, unpinned / URL entries unresolved), uv.lock
(projects as importers; runtime, optional-dependencies, dev groups; requested extras), poetry.lock
(groups / category, pyproject roots), Pipfile.lock, pyproject.toml. OSV queries the PyPI ecosystem;
deps.dev gives repo, Scorecard and dependents for PyPI (no provenance fact: deps.dev does not report
PyPI attestations, so absence would be a false "no provenance"); licences already covered PyPI.
Exposure search and advisory matching work for npm, PyPI (PEP 503 names), GitHub Actions, Docker and
any purl (`?q=pkg:pypi/paramiko@3.5.1`, `requests==2.32.3`, `actions/checkout`).

**Tests on recorded real data.** `test/fixtures/tier0/<case>/repo` holds trimmed manifests from the
pinned commits (parse-server lockfile closure of express, @parse/push-adapter, @babel/core,
@babel/cli, @semantic-release/github, mongodb-runner: 798 packages; jitsi root lock subset, the SDK
manifest as committed, Gemfile(.lock), a Gradle file; flask pyproject + uv.lock subset; superset
base.txt lines); `http/` the OSV, deps.dev and ClearlyDefined answers (`test/tier0/record.ts`; OSV
credits and ClearlyDefined attribution removed, e-mails masked). Gates in `test/tier0/tier0.test.ts`
(24), unit tests in `src/core/scope.test.ts`, `src/ingest/python.test.ts`, `src/watch/match.test.ts`,
reach, SARIF, server and web banner tests. Counts after merging stream C: blastradius 951 tests (879 before Tier 0), web 317 unit (+3 from this
work) and 66 e2e.

**Deferred.** Stability's production flag switches to `productionSet()` in stream B. SBOM
supplier/hashes/DEV_DEPENDENCY_OF and a build-environment SBOM are Tier 1 (problem 9). yarn, pnpm,
Go, Cargo, Maven, Gradle, Ruby, CocoaPods stay NOT ANALYSED (listed, counted, `--strict`). Syft
default-on is not done. PEP 440 ordering for PyPI ranges uses the loose semver comparison.

### Stability, git history and coverage (teardown problems 3, 4 and 5)

Measured by re-scanning parse-server (`23d7bbca`) and jitsi-meet (`36d4c1c7`) with `scan --history`
(default cap 300 repositories, manifests-only sparse checkouts), against the teardown's scans of the same commits. "Production" is now runtime only (Stream A's `src/core/scope.ts`), so the production totals shrink (parse-server 407 → 340, jitsi-meet 1,343 → 929); the before column keeps the teardown's numbers. The GitHub API
answered 403 here, so no GitHub login mapping ran; identities were resolved by display name and npm
publisher only. Superset was not re-scanned (disk); its Ended rows are covered by the recorded
fixture below.

| Target | Before (teardown) | After |
|---|---|---|
| False "Fragile: ended" in production | parse-server 14 of 34 (41 %) moved-and-released; jitsi image-size, superset @jridgewell/trace-mapping, agent-base | 0 % on all three: every remaining Ended row checked by hand (`HAND_CHECKED` in `test/stability/tier0.test.ts`, npm deprecation or GitHub archived flag). re-scans: parse-server 34 → 19 Ended + 7 Watch "Moved" (runtime scope; before the scope change 20 + 16), jitsi-meet 40 → 28 Ended + 6 Moved in production (19 moved overall: socket.io, eslint/js, webdriverio/driver, image-size on Codeberg, …); superset on the recorded Ended set 34 → 29 + 2 Moved |
| Named moved packages | @google-cloud/firestore, gaxios, google-gax, retry-request, agent-base, gcp-metadata Fragile-ended | Watch, rule `watch_moved`, action e.g. "Moved: upgrade to 9.x (repo github.com/TooTallNate/proxy-agents, packages/agent-base)"; the old repository's archived flag is context |
| Real ends stay Fragile | ldapjs, crypto-js, npmlog/gauge, @mui/base, request, left-pad | unchanged (tests on recorded data) |
| "latest gap 35 days" on cluster-key-slot | cadence statistic first | "Last release 1.1.2 on 2022-11-01 (3 years ago). Releases up to then: …, gap between the two most recent 35 days." |
| Single maintainer on google-wombot | `single_maintainer` finding factor, "1 maintainer" | "npm lists 1 maintainer with publish rights (an organisation release bot, not a person)"; no `single_maintainer` factor |
| Family rows (9 @ldapjs/*) | 9 rows | one decision row: "Replace or upgrade ldapjs (direct dependency): it and 8 packages of the same family it brings in are Fragile …"; parse-server 34 decision rows (72 Fragile, 7 moved) |
| Takeovers (release_takeover) in production, last 12 months | parse-server 118 repo-level observations, nanoid's author flagged in all three scans | parse-server 0; jitsi-meet 1 (react-native-sound v0.13.0) |
| S5a items in production (packages with the S5a rule, last 12 months) | parse-server 20 packages / 31 observations; jitsi-meet 76 packages | parse-server 3 (graphql-relay 0.11.0, jws 4.0.1, process-warning 5.1.0), each its own account event; jitsi-meet 4 (react-native-paper, -safe-area-context, -sound, -video). Both under 5 |
| Production Unknown | parse-server 204 of 407 (50 %), jitsi-meet 851 of 1,343 (63 %), superset 862 of 1,163 (74 %) | parse-server 9 of 340 (2.6 %), jitsi-meet 26 of 929 (2.8 %); superset not re-scanned |
| Time per repo | parse-server 867 s, jitsi-meet 806 s (cold) | parse-server 847 s cold, 237 s with a warm HTTP cache and fresh clones, 33 s fully warm; jitsi-meet 945 s cold, 49–206 s warm. Lowest free disk during the scans 558 MB |
| Web history | only in fixture mode; Unknown for 1,145 of 1,213 | background job after every online scan (`serve`, `--no-history`, `--history-max`); the scan is stored first ("pending"), then history and labels are attached |

**Moved repositories (problem 3).** `release_age` now carries the repository the version in use
and the latest release declare (`src/enrich/npm/packument.ts`). `src/stability/repo.ts` resolves the
current repository from the latest release before any S3 rule; archived flags (GitHub, now with
the repository they are about), Scorecard results and git history about another repository are set
aside as context. A transferred or renamed repository (same name under a new owner, or the
"node-" / ".js" decoration changed: visionmedia/debug → debug-js/debug) is the same repository,
not a move. Moved + released in the last 12 months + latest not deprecated = Watch `watch_moved`
with an action. The history enricher clones the current repository.

**Release dates and bots.** Every S4 context line starts with the last release and its age.
`src/history/bots.ts` lists organisation release bots with their sources (google-wombot,
react-bot, GitHub Actions trusted publishing, github-actions[bot], release-please, semantic-release-bot,
renovate, dependabot, changesets, …): never "single maintainer", never a contributor, never a new
releaser.

**Families.** `StabilityReport.decisions`: production Fragile and moved packages grouped by repository
owner (or npm scope) and by the direct dependency that brings them in; each row names that
direct dependency.

**Identity and takeover signals (problem 4).**
- Merge order: `.mailmap` (git), then display name plus overlapping activity (`src/history/merge.ts`;
  display names are kept only as salted `name:` hashes, generic or short one-word names ignored;
  activity at most 365 days apart), then the npm publisher (every id an account's registry
  addresses hash to). nanoid: 2 ids merged, no takeover. picocolors: someone first seen on the
  repository's first day is never a takeover.
- Not a person's release: a release published through npm trusted publishing (moment 2.31.0) or by
  an org release bot (react v19.0.1 by react-bot), or by an npm account that had already published
  this package (xmldom 0.8.12) or a sibling package of the same owner or scope (the expressjs/jshttp
  team): the npm publisher is the actor id. A tag counts only for the package it names
  (`projectify-v5.0.0` in googleapis/google-cloud-node is not a gaxios release) and only when that
  package published the version (react's `v19.0.1` is no scheduler release, protobufjs `v6.11.5` no
  @protobufjs/utf8 release).
- Without identity resolution (no display names and no login mapping) the git-only S5a kinds and
  C1 are context only; the npm-side observation (matched through the registry account) still counts.
- Window kinds are context only: release_handover, contributor_base_changed, top_committer_new,
  time_zone_pattern_changed, signed_share_changed (`watch_signed_share_fell` and
  `watch_contributor_base_changed_with_other` no longer fire). Takeovers are dated to their
  causing release (xz: v5.2.11, 2023-03-18; event-stream: 3.3.5, 2018-09-05), not the window end.
- Events (`src/stability/events.ts`, Changes page): threshold crossings between two stored scans
  (label got worse, or an S5a observation the previous scan lacked), dated to the causing commit or
  release; last 90 days, production only, at most 20, one row per account event. A first scan is the
  baseline. Rising stability is never an event.
- Maintainer additions by an account that already maintains a sibling package (same scope or
  repository) are marked `sibling` and not scored: the 8 MEDIUM "added martinrrm" findings in
  parse-server's npm/cli packages are gone.

**Coverage (problem 5).** History and GitHub lookups pick repositories by priority (direct runtime,
then production fan-in, then the rest; `src/stability/priority.ts`), `--history-max` sets the cap.
Repositories not read fall back to the Scorecard Maintained check (deps.dev, no clone) and the npm
release record (`basis: scorecard+npm | npm`, said in the label): Steady needs a release within 12
months or Scorecard ≥ 5; no release in 18 months is Watch `watch_no_recent_release` (never Fragile),
unless small and finished. The CLI prints the coverage line, e.g. parse-server: "Upkeep assessed for 1,167 of 1,213 (git history 515, Scorecard / npm fallback 652): all 41 direct, 290 of 299 runtime transitive; skipped: 33 git history not read, last release 12–18 months ago and no Scorecard result; 12 fewer than 5 commits in the last active 24 months; 1 no npm release record. Git history read for 300 of 889 repositories (589 over the cap of 300, picked by priority).".

**Tests on recorded real data.** `test/stability/tier0.test.ts` with
`test/fixtures/stability/recorded/tier0-ended.json.gz` (every Ended package of the three real scans:
packuments, deps.dev/Scorecard for the in-use and latest repositories, sizes, OSV),
`tier0-identity.json` + `history/tier0-{nanoid,react,picocolors,moment,xmldom}.json` (scheduler shares react's) (histories with salted
display-name keys and npm-account ids) and `tier0-maintainers.json.gz` (npm/cli packuments);
`test/fixtures/history/recorded/event-stream.json` re-recorded with display-name keys (same 322
commits and 13 tags). Recorders: `test/stability/record-tier0*.ts`. Server:
`src/server/history-job.test.ts` (background history), `src/server/stability.test.ts`; web unit
tests and `e2e/screens-e-stability.spec.ts` (axe light and dark).

**Deferred.** react's maintainer address change still reads as two people in the aggregate (the
earlier address used another display name; needs GitHub login mapping, i.e. a token): it no longer
reaches the label because v19.0.1 went out through react-bot. The 90-day event view needs two
stored scans (web); the CLI has no stored baseline. Superset not re-scanned for the Unknown target
(disk). A server restart leaves a "pending" background history pending until the next scan.

### Tier 0.5: scoring precision (independent verification of Tier 0)

An independent verification re-scanned parse-server, jitsi-meet and superset after Tier 0 and found
precision problems in finding scoring, scope and reporting. Fixed on recorded real data and measured
by re-scanning the three repositories at the pinned commits **without `--history`**
(`NODE_USE_ENV_PROXY=1`, `--no-cache`, one at a time, clones deleted in between; superset from a manifests-only sparse checkout because the shared disk ran low, same inventory: 3,454 components). "Before" is the
verification's scan of the same commit. Stability and history (README "ended", identity merge,
Python upkeep, history disk budget) are a separate stream and are not covered here.

| # | Item | Before (verification) | After (re-scan) |
|---|---|---|---|
| 1 | False `provenance_dropped` | jitsi #1 react-native-screens@4.23.0 (MEDIUM 50.1, "the previous release (4.23.0-nightly-…) had" provenance); parse-server @typescript-eslint/* 7.18.0 ×3 and jitsi 8.19.1 ×8 against canaries (7.17.1-alpha.9, 8.19.1-alpha.9) | Compared stable to stable on one release line only (`previousStableOnLine`: same major, same major.minor for 0.x; prereleases never compared). 0 `provenance_dropped` in the three re-scans. react-native-screens and @typescript-eslint/* are not flagged (no stable 4.x before 4.25.0, and no stable 7.x / 8.x, had provenance). A drop is an early warning about a fresh release: it decays over 90 days from the release (jose 4.15.5, a 2024 backport that lost 4.15.4's provenance, is context today), weight 0.5 → 0.3. nx 21.5.0 / 20.9.0 (stolen token) still warn an hour after release (proof unchanged: 11 of 16 early warnings) |
| 1 | Real CVEs first on jitsi | #1 react-native-screens (provenance only), bigint-buffer #2, svgo #3/#4 | bigint-buffer #1 (42.3), svgo 2.8.3 #2 and 3.3.4 #3 (34.6); top 10 all advisories; react-native-screens is a health entry (posture only) |
| 2 | Maintainer-change-only findings | superset #1 proxy-addr@2.0.8 "added ulisesgascon" (MEDIUM 34.8) and 11 maintainer-change-only findings; parse-server ws, mongodb-connection-string-url ("added dariakp; removed … devtoolsbot", false); fast-uri "removed simoneb" superset #10 | A maintainer-list change alone is context (`Reason.context`, a tie-breaker like posture, no SARIF result) and never a top reason; backed by another signal it counts. The diff comes from the packument's current `maintainers` (an added account must still maintain it, a removed one must not) and `_npmUser` (a later publisher was not removed); lists stored by trusted-publishing releases are never compared (mongodb-connection-string-url 7.0.2 stored 3 of its 8 maintainers). The stability stream's exemptions apply to maintainer and publisher changes: trusted publishing, organisation release bots, and accounts that already maintain or published a sibling package of the same npm scope, repository or **repository owner** (ulisesgascon maintains forwarded and the other jshttp / expressjs packages; madccc the @rc-component scope). maintainer-change-only findings: parse-server 2 → 0, jitsi 4 → 0 (proxy-addr, tar-stream, ws, tinyrainbow), superset 10 → 0 (proxy-addr, fast-uri, ws ×2, @luma.gl/gpgpu, apache-arrow, moment, schema-utils, negotiator, eslint-plugin-jest-dom; the verification counted 11); fast-uri "removed simoneb" is a context reason on its health entry; mongodb-connection-string-url's false text is gone (its remaining changes agree with the current list and have decayed); superset #1 urllib3 2.7.0 (an advisory; was proxy-addr "added ulisesgascon"); the four madccc @rc-component publisher changes are gone too |
| 3 | Optional and peer dependencies | parse-server uuid@9.0.1 (CVSS 7.5, under @parse/push-adapter → firebase-admin, optional) rank 11, "kept below critical and ranked after runtime findings" | Production = runtime, peer and optional (`src/core/scope.ts` `PRODUCTION_SCOPES`, `productionSet`, `isProductionScope`): npm installs optionalDependencies by default and peers since npm 7; dev and CI stay out. Labelled "optional (platform-dependent)" / "peer". uuid@9.0.1 rank 3, "Optional dependency (platform-dependent; npm installs optional dependencies by default) (brought in by @parse/push-adapter): ranked with production findings". The critical floor for a CVSS ≥ 9 advisory with a fix applies to all three. Exposure weight of an optional edge 0.2 → 1. Stability's production flag follows (stream B's control set: 222 → 227 production packages, +4 Watch +1 Unknown: exactly the 5 Tier 0 had removed — bcrypt-pbkdf, ecc-jsbn, jsbn, tweetnacl, vue; review population 193 → 197) |
| 4 | HTML Stability section | 51 per-package rows, 9 for the ldapjs family | One row per decision (as the CLI and JSON): parse-server 51 rows → 12 decision rows (ldapjs one row with its 9 packages), jitsi-meet 77 → 29, superset 37 → 27; Fragile packages no decision covers listed after them |
| 5 | `serve --dev` | seeded and scanned the demo payments-platform project | `--dev` seeds users only; `--dev-seed` creates the demo project, marked `demo: true`, badged "demo" (web), never counted in `/api/home` totals (`totals.demoProjects`), and left out of `/api/overview` when a real project exists (alone, its numbers are labelled demo data) |
| 6 | `GET /api/packages/behind` while the account index runs | `publishRights: null`, `publisher: null` (agent-base, chalk, debug, express) | `pending: true` while the index is busy and has no registry row for the package; the web package page says "Indexing…" and asks again every 5 s |
| 7 | Owner evidence | agent-base `owner:github/tootallnate` evidence `tootallnate/node-agent-base` (archived) and deps.dev 6.0.2 | The owner and its evidence come from the current repository (the latest release's `repository.url`, as stream B resolves it): `https://github.com/TooTallNate/proxy-agents` first, on both locked versions |
| 8 | Funding URL as a repository | flask: "git history: https://github.com/sponsors/encode: git clone failed" (deps.dev lists it as uvicorn 0.52.0's SOURCE_REPO) | `src/core/repo-url.ts` `isNonRepositoryUrl` (GitHub site pages such as /sponsors/, /orgs/; funding platforms) is checked by the deps.dev and npm repository normalisers, so no `repo` fact carries one (uvicorn → kludex/uvicorn). The history enricher's clone-side guard (`src/history/repo-url.ts`) delegates to it |
| 9 | xlsx@0.20.3 from cdn.sheetjs.com | an ordinary finding | Kept, with `installedFrom` and the reason text "installed from cdn.sheetjs.com, not the npm registry: advisory ranges may not apply" (CLI, JSON, HTML, SARIF property). A lockfile `resolved` URL counts as a registry tarball when it has the `<name>/-/` layout of every npm registry |
| 10 | CycloneDX `metadata.component.name` | the scan machine's absolute path | The repository or directory name (`parse-server`, `jitsi-meet`, `superset`), or `--product-name` / `--product-version`; the SPDX root package and document name the same |

**Top 10 after (re-scans without history).**

parse-server (41 findings):

| # | Package | Scope | Level | Score | Top reason |
|---|---|---|---|---|---|
| 1 | npm/proxy-addr@2.0.7 | runtime | critical | 80.2 | vuln: 1 known vulnerability |
| 2 | npm/@graphql-tools/utils@11.2.2 | runtime | medium | 33.7 | vuln: 1 known vulnerability |
| 3 | npm/uuid@9.0.1 | optional | medium | 31.8 | vuln: 1 known vulnerability |
| 4 | npm/@fastify/busboy@3.2.0 | runtime | medium | 31.7 | vuln: 3 known vulnerabilities |
| 5 | npm/node-forge@1.4.0 | runtime | medium | 31.7 | vuln: 1 known vulnerability |
| 6 | npm/core-js-pure@3.49.0 | runtime | medium | 30.3 | install_script: Runs install-time scripts (postinstall) |
| 7 | npm/moment@2.29.4 | runtime | low | 25 | vuln: 1 known vulnerability |
| 8 | npm/@apollo/protobufjs@1.2.7 | runtime | low | 15.3 | install_script: Runs install-time scripts (postinstall) |
| 9 | npm/@firebase/util@1.15.3 | runtime | low | 15.2 | install_script: Runs install-time scripts (postinstall) |
| 10 | npm/protobufjs@7.6.6 | optional | low | 15.1 | install_script: Runs install-time scripts (postinstall) |

jitsi-meet (69 findings):

| # | Package | Scope | Level | Score | Top reason |
|---|---|---|---|---|---|
| 1 | npm/bigint-buffer@1.1.5 | runtime | medium | 42.3 | vuln: 1 known vulnerability |
| 2 | npm/svgo@2.8.3 | runtime | medium | 34.6 | vuln: 2 known vulnerabilities |
| 3 | npm/svgo@3.3.4 | runtime | medium | 34.6 | vuln: 2 known vulnerabilities |
| 4 | npm/linkify-it@2.2.0 | runtime | medium | 33.9 | vuln: 2 known vulnerabilities |
| 5 | npm/socket.io-parser@4.2.4 | runtime | medium | 33.9 | vuln: 2 known vulnerabilities |
| 6 | npm/braces@3.0.3 | runtime | medium | 31.9 | vuln: 1 known vulnerability |
| 7 | npm/image-size@1.2.1 | runtime | medium | 31.9 | vuln: 2 known vulnerabilities |
| 8 | npm/uuid@8.3.2 | runtime | medium | 31.8 | vuln: 1 known vulnerability |
| 9 | npm/uuid@9.0.1 | runtime | medium | 31.8 | vuln: 1 known vulnerability |
| 10 | npm/ws@7.5.10 | runtime | medium | 31.8 | vuln: 1 known vulnerability |

superset (37 findings):

| # | Package | Scope | Level | Score | Top reason |
|---|---|---|---|---|---|
| 1 | pypi/urllib3@2.7.0 | runtime | medium | 33.6 | vuln: 3 known vulnerabilities |
| 2 | npm/xlsx@0.20.3 | runtime | medium | 32.9 | vuln: 2 known vulnerabilities |
| 3 | npm/core-js@3.50.0 | runtime | medium | 30.3 | install_script: Runs install-time scripts (postinstall) |
| 4 | npm/sprintf-js@1.0.3 | runtime | low | 22.8 | vuln: 1 known vulnerability |
| 5 | npm/sprintf-js@1.1.3 | peer | low | 22.8 | vuln: 1 known vulnerability |
| 6 | pypi/werkzeug@3.1.6 | runtime | low | 21.1 | vuln: 1 known vulnerability |
| 7 | pypi/geopy@2.4.1 | runtime | low | 16.9 | vuln: 1 known vulnerability |
| 8 | npm/@scarf/scarf@1.4.0 | runtime | low | 15.4 | install_script: Runs install-time scripts (postinstall) |
| 9 | npm/unix-dgram@2.0.7 | optional | low | 15.3 | install_script: Runs install-time scripts (install) |
| 10 | pypi/paramiko@3.5.1 | runtime | low | 14.5 | vuln: 1 known vulnerability |

**Tests on recorded real data.** `test/tier05/tier05.test.ts` (22) replays lockfile slices of the
three repositories at the pinned commits with the OSV, deps.dev and npm answers recorded for them
(`test/tier05/record.ts`, `test/fixtures/tier05/{parse-server,jitsi-meet,superset}.json.gz`:
packuments slimmed as the npm enricher slims them, e-mails removed, packuments kept only for the
packages under test), plus the real ldapjs slice of the verification's parse-server stability report
and the jose packument. Web: `src/pages/tier05.test.tsx`, an Overview case, and
`e2e/screens-g-tier05.spec.ts` (axe light and dark). Changed expectations, each for the reason
above: `src/core/scope.test.ts`, `src/report/reach.test.ts`, `test/tier0/tier0.test.ts` (production
tier, gate wording), the stability control set (`test/stability/stability.test.ts`, numbers above)
and one `productionComponents` case in `src/stability/stability.test.ts`. Counts: blastradius
996 tests after merging the agentic stream (970 before; 22 in `test/tier05`), web 321 unit (318 before) and 69 e2e (66 before).

**Deferred.** A sibling check reads the scan's own packages (not an account's whole listing). The
demo project is recognised by its fixture target, not a stored flag. Superset's npm workspaces are
scanned as found; its `--history` labels are stream Y's.

### Tier 0.5: stability, identity, Python upkeep and history disk budget (independent verification of Tier 0)

The same verification found precision problems in the upkeep labels and the git-history signals.
Fixed on recorded real data and measured by re-scanning parse-server (`23d7bbca`), jitsi-meet
(`36d4c1c7`), superset (`42bbfa49`) and flask (`d086db85`) **with `--history` and default settings**
(`NODE_USE_ENV_PROXY=1`, one at a time, HTTP and clone caches deleted between repositories, so every
run is cold), after merging Stream X's Tier 0.5 (production = runtime, optional and peer, so the
production totals grew: parse-server 340 → 408, jitsi-meet 929 → 931, flask 7 → 9). "Before" is the
verification's scan of the same commit (superset with `--history-max 120`; its default run was killed
by the disk watchdog). Every production Ended row of the after-scans was re-checked against the
registry (npm latest-release deprecation; PyPI project status, Inactive classifier, last release) and
the Scorecard API (`api.securityscorecards.dev`, independent of the deps.dev run the label cites);
the GitHub API and pages answered 403 in this session.

| # | Item | Before (verification) | After (re-scan) |
|---|---|---|---|
| 1 | README "ended" | rc-util (superset, production) Watch-ended on `### deprecated`, which documents its `deprecated()` helper; amplitude-js (jitsi-meet, production) on "## Deprecated - React Native" | Only a project-level declaration counts, still low confidence and still needing a second fact (`src/stability/declared.ts`): a status heading ("Deprecated", "Discontinued", "No longer maintained", …) among the first two headings; a project-level sentence ("this project/package/library is deprecated / archived / no longer maintained / unmaintained / abandoned", "is fully deprecated", "is a legacy project", "in maintenance mode", "development has been discontinued") in the opening section (before the third heading, at most 3,000 characters); or a status badge there. rc-util, amplitude-js and @xmpp/jid declare nothing; moment ("a legacy project, now in maintenance mode"), request, crypto-js, path-is-absolute, node-domexception, buf-compare, core-assert, deep-strict-equal, os-homedir, typescript-json-schema still do. parse-server moment 2.29.4: Watch, declared maintenance mode (as before). False Ended: jitsi-meet 1 of 29 → 0 of 28, superset 1 of 27 → 0 of 32 |
| 2 | Identity merge and continuity | S5a in production: parse-server 3 (process-warning false), jitsi-meet 4 (react-native-sound and react-native-video false) | Display-name keys ignore spacing and case ("Romuald Percereau" = "RomualdPercereau"). A short one-word name ("KaKa", "fnwk") gets a weak key that merges an address only into a GitHub login that is the name itself or an npm account publishing the repository's packages. An npm account that already published a package of the same repository owner outside the scan (npm search `maintainer:<account>` and those packuments; climba03003 published fastify and fast-json-stringify) is no newcomer. Pre-releases say nothing when every version in use is stable (react-native-video 7.0.0-beta.9 while 6.19.1 is in use), and an account that published pre-releases long before its first stable release is no newcomer (stack-trace 1.0.0-pre1 in 2021, 1.0.0 in 2026). A takeover's day count is counted to its own date (react-native-sound: "first seen 2025-05-06" with 161 days, was 524). S5a in production after: parse-server 2 (graphql-relay 0.11.0, jws 4.0.1), jitsi-meet 2 (react-native-paper v5.15.0, react-native-safe-area-context 5.7.0: real and benign, kept), superset 2 (@great-expectations/jsonforms-antd-renderers 2.2.8, numexpr's new top committer), flask 0. event-stream 3.3.5 and xz (Jia Tan, also from a shallow clone) still fire |
| 2b | Continuity without an npm publisher (new with PyPI labels) | — | Labelling PyPI brought git-side observations with nothing to check them against: superset had 10 in production in an interim re-scan. Two causes, both fixed: releases published through PyPI Trusted Publishing (a PEP 740 attestation in the Simple API: filelock, humanize, click, slack-sdk, croniter) are the project's CI, as npm trusted publishing is; and a lightweight tag on a commit GitHub's web flow committed names no release maker (git only knows the pull request's author: sqlglot v30.20.0, humanize 4.16.0). PyPI's release list also gives the "a tag the package never published is not its release" check. A PyPI project whose declared repository is archived while releases continue (google-auth: google-auth-library-python) is Watch "Moved", its archived history set aside. 10 → 2 |
| 3 | Python upkeep | flask: 0 packages labelled, "Upkeep assessed for 0 of 0"; superset: 312 PyPI components (146 runtime) not labelled and not in the production denominator; the HTML said "No production package is labelled Fragile." | New PyPI enricher (`src/enrich/pypi`, JSON API and PEP 691 Simple API, not kept in the disk cache: 340 MB for superset): releases and their dates, yanked versions, the latest release, PEP 792 project status (archived / deprecated end the project, quarantined is context), the "Development Status :: 7 - Inactive" classifier (a declaration, low confidence). PyPI packages get the same labels as npm ones from that record, deps.dev's repository and Scorecard Maintained check, and git history when the repository is read (`basis: git | scorecard+pypi | pypi`). Production packages of an ecosystem without an upkeep source (Docker images) are Unknown entries with the reason; CI-only ones are counted in the coverage line. The line now reads per ecosystem, e.g. superset: "Upkeep assessed for 2,669 of 2,767 (npm 2,369 of 2,452, PyPI 300 of 312, Docker 0 of 3 (production, no upkeep source); git history 704, Scorecard / registry fallback 1,965): …; production Unknown 45 of 1,311; skipped: …". flask: 9 of 9 production PyPI packages labelled (6 Watch, 3 Steady), 0 Unknown; superset: all 146 runtime PyPI packages in the denominator, 5 Unknown, each with its reason. The HTML says "No assessed production package is labelled Fragile, but upkeep is not assessed for N of M production packages" when any is Unknown, and prints the coverage line |
| 4 | History disk budget | superset default run killed at 1,608 s with a 2.35 GB cache (clone cache about 1.2 GB) and 449 MB free | `--history-max-mb` (default 600, also on `serve`): before a clone, least recently used clones not being read are deleted until the cache plus the clones in flight fit; one clone may take budget / 3 (200 MB at the default), a larger repository is skipped and named in the coverage line. Clones are shallow (`--shallow-since` 60 months: the 24-month CAF, the 12-month windows, and a 24-month look-back in which first-seen dates are read as "on or before"); a repository whose last commit is older than 36 months is deepened to its whole history, and one with no commit in the window is cloned whole. Superset default run completes: 1,950 s cold (history phase 8 min 48 s for 300 repositories), clone cache peak 334 MB (du; 323 MB by the enricher's own count) of 600, 151 clones evicted; the scan's whole cache (HTTP 1.15 GB + clones) peaked at 1,488 MB, lowest free disk 802 MB. parse-server 1,110 s (history 8 min, clone peak 331 MB), jitsi-meet 1,371 s (history 7 min 30 s, 483 MB), flask 138 s (history 1 min 33 s, 233 MB) |
| 5 | Funding URLs | flask: "git history: https://github.com/sponsors/encode: git clone failed" | Never cloned: `src/history/repo-url.ts` delegates to Stream X's `src/core/repo-url.ts` `isNonRepositoryUrl`, and labels never call a funding page the repository. CI actions and container images are not cloned either (no label would use their history). flask: history read for 85 of 85 repositories (was 84 of 85) |

**Tier 0 targets after Tier 0.5 (default `--history` runs).**

| Repository | False Ended in production | S5a items in production | Production Unknown |
|---|---|---|---|
| parse-server | 0 of 20 (0 %) | 2 | 11 of 408 (2.7 %) |
| jitsi-meet | 0 of 28 (0 %) | 2 | 26 of 931 (2.8 %) |
| superset | 0 of 32 (0 %; optimist rests on its README "DEPRECATION NOTICE: I don't want to maintain this module anymore", last release 2014, read by hand) | 2 | 45 of 1,311 (3.4 %; PyPI 5 of 146, Docker 3 of 3) |
| flask | none | 0 | 0 of 9 |

**Tests on recorded real data.** `test/stability/tier05.test.ts` with `tier05-readmes.json.gz`
(READMEs and packuments of rc-util, amplitude-js, @xmpp/jid, moment and nine real declarations),
`tier0-identity.json` + `history/tier0-{process-warning,react-native-sound,react-native-video,react-native-paper,react-native-safe-area-context,stack-trace}.json`
(with each publishing account's cross-registry sibling answer), `tier05-pypi-{flask,superset}.json.gz`
(the PyPI part of each inventory and the deps.dev, Scorecard and PyPI responses, replayed through
the real enrichers) and `tier05-pypi-history.json.gz` (filelock, humanize, sqlglot). Recorders:
`test/stability/record-tier05*.ts`, `record-tier0-identity.ts`.

**Deferred.** Superset's remaining S5a items may be real (numexpr's new top committer; a new npm
publisher of @great-expectations/jsonforms-antd-renderers). The npm search API rate-limits (429): a
failed sibling lookup keeps the observation. Offline scans from a warm cache have no PyPI release
record (not disk-cached), so PyPI upkeep falls back to Scorecard or Unknown there. The HTTP cache
(npm packuments, 1.15 GB for superset) is now the largest disk user of a scan.
