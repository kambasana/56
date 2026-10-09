# Blastradius web API (Phase 4a)

The contract between the server (`blastradius/src/server/`) and the web app. Types live in
`blastradius/src/server/api-types.ts`. The permission model lives in `blastradius/src/server/permissions.ts`.
Both files are import-safe for the web app: type imports and constant tables only, no Node APIs.
If this document and the types disagree, the types win. Fix the document.

## Conventions

- JSON in and out (`Content-Type: application/json`). Ids are opaque strings, and times are ISO 8601 UTC.
- Lists return `Page<T>` = `{ items, total, nextCursor }`. The query takes `?limit=` (default 50, max 500) and `?cursor=`.
- Bodies are validated with zod. Unknown fields are rejected with `bad_request`.
- Scanned-repo and registry values are untrusted. The server never interprets them, and the web app renders them as text (React escaping only, never `dangerouslySetInnerHTML`).

## Errors

Every non-2xx response has the same shape, `ApiError`:

```json
{ "error": { "code": "forbidden", "message": "Missing permission: manage_projects", "fields": [] } }
```

| code | HTTP | when |
|---|---|---|
| `bad_request` | 400 | Malformed JSON or failed validation. `fields` lists the offending paths |
| `unauthenticated` | 401 | No session, or the session expired |
| `forbidden` | 403 | Signed in, but the permission is missing |
| `csrf` | 403 | A mutating request has no `X-Requested-With`, or its `Origin` is not this host |
| `not_found` | 404 | The resource does not exist **or belongs to another org**. Cross-org access is never 403 |
| `conflict` | 409 | Duplicate name, a scan already queued or running for the project, or deleting a built-in role |
| `rate_limited` | 429 | Too many login attempts or scans |
| `internal` | 500 | The message is generic, with no stack, path or secret. Details go to the server log only |

## Auth (dev)

- **Users:** local users. Passwords are hashed with `node:crypto` scrypt. SSO comes later.
- **Session:** `POST /api/auth/login` sets cookie `br_session`. The value is a random 32-byte id, and the server stores only its SHA-256. Attributes: `HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`, plus `Secure` under the `secureCookies` setting (`auto`, the default; `always` or `never` override it). In `auto` mode the cookie is `Secure` when the request URL is https, or it carries `X-Forwarded-Proto: https` from a trusted proxy (see `--trust-proxy` below), or the `Host` is not loopback (`localhost`, `*.localhost`, `127.0.0.1`, `::1`): a non-loopback host is assumed to sit behind TLS. `POST /api/auth/logout` deletes the session and clears the cookie.
- **Sign-in limits:** `POST /api/auth/login` and `POST /api/auth/accept-invite` first count the attempt against the client address (default 50 per 15 minutes); a blocked address gets 429 `rate_limited` at once. Then they count it per account, keyed by the SHA-256 of client address + NUL + normalised email (10 per 15 minutes), so one address cannot lock an account out for everyone else. A successful sign-in resets that key and gives back the address hit.
- **Trusted proxies** (`serve --trust-proxy <ips>`, or `BLASTRADIUS_TRUST_PROXY`, a comma-separated list; default none): the client address is the socket peer, and `X-Forwarded-For` / `X-Forwarded-Proto` are ignored. Only when the peer is one of these addresses is `X-Forwarded-For` read, taking the right-most hop that is not itself a trusted proxy, and is `X-Forwarded-Proto` used for the `Secure` rule. IPv4-mapped IPv6 addresses (`::ffff:10.0.0.1`) are compared as plain IPv4. Without it, every client behind a proxy shares the proxy's address budget.
- **CSRF:** every `POST`, `PUT`, `PATCH` and `DELETE` under `/api/` must send the header `X-Requested-With: blastradius`. Any non-empty value is accepted, and the web client sends `blastradius`. If an `Origin` header is present, it must equal the server's own origin. Otherwise the response is 403 `csrf`. Login is included in this rule.
- **Dev mode** (`blastradius serve --dev`): the server seeds the users `admin@local`, `appsec@local`, `developer@local` and `auditor@local`, each holding the built-in role of the same name at org scope. It prints their passwords to the console once. `POST /api/dev/switch-user` is the role switcher: it moves the session to another seeded user without a password. Outside dev mode it returns 404. Permissions are still enforced server-side from that user's real bindings. Dev mode only binds to a loopback host (`127.0.0.0/8`, `::1`, `localhost`); `serve --dev --host 0.0.0.0` refuses to start.
- **Invites:** `POST /api/members` (manage_members) adds a user to the working org by email and name, with 1–20 initial role bindings. Each binding follows the `POST /api/bindings` rules: you can only grant a role whose permissions you hold, and only an Org admin grants Org admin.
  - **New email, dev mode:** the user is created at once, with the bindings and a generated one-time password returned once as `member` + `oneTimePassword`. The password is never logged or audited.
  - **Every other case (outside dev mode, or an email that already has an account):** nothing is created or granted yet. The server stores a pending invite (email, the name the inviter typed, the bindings) and returns `invite: { token, expiresAt, email, name }`: a single-use token that expires after 7 days; only its SHA-256 is stored. The response is the same whether or not the email has an account, so the endpoint cannot probe accounts in other orgs, reveal their names, or attach them to an org without consent. The web app shows it as a link, `/accept-invite#token=…` (the token stays in the fragment). Inviting the same email again replaces its earlier unaccepted invites; that is how an expired invite is re-sent.
  - **Accepting:** `POST /api/auth/accept-invite { token, password }`. With no account for the email, `password` (12–1024 characters) becomes the new account's password and the account takes the invited name. With an existing account, `password` must be that account's current password (its consent); its password and name are unchanged. Either way the bindings are granted, the token is consumed atomically, and the user is signed in like login (`MeResponse`). An unknown, expired, replaced or used token, or a wrong password for an existing account, gets 400 `bad_request` with a generic message. Attempts count against the sign-in limits above (per address, then per address + email).
  - **Conflict:** an email that is already a member of the org is 409 `conflict`: edit its bindings instead.
  - **Audit:** each step is audited: `user.create`, `binding.create` per binding, `invite.create` (and `invite.revoke` for a replaced invite), `member.invite`, and later `invite.accept`.
  - **Members only:** `POST /api/bindings` for a user subject only accepts users who already have a binding in the org. For anyone else it returns 400 with the same message as an unknown user, so it cannot probe accounts in other orgs. Group subjects are unaffected.
- **Org creation:** `POST /api/orgs` is open to any signed-in user in dev mode, or when no org exists yet (first run). Otherwise only an Org admin of an existing org may create one. The creator gets an org-scope Org admin binding in the new org.

## Permissions

Permissions are data (`permissions.ts`):

- **Pages:** home, projects, reports, integrations, settings, changes, findings, exposure, investigate, scans. A page permission allows seeing the page and reading its API data.
- **Actions:** review, send_to_destinations, build_reports, accept_risk, review_entity_links, manage_projects, manage_integrations, manage_members. Each action is a write.
- **Default templates (PLAN §12):**
  - Org admin: everything, always. Even an edited role list cannot remove a permission.
  - AppSec: every page except settings, and no actions.
  - Developer: every page except settings, and no actions.
  - Auditor: reports only.
  - Customers add actions per role in Settings.
- **Evaluation:**
  - `rolesInScope(bindings, roles, principal, projectId?)` collects the roles from org-scope bindings, plus that project's bindings when a project is in context.
  - `can(roles, permission)` then evaluates the union of those roles.
  - Project-scoped endpoints (anything taking `project=`, `:id` of a project, or a scan or finding of a project) evaluate with that `projectId`.
- **Every handler checks exactly the permission in the table below.**
- **Audit log:** each role, binding, project, scan or finding-status change writes an audit entry.

## Endpoints

"Perm" names the permission required. "auth" means signed in only. "—" means public.

| Method | Path | Perm | Request | Response |
|---|---|---|---|---|
| GET | `/api/health` | — | — | `HealthResponse` |
| POST | `/api/auth/login` | — | `LoginRequest` | `LoginResponse` (sets cookie) |
| POST | `/api/auth/accept-invite` | — | `AcceptInviteRequest` | `AcceptInviteResponse` (sets cookie; see Auth) |
| POST | `/api/auth/logout` | auth | — | `OkResponse` |
| POST | `/api/dev/switch-user` | auth, dev mode | `DevSwitchUserRequest` | `DevSwitchUserResponse` |
| GET | `/api/me` | auth | — | `MeResponse` (`orgs` lists every org the user is bound in, for the org switcher) |
| GET | `/api/orgs` | auth | — | `ListOrgsResponse` (orgs the user is bound in) |
| POST | `/api/orgs` | see Auth | `CreateOrgRequest` | `CreateOrgResponse` 201 (the session switches to the new org) |
| POST | `/api/session/org` | auth, bound in the org | `{ orgId }` | `MeResponse` (switches the session's working org; 404 for an org the user is not in; audited as `session.switch_org`) |
| GET | `/api/home` | home | — | `OrgHomeResponse` |
| GET | `/api/projects?org=` | projects or home | — | `ListProjectsResponse` |
| GET | `/api/me/projects` | auth (any member) | — | `ListMyProjectsResponse` (id and name of each project where the caller holds any permission; the nav and project switcher use it) |
| POST | `/api/projects` | manage_projects | `CreateProjectRequest` | `CreateProjectResponse` 201 |
| GET | `/api/projects/:id` | projects or home | — | `GetProjectResponse` |
| PATCH | `/api/projects/:id` | manage_projects | `UpdateProjectRequest` | `UpdateProjectResponse` |
| DELETE | `/api/projects/:id` | manage_projects | — | `OkResponse` |
| GET | `/api/projects/:id/scans?limit=&cursor=&updatedSince=` | scans | `ListScansQuery` | `ListScansResponse` (adds `serverTime`; see Scan polling) |
| POST | `/api/projects/:id/scans` | manage_projects | `CreateScanRequest` | `CreateScanResponse` 202 |
| GET | `/api/scans/:id` | scans | — | `GetScanResponse` |
| GET | `/api/findings?project=&scan=&level=&status=&q=&sort=` | findings | `ListFindingsQuery` | `ListFindingsResponse` |
| GET | `/api/findings?projects=&env=&level=&status=&owner=&since=&q=&sort=` (no `project`) | findings (org or per project) | `ListOrgFindingsQuery` | `ListOrgFindingsResponse` (see Triage) |
| GET | `/api/findings/packages?…same filters…` | findings (org or per project) | `ListOrgFindingsQuery` | `ListPackageFindingsResponse` |
| GET | `/api/findings/:id` | findings | — | `GetFindingResponse` (adds `projectName`, `introducedBy`, `alerts`, `spread`) |
| PATCH | `/api/findings/:id` | review (and accept_risk into or out of `accepted_risk`) | `UpdateFindingStatusRequest` | `UpdateFindingStatusResponse` |
| POST | `/api/findings/bulk` | review / accept_risk in every finding's project | `BulkUpdateFindingsRequest` | `BulkUpdateFindingsResponse` |
| GET | `/api/assignees` | findings (org or per project) | — | `ListAssigneesResponse` |
| GET | `/api/overview?projects=&env=&range=` | findings (org or per project) | `OverviewQuery` | `OverviewResponse` |
| GET | `/api/exposure?project=&minLevel=&limit=` | exposure | `ExposureQuery` | `ExposureMatrixResponse` |
| GET | `/api/changes?project=&from=&to=` | changes | `ChangesQuery` | `ChangesResponse` |
| GET | `/api/graph?finding=` or `?project=&node=` | investigate (or findings for `finding=`) | — | `GraphResponse` |
| GET | `/api/investigate/search?project=&q=` | investigate | — | `InvestigateSearchResponse` |
| GET | `/api/investigate/node?project=&id=` | investigate | — | `InvestigateNodeResponse` |
| GET | `/api/reports?project=` | reports | — | `ListReportsResponse` |
| GET | `/api/reports/:scanId.html` / `.json` / `.sarif` | reports | — | report body (`ReportDownload`) |
| GET | `/api/integrations` | integrations | — | `ListIntegrationsResponse` (read-only in 4a) |
| GET | `/api/roles` | settings | — | `ListRolesResponse` |
| POST | `/api/roles` | manage_members | `CreateRoleRequest` | `CreateRoleResponse` 201 |
| PATCH | `/api/roles/:id` | manage_members | `UpdateRoleRequest` | `UpdateRoleResponse` |
| POST | `/api/roles/:id/reset` | manage_members | — | `ResetRoleResponse` (built-in only) |
| DELETE | `/api/roles/:id` | manage_members | — | `OkResponse` (409 for built-in, or a role still bound) |
| GET | `/api/bindings?project=` | settings | — | `ListBindingsResponse` |
| POST | `/api/bindings` | manage_members | `CreateBindingRequest` | `CreateBindingResponse` 201 (user subjects must already be members) |
| DELETE | `/api/bindings/:id` | manage_members | — | `OkResponse` (409 if it removes the last Org admin) |
| GET | `/api/members` | settings | — | `ListMembersResponse` |
| POST | `/api/members` | manage_members | `InviteMemberRequest` | `InviteMemberResponse` 201 (see Auth: invites) |
| GET | `/api/audit` | settings | — | `ListAuditResponse` |

**Notes for implementers**

- **Who can call `GET /api/projects`:** a user with no org-level `projects` or `home` permission still gets the projects where a project binding grants one of them. Listings always filter rows to what the caller may see.
- **Scan targets:**
  - A git target must be an `https://` URL on an allow-listed host (github.com, gitlab.com, bitbucket.org) with no credentials, query or fragment. It is cloned shallow with hooks disabled.
  - A local path is accepted only under the server's `--allow-local-root`. It is resolved with symlinks followed, then re-checked against that root.
  - Repository code is never run.
- **Scan jobs:**
  - Scans run in-process through `runScan`, with a concurrency limit (default 2).
  - A second scan request while one is queued or running for the same project returns 409.
  - The stored artefact is the `ScanResult` JSON, and reports are rendered from it on request.
- **Scan polling:** every `Scan` carries `updatedAt`, the latest of `createdAt`, `startedAt` and `finishedAt`. `GET /api/projects/:id/scans` also returns `serverTime`. To poll for new and updated scans without dropping pages already loaded, pass the previous `serverTime` as `?updatedSince=`. The response then holds only scans whose `updatedAt` is at or after it, still newest first and pageable with `cursor`. Merge them into the loaded list by id. A row that changed exactly at `serverTime` can come back twice. A malformed `updatedSince` gets 400.
- **Scan reference date:** scans run as of the current time. `serve --as-of` sets the time for every scan. `serve --dev-seed` replays the recorded fixtures as of 2018-11-27, but only for projects whose local target is inside `test/fixtures`; those scans run offline. Every other project scans with the real current date.
- **Report downloads:** `:scanId` must match `^[A-Za-z0-9_-]+$` and must belong to the caller's org. Responses carry `Content-Disposition: attachment`. HTML reports are served with `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src data:`.
- **Report hash:** `ReportRow.sha256` (the SHA-256 column on the Reports page) is the SHA-256 of the exact bytes of `GET /api/reports/:scanId.json`, the pretty-printed JSON report with its derived fields. It is computed when the scan completes; scans stored before it existed get it on first listing. It is not the hash of the stored compact `ScanResult` (that stays internal as `result_sha256`). To verify a download:
  ```sh
  curl -fsS -b "br_session=$SESSION" -o blastradius-$SCAN.json "$BASE/api/reports/$SCAN.json"   # or the Download > JSON menu
  sha256sum blastradius-$SCAN.json    # prints the value shown on the Reports page
  ```
  Hash the file as saved, without re-formatting it (`jq` or a re-serialisation changes the bytes).
- **Changes:** the diff compares the findings of two succeeded scans of one project by purl. Change types: new_finding, resolved, risk_up, risk_down, new_reason. Reviewing a change is deferred, so act on the finding instead.
- **Graphs:** always scoped to a finding or a node. Nodes are capped at the project tier's `graphNodeCap`, and anything over the cap collapses into `group` nodes with `truncated: true`.
- **Deferred in 4a:** send_to_destinations, build_reports (custom report builder and signing), review_entity_links and manage_integrations. They exist in the catalogue and in role editing, but no endpoint uses them yet.

## Triage (findings across projects)

- **Statuses:** `new` (shown as Open) → `reviewed` (Triaged) → `fixing` → `resolved`, plus `accepted_risk`.
  "Open" in counts and tiles means `new`, `reviewed` or `fixing`. Status and owner are stored per
  (project, package version), so they carry over to later scans (migration 6 added `fixing`,
  `resolved`, `owner_id` and `risk_expires_at`).
- **Org-wide list:** `GET /api/findings` without `project` reads the newest succeeded scan of every
  project where the caller holds `findings` (org scope, or per project). `projects=` narrows it;
  ids the caller cannot see are ignored, never an error. Every filter is a comma-separated list:
  values within one filter are OR, filters are AND. `env=prod` keeps findings that reach a
  production asset, `env=dev` the rest. `owner=` takes member ids or `none`. `since=` is an ISO
  time compared with first seen. Sorts: `-score` (default: worst level, then score), `score`,
  `name`, `reach`, `-firstSeen`, `firstSeen`. Rows add `projectName`, `introducedBy` (direct, and
  the direct dependencies that pull it in, from the dependency paths) and `spread` (how many of the
  listed projects have this same package version, and how many reach production).
- **By package:** `GET /api/findings/packages` takes the same filters and returns one row per
  package version with every matching finding (production first). Paging counts packages.
- **Owner:** `PATCH /api/findings/:id { ownerId }` assigns a member (anyone with a user binding in
  the org) or unassigns with `null`; it needs `review` in the finding's project and is audited as
  `finding.owner`. `GET /api/assignees` lists the members a finding can be assigned to.
- **Accepted risk:** `expiresAt` (a future date) is kept as `riskExpiresAt` while the status is
  `accepted_risk`. `POST /api/findings/bulk` requires both `note` (the reason) and `expiresAt`;
  the single `PATCH` keeps them optional for older clients. The history note reads
  "<reason> (until <date>)".
- **Bulk:** `POST /api/findings/bulk { ids (1–500), status?, note?, expiresAt?, ownerId? }` is all or
  nothing. Every id must be in the caller's org (else 404, checked first), and the caller needs the
  permission in each finding's project (else 403 and nothing changes): `accept_risk` when moving
  into or out of `accepted_risk`, otherwise `review`.
- **Overview:** `GET /api/overview` reads the same latest scans. `attention` counts open critical
  findings (and how many reach production), open high findings with no owner (and the oldest
  first-seen time), open findings first seen in the last 7 days (and in how many projects), and
  "sources to check": projects whose newest scan failed (with the error) or that never had a
  successful scan. `bySeverity` gives open findings per level and how many were first seen inside
  `range` (`null` for `all`): earlier per-day counts are not stored, so no line is drawn.
  `topPackages` lists the open packages found in the most projects. `incident` is the newest
  alert inside the range (with its project and production counts), for the banner.

## Web routes

Served by the same server. Unknown non-`/api` paths return `index.html` (SPA). Each route needs its page permission (`WEB_ROUTES` in `permissions.ts`).

| Route | Page permission | Screen |
|---|---|---|
| `/login` | none | Sign in, plus the dev user switcher hint |
| `/accept-invite` | none | Accept a member invite (token from the link's `#token=` fragment, or pasted) and sign in |
| `/` | home | Overview: incident banner, "Needs attention" tiles, open findings by severity, packages in the most projects |
| `/findings` | findings | Findings across every project the user can see (one table, by package or by project) |
| `/projects/:id/changes` | changes | Changes between the last two scans |
| `/projects/:id/findings` | findings | The Findings list scoped to one project, plus its Maintenance view |
| `/projects/:id/findings/:fid` | findings | Finding detail: status track, stacked sections (reach, what to do, who's behind it, evidence, timeline) and a rail of editable fields |
| `/projects/:id/exposure` | exposure | Exposure matrix (assets × components) |
| `/projects/:id/investigate` | investigate | Search, then a scoped graph |
| `/projects/:id/scans` | scans | Scan list, plus "Run scan" when the user has manage_projects |
| `/reports` | reports | Report list and downloads |
| `/integrations` | integrations | Integration status (read-only) |
| `/settings` | settings | Project tier, roles matrix and bindings. Editing needs manage_projects or manage_members |

**Routing rules:**

- **Navigation:** the nav shows only the pages in `MeResponse.permissions`, plus any per-project `projectPermissions`.
- **Landing page:** if the user lacks `home`, `/` redirects to the first allowed route. For example, an Auditor lands on `/reports`.
- **No session:** any route redirects to `/login`.
- **Forbidden routes:** a route the user is not allowed to see renders a 403 state. The server-side API check is what actually protects the data.


## Org-wide incident mode

Answered from the stored inventory of each project's newest succeeded scan; nothing is re-scanned.

| Route | Permission | What |
|---|---|---|
| `GET /api/search/exposure?q=name[@version]` | `exposure` (org or per project) | "Is X anywhere?": every visible project that contains the package, with production/dev and reach in words |
| `GET /api/alerts?limit=` | `findings` or `exposure` | Alerts, newest first |
| `POST /api/alerts/check` `{ advisories?: OSV[] }` | `manage_projects` or `manage_alert_rules` | Match advisories (OSV records), or the knowledge pack (`BLASTRADIUS_PACK`) when none are given, against all projects. Each (project, component, advisory) becomes an alert once. Returns the new alerts and the time taken. |

**Automatic alerts.** With `BLASTRADIUS_PACK` set, the server re-checks every org's latest inventories against the pack on start and every `BLASTRADIUS_WATCH_MINUTES` (default 60). When the pack file changes on disk it is reloaded. Each finished scan is checked straight away. New alerts are posted once to `BLASTRADIUS_ALERT_WEBHOOK` as Slack-compatible JSON (`{ "text": … }`). The URL must be https, or http to localhost; credentials in the URL are refused. `BLASTRADIUS_PUBLIC_URL`, if set, adds an "Open Blastradius" link. A failed post is logged, and the alert stays in `GET /api/alerts`.

**Pack polling.** With `BLASTRADIUS_PACK_LISTING_URL` (a feeds `listing.json`, https or http to localhost) and `BLASTRADIUS_PACK` set, the server reads the listing every `BLASTRADIUS_PACK_POLL_MINUTES` (default 30) with `If-None-Match`, downloads only a newer pack, checks its SHA-256 against the listing and that it loads, renames it over `BLASTRADIUS_PACK`, and re-checks every org at once. A pack that fails a check is refused and the working one stays.

**Incidents, package reach and alert rules** (types in `src/server/api-types-incidents.ts`). An incident is one advisory with at least one alert; its id is the advisory id. An advisory's own rating (`database_specific.severity`), summary and first fixed version are kept on each alert; knowledge-pack entries are Critical.

| Route | Permission | What |
|---|---|---|
| `GET /api/incidents` | `findings` or `exposure` | Incidents the caller can see: affected, production and fixed counts, status, open first |
| `GET /api/incidents/:id` | `findings` or `exposure` | Where it is (production first, brought in by, owner, finding), the last org-wide check, a typed timeline (alert, check, status, notified) and which actions are available, with the reason when not |
| `PATCH /api/incidents/:id` `{ status }` | `review` (org) | Investigating › Fixing › Monitoring › Closed; recorded on the timeline and in the audit log |
| `POST /api/incidents/:id/notify` | `send_to_destinations` or `manage_alert_rules` | Posts the affected projects and their owners to the Slack webhook (400 when none is configured or no project has an owner) |
| `GET /api/packages/reach?name=&version=` | `exposure` | Projects, Sankey flows (package → brought in by → project → environment) and dependency paths with edge scopes; lifecycle phases the stored data knows |
| `GET /api/packages/behind?name=` | `exposure` | Documented links (maintainers, repo owner, orgs, funders) merged from the newest findings, with confidence, method, review state and sources |
| `GET /api/alert-rules` | `findings` or `exposure` | Team rules with "would have sent N in the last 30 days", whether the default rule applies, and whether a webhook is configured |
| `POST /api/alert-rules`, `PATCH`/`DELETE /api/alert-rules/:id` | `manage_alert_rules` | WHEN severity ≥ `minLevel` [and it reaches production] THEN post to the webhook naming `channel` |
| `POST /api/alert-rules/preview` `{ minLevel, productionOnly? }` | `findings` or `exposure` | How many of the last 30 days' alerts a rule would have sent |
| `POST /api/alert-rules/test` `{ channel }` | `manage_alert_rules` | One test message through the webhook (400 without one) |

With no stored rule every new alert is posted (the default rule). Once rules exist, each enabled rule posts the alerts it matches, with `channel` in the payload; an alert whose severity is unknown matches every rule. Each accepted post is recorded on the incidents' timelines. Email to owners needs an email sender, which does not exist yet, so the option is shown but off.

## Accounts: who can publish what you depend on

From the account-level proof ([ACCOUNT-PROOF.md](ACCOUNT-PROOF.md)): the account index and "account X is compromised" earned their place; the burst rule did not, so there is no burst alert. Types in `src/server/api-types-accounts.ts`. Reads follow the caller's visible projects, like incidents.

**The index.** For every npm package in any project's latest inventory the server keeps the registry's packument, compacted (`registry_package`): current `maintainers`, the repository owner, and every version's publish time, `_npmUser` and `maintainers` (deleted versions keep their time). From it, `account_link` records who can publish what, each link with its source and confidence: `maintainer` (packument maintainers, high), `listed` (the account's own `/-/user/<name>/package` listing, high), `repo_owner` (GitHub/GitLab owner of the declared repository, medium: can change the code, not npm publish rights). Who published a project's exact locked version is read per org from the stored versions, never stored per org. Packuments are fetched after every successful scan (the way the scan fetched: a fixture replay stays offline) and every `BLASTRADIUS_ACCOUNT_REFRESH_MINUTES` (default 360; 0 disables), at most once a day per package, through the shared HTTP client (per-host rate limits, disk cache, retries, offline fixtures). An account's own listing is fetched when its page is opened or it is marked compromised (once a day; npm answers it with 429s often, so it is never swept). Anything that could not be fetched is recorded with the reason and counted as "no data", never guessed; a failed refresh keeps the last good copy.

| Route | Permission | What |
|---|---|---|
| `GET /api/accounts/:registry/:name` | `findings` or `exposure` | The Account page: packages it can publish now (with every link's source and confidence, projects using each, production), its share of the org's production dependencies, its latest 25 publishes the index knows (context only) with distinct packages published in the last day, week and 30 days, how complete the registry data is, and the incident if it was marked compromised. `registry`: `npm`, or `github`/`gitlab` for repository owners. |
| `GET /api/accounts/:registry/:name/exposure?since=&asOf=&projects=` | `findings` or `exposure` | "Account compromised": every exposed project × package version, production first, with who brings it in, the project owner, the links that make it exposed, who published the locked version (`npmUser`, or `sole-maintainer` for a deleted version whose previous version had one maintainer) and the project's finding. Reasons: `can_publish` (the account can publish the package; with `asOf`, from the maintainers of the latest version published at or before `asOf`) and `published_since` (the account published this exact version within [`since`, `asOf`]). Also every package it can publish and the versions it published since `since`. ISO date-times; 400 otherwise. |
| `POST /api/accounts/:registry/:name/compromise` `{ since? }` | `review` (org) | Fetches the account's listing, then opens or updates incident `ACCOUNT-<registry>-<name>` with one alert per exposed project × version (Critical when the account published that version since `since`, else High), an `account` event on its timeline and an audit entry. 201 when opened, 200 when updated (`added` = new exposures); `incidentId: null` and no incident when nothing is exposed. New alerts go through the alert rules and webhook like any other. |
| `GET /api/accounts/concentration?projects=&limit=` | `findings` or `exposure` | Per project and org-wide: the npm accounts that can publish the largest share of production dependencies (distinct name@version reached from a production asset through runtime dependencies), from current packument maintainers. Shares are of the packages with registry data; the counts of those with none are returned too. |

`GET /api/incidents` and `/api/incidents/:id` carry `account: { registry, name, since }` for an account incident; its timeline has `account` events. Web routes: `/accounts/:registry/:name` (page `exposure`), reached from Who's behind it (every account and repository owner), from an account incident, and from the concentration section on `/exposure`.

**Gate (G1).** `test/replay/account/product-parity.test.ts` feeds the recorded chalk/debug data through this index and API offline: at the debug advisory time (2025-09-08T14:26:51Z) `GET .../npm/qix/exposure?asOf=` names 204 exposures in the two recorded orgs where the advisories then named 21, precision 1.0, the same (project, version) set as the proof and all 21 locked bad versions. It names all 19 bad packages when qix's listing is the one reconstructed for that time from recorded maintainers; with today's recorded listing it names 18 (chalk-template changed owner after the incident).
