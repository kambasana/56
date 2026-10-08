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
- **Audit log:** each role, binding, project, scan, finding-status, source and source-repo change writes an audit entry.

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
| GET | `/api/findings/:id` | findings | — | `GetFindingResponse` |
| PATCH | `/api/findings/:id` | review (and accept_risk for `accepted_risk`) | `UpdateFindingStatusRequest` | `UpdateFindingStatusResponse` |
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

## Web routes

Served by the same server. Unknown non-`/api` paths return `index.html` (SPA). Each route needs its page permission (`WEB_ROUTES` in `permissions.ts`).

| Route | Page permission | Screen |
|---|---|---|
| `/login` | none | Sign in, plus the dev user switcher hint |
| `/accept-invite` | none | Accept a member invite (token from the link's `#token=` fragment, or pasted) and sign in |
| `/` | home | Org home: totals and the project table |
| `/projects/:id/changes` | changes | Changes between the last two scans |
| `/projects/:id/findings` | findings | Findings table with a side panel |
| `/projects/:id/findings/:fid` | findings | Finding detail: reasons, evidence, paths, entity chain |
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
| `POST /api/alerts/check` `{ advisories?: OSV[] }` | `manage_projects` | Match advisories (OSV records), or the knowledge pack (`BLASTRADIUS_PACK`) when none are given, against all projects. Each (project, component, advisory) becomes an alert once. Returns the new alerts and the time taken. |

**Automatic alerts.** With `BLASTRADIUS_PACK` set, the server re-checks every org's latest inventories against the pack on start and every `BLASTRADIUS_WATCH_MINUTES` (default 60). When the pack file changes on disk it is reloaded. Each finished scan is checked straight away. New alerts are posted once to `BLASTRADIUS_ALERT_WEBHOOK` as Slack-compatible JSON (`{ "text": … }`). The URL must be https, or http to localhost; credentials in the URL are refused. `BLASTRADIUS_PUBLIC_URL`, if set, adds an "Open Blastradius" link. A failed post is logged, and the alert stays in `GET /api/alerts`.

## Sources (repo connectors)

Connect a code host once and its repos are watched from then on (docs/CONNECTORS.md). GitHub App
first. Types: `Source`, `SourceRepo` and friends in `api-types.ts`. Every route below except the
callback and the webhook needs **`manage_projects`** at org scope; another org's source is 404.

| Method | Path | Perm | Request | Response |
|---|---|---|---|---|
| GET | `/api/sources` | manage_projects | — | `ListSourcesResponse` (`configured.github`, sources with health and repo counts, `webhooks.rejected`) |
| POST | `/api/sources` | manage_projects | `StartSourceInstallRequest` `{ host: "github", autoWatch? }` | `StartSourceInstallResponse` 201: `installUrl` (GitHub's install page with a signed, single-use `state`, valid 30 min) and the pending source. 400 when the App is not configured |
| GET | `/api/sources/github/callback?installation_id=&setup_action=&state=&code=` | — (see below) | — | 302 to `/sources?install=connected&source=…`, `install=failed&reason=…`, `install=updated` or `install=requested` |
| GET | `/api/sources/:id` | manage_projects | — | `GetSourceResponse` |
| PATCH | `/api/sources/:id` | manage_projects | `UpdateSourceRequest` `{ autoWatch }` | `GetSourceResponse` |
| DELETE | `/api/sources/:id` | manage_projects | — | `OkResponse`. Disconnects: status `disconnected`, repos `not_watched`; projects and history stay. Revoke on GitHub by uninstalling the App |
| POST | `/api/sources/:id/check` | manage_projects | — | `GetSourceResponse`. Asks GitHub now: restores a source whose access came back (and rediscovers), or marks it `access_lost` |
| GET | `/api/sources/:id/repos` | manage_projects | — | `ListSourceReposResponse`: each repo's status, lockfiles, the exact files read, linked `projectId`, last commit, delivery and scan |
| PATCH | `/api/sources/:id/repos/:repoId` | manage_projects | `UpdateSourceRepoRequest` `{ watching }` | `UpdateSourceRepoResponse`. Turning watching on re-reads the tree and scans; 400 for a removed or unreadable repo |
| POST | `/api/hooks/github` | signature | GitHub delivery | `WebhookAcceptedResponse` 202 (`outcome`), 200 `{ duplicate: true }` for a delivery id already seen, 401 for a missing or bad signature |

**Notes for implementers**

- **Install.** `POST /api/sources` stores a pending source with the SHA-256 of a random state secret.
  GitHub sends the browser back to the callback after the install. The session cookie is
  `SameSite=Strict`, so this cross-site redirect carries no session. The callback is trusted
  through three checks instead:
  - The state carries an HMAC whose key is derived from the webhook secret. It is single use and unexpired.
  - Its creator still holds `manage_projects`.
  - GitHub's OAuth `code` belongs to a GitHub user who can see `installation_id`. The server checks this through `GET /user/installations`, then revokes that user token.

  The `installation_id` in the setup URL can be forged, and these checks make that useless. An installation already connected to another org is refused (409 inside the redirect reason).
- **Repos become projects.** Discovery lists the installation's repos and reads each tree at its default branch. A repo with a manifest, lockfile or workflow becomes a project named `owner/repo`, with target `https://github.com/owner/repo`, tier Standard and owner `GitHub · <account>`, and a scan is queued. Findings, alerts, exposure, blast radius and reports then work unchanged. With `autoWatch: false` every repo is still listed with its lockfiles and files to read (status `not_watched`), and nothing is scanned until `PATCH …/repos/:repoId { watching: true }`. Statuses: `discovering`, `watching`, `scanning`, `no_lockfile` (nothing to scan, no project), `unsupported` (only yarn.lock / pnpm-lock.yaml: package.json pins and workflows are still scanned; or a tree too large for the API: not scanned), `access_lost`, `removed`, `not_watched`.
- **Fetch-only scans.** A project linked to a repo is never cloned. The scan lists the tree at the ref and fetches only `package.json`, `package-lock.json` / `npm-shrinkwrap.json` (every workspace root), `.github/workflows/*`, Dockerfiles and `.blastradius.yml` at that commit, through the API. These are written to a temp dir and the usual ingest runs on them, so the inventory is the same as a clone of that commit. `POST /api/projects/:id/scans` (with optional `ref`) works the same way for linked projects; `offline` is refused for them.
- **Webhook.**
  - The server computes an HMAC-SHA256 of the raw body and compares it with `X-Hub-Signature-256` in constant time. Unsigned or badly signed deliveries are dropped and counted (`webhooks.rejected`), and never stored.
  - Signed deliveries are deduplicated by `X-GitHub-Delivery`; records are kept 30 days.
  - `installation` events: `deleted` or `suspend` mark the source and its repos `access_lost`. `unsuspend`, `created` and `new_permissions_accepted` re-check the source.
  - `installation_repositories` adds repos (discovered and scanned when the source auto-watches) and removes them (`removed`; the project and its history stay).
  - `push` re-scans only for the default branch, and only when the commits touch an inventory file. GitHub lists at most 20 commits, so a push with more commits than that, or a forced push, counts as touching. Other pushes are recorded as `skipped_*`. A push during a running scan queues one more scan after it.
- **Health.** If GitHub refuses an installation token (revoked or suspended install, 401), the source becomes `access_lost` with a reason in `health`, and its repos become `access_lost` too. A 404 for a single repo marks only that repo. Scans fail with a safe message. Nothing is deleted.
- **Secrets.** These come from the environment: `BLASTRADIUS_GITHUB_APP_ID`, `BLASTRADIUS_GITHUB_PRIVATE_KEY` or `_PRIVATE_KEY_FILE`, `BLASTRADIUS_GITHUB_WEBHOOK_SECRET` (at least 16 characters), `BLASTRADIUS_GITHUB_CLIENT_ID` and `BLASTRADIUS_GITHUB_CLIENT_SECRET`. GitHub Enterprise Server adds `BLASTRADIUS_GITHUB_API_URL` and `BLASTRADIUS_GITHUB_WEB_URL`.
  - A partial configuration stops `serve` with an error that names the missing variables, never their values.
  - No GitHub token is stored. Each operation mints an installation token (one hour at most) and revokes it when done.
  - Audit actions: `source.install_start`, `source.connect`, `source.update`, `source.disconnect`, `source.access_lost`, `source.access_restored`, `source_repo.add`, `source_repo.remove`, `source_repo.rename`, `source_repo.watch`, `source_repo.unwatch` and `source_repo.access_lost`. Changes made on GitHub's behalf use the actor `github-app`.
