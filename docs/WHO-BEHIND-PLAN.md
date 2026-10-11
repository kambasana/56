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
was corrected: `request`'s repository is not archived. Gate results for P0, P1 and P2 are in §10, with the agentic gap-filler's pipeline, gate and guardrails.

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
| **Fragile** | (CAF = 1 **and** S3 `inactive`) · (CAF = 1 **and** F3 `stopped`) · S3 `ended` while a production dependency | amber, with the triggering rules |
| **Watch** | CAF = 1 · S3 `quiet` · F2 concentrated ≥ 0.5 with F3 `declining` · S5a release-continuity · L2 category change · C1/C2 change | neutral with dot |
| **Steady** | none of the above with ≥ medium-confidence data for S2 and S3 | plain |
| **Unknown** | no git history or no repo | grey, says what is missing |

Rules and thresholds live in one file (`src/stability/rules.ts`) like `weights.ts`. Every label
lists its reasons with source and confidence; a label from low-confidence facts only is capped at
Watch. The existing intrinsic risk score is unchanged (it is proven); the only cross-over is that
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
| 1 | `event-stream` (npm) | Handed to a new maintainer in 2018; malicious dependency `flatmap-stream` added (https://github.com/dominictarr/event-stream/issues/116, in KB `kb/incidents/2018-event-stream.yaml`) | S1: 1 maintainer before; `maintainer_change` (exists); **S5a** for 3.3.6: published by an account first seen in the repo < 180 days before; C1 "contributor base changed"; label Watch before the event, no claim of intent. **P2 result (git part, met):** see §10 |
| 2 | xz-utils (git history only, mirror `github.com/tukaani-project/xz`) | Backdoor CVE-2024-3094 in 5.6.0/5.6.1 (https://nvd.nist.gov/vuln/detail/CVE-2024-3094 , https://www.openwall.com/lists/oss-security/2024/03/29/4) | S2: CAF 1–2 over 2019–2021 (one long-standing maintainer); C1: a contributor first seen ~2021 becomes top committer and tags releases by 2024; C2/C3 shown as aggregate repo changes if present; wording "contributor base changed", no statement about any person. **P2 result: met**, with two corrections: the account's first commit is 2022-02 (not ~2021), and the C1 share rule fires on scans dated 2023-08 to 2024-02 but not at 2024-03-28 (see §10) |
| 3 | `colors` and `faker` (npm) | Maintainer-published sabotage releases, January 2022 (GHSA-gh88-3pxp-6fm8, GHSA-5w9c-rv96-fr7g; KB `2022-colors-faker.yaml`) | Before: S1 = 1, S2 CAF = 1, label Watch; `faker` later deprecated → S3 `ended`; community fork `@faker-js/faker` shows org owner and OC collective (F1) [v P0: collective `fakerjs`, type COLLECTIVE, OC API] |
| 4 | `left-pad` (npm) | Unpublished March 2016 (https://blog.npmjs.org/post/141577284765/kik-left-pad-and-npm) | S1 = 1, CAF = 1; latest version deprecated → S3 `ended` [v P0: 1.3.0 is deprecated, message "use String.prototype.padStart()"] |
| 5 | `core-js` (npm) | Maintainer's 2023 funding statement (https://github.com/zloirock/core-js/blob/master/docs/2023-02-14-so-whats-next.md); README says not backed by a company [v via README text] | S2 CAF = 1; F1 ≥ 3 declared channels incl. Open Collective; F4 owner is a User, no company backer; F2/F3 from OC; I: `funding_change` event (curated, source = the post) |
| 6 | `request` (npm) | Deprecated Feb 2020 (https://github.com/request/request/issues/3142) | S3 `ended` (npm deprecated [v P0: 2.88.2 "request has been deprecated, see https://github.com/request/request/issues/3142"]; repo archived: corrected, the repo is **not** archived [v P0: OpenSSF Scorecard 2026-10-05 Maintained check reports "0 commit(s) and 0 issue activity … in the last 90 days", not "project is archived"]); label Fragile if in production; high dependents (deps.dev) shown |
| 7 | `moment` (npm) | Project declared maintenance mode in 2020 (https://momentjs.com/docs/#/-project-status/ [v P0: docs say "Moment.js is a legacy project in maintenance mode"]) | S3 `quiet`/`ended`-declared (low confidence text + release gap); S4 irregular; label Watch, not Fragile (team still exists) |
| 8 | Terraform (Go module `github.com/hashicorp/terraform`) | MPL-2.0 → BUSL-1.1, August 2023 (https://www.hashicorp.com/blog/hashicorp-adopts-business-source-license [u: answers 429 here]; [v P0: LICENSE at tag v1.5.7 is "Mozilla Public License, version 2.0", at v1.6.0 the Business Source License]); OpenTofu fork | L2: category change permissive/weak-copyleft → source-available at v1.6.0 [v P0 version]; I: `relicensing` proposal. **P1 result: not visible through deps.dev**, see the P1 gate below |
| 9 | Elasticsearch | Apache-2.0 → SSPL/Elastic License in 2021, AGPL option added 2024 (https://www.elastic.co/blog/elasticsearch-is-open-source-again [v P0: Shay Banon, 2024-08-29]; LICENSE.txt at v7.10.2, v7.11.0, v8.16.0 [v P0]) | L2 twice: to non-OSI (2021), then OSI option added (2024) |
| 10 | Redis | BSD-3 → RSALv2/SSPLv1 on 2024-03-20 (https://www.theregister.com/2024/03/22/redis_changes_license [v]); AGPLv3 option in Redis 8 (2025) [v P0: announced 2025-05-01, https://redis.io/blog/agplv3/; LICENSE.txt at tag 8.0.0]; Valkey fork | L2 at 7.4 [v P0: LICENSE.txt at tag 7.4.0 states RSALv2/SSPLv1 from 7.4]; `pkg:docker/redis` image licence shown as "declared by image metadata or unknown". **P1 result: not visible through deps.dev**, see the P1 gate below |
| 11 | `@babel/core`, `webpack` (npm) — positive controls | Long-funded via Open Collective [v P0 slugs: `babel`, `webpack`, both COLLECTIVE] | F1 OC channel; F2 multiple funders, top share < 0.5 [u: a P4 measurement]; S2 CAF ≥ 2 (**P2: miss for webpack**, 24-month and all-history CAF = 1, see §10); label Steady |
| 12 | `express` (npm) — foundation control | OpenJS Foundation project [v P0: listed on https://openjsf.org/projects] | F4 foundation backer; CAF ≥ 2 [measured P2: CAF = 6 over the 24 months to 2026-10-11, hand count 6]; label Steady or Watch with reasons |

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
| sentry (PyPI) | "BSD" → "BSL-1.1" at **20.10.1** (both non-standard in deps.dev; 10.0.0–20.x have no licence data) | reported as a change of the author's strings, with the releases without data counted |
| Terraform (Go, row 8) | MPL-2.0 (+ BSD-3-Clause from v1.1.0) for every release, also after v1.6.0 | **miss, explained:** deps.dev derives Go licences with licensecheck, which does not report BUSL-1.1; the LICENSE at tag v1.6.0 is BUSL-1.1 [v P0]. The deps.dev project record says `non-standard` today. Not fixable without our own scanner (out of scope); ClearlyDefined has MPL-2.0 for v1.5.7 |
| Redis (row 10) | not in deps.dev (no Docker or C sources; the Go module `github.com/redis/redis` stops at 2010) | **not measurable through deps.dev**; the change is verified from LICENSE.txt at tags 7.4.0 and 8.0.0 [v P0] |
| Controls: express, lodash, webpack, @babel/core, chalk (npm) | one licence across the releases compared | **0 changes** each |

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
`src/server/agentic.test.ts`, migration test), 812 in all; web 301 unit (+4) and 56 e2e (+4: the
Proposed facts list for AppSec, confirm and reject as org admin, axe light and dark). Model turns in
tests are hand-written stubs replayed by `ReplayModel` (`test/fixtures/agentic/model/stubbed.json`)
because no API key is available here; every page and registry document they lead to is a real
recording, except the clearly marked synthetic person and injection pages and the stubbed GitHub
users API responses. **Live runs: untested** (`ANTHROPIC_API_KEY` is not set in this
environment) [u]. GitHub's users API is not reachable from here (403), so `github_user` is tested
on the documented response shape only; live use is [u].

Deferred: a live smoke run on 2–3 §8 subjects (needs a key; `RecordingModel` saves a live run as a
replay fixture); the Maintainers screen that shows contributor identity (P6; the data is in the
proposals API); feeding verified `funding` / `governance` facts into the F1/F4 views (P4) and
`lifecycle_events` / `incident_writeups` into KB event proposals (P5); the sanctions matcher itself
(P7, which reads `confirmedJurisdictions()`); following HTTP redirects is not re-checked against
the domain list (the stated URL is).
