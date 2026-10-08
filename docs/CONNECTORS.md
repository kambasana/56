# Repo connectors: connect once, watch automatically

**Status (2026-10-08).** Step 1 of §5 is built on the server side: the GitHub App connector, with
the API and webhook on branch `connectors/github`. The screens and the proof against a registered
App are still to do. §6 says what works today, what has been proved, and how to register the App.

**Decision (2026-10-08).** Users connect a code host once, pick an org or group and its repos, and Blastradius watches them from then on. Today each project is a git URL or path typed by hand. Connecting replaces that and keeps it as a fallback. This is the established pattern used by Dependabot, Renovate, Snyk and Socket; we reuse it rather than invent one.

Design: [Blastradius repo connectors](https://claude.ai/artifact/FovYACwCpEHLLv2y4EKkPV), 4 screens built with the Claude Design System (shadcn new-york-v4 at 28px density, the same base as the web app):

1. **Sources.** Connected hosts with their health, then a table of watched repos (lockfiles, last scan, status).
2. **Connect GitLab.** Instance URL, OAuth or group token, and what is requested, read and never done.
3. **Choose repos.** After the GitHub App install: "all repos, and new ones automatically" or a selection, with each repo's lockfiles shown before any scan.
4. **A watched repo.** Exposure, webhook health, granted access, the exact files read, and activity.

## 1. Per host

| Host | Connector | Access requested | Change events | Library to reuse |
|---|---|---|---|---|
| **GitHub** (cloud and GHES) | **GitHub App**: Install → pick org → all or selected repos | Repository *Contents: read*, *Metadata: read*. Nothing else. | `push`, `installation`, `installation_repositories` (new repos are added automatically) | Octokit (`@octokit/app`, `@octokit/webhooks`) |
| **GitLab** (gitlab.com and self-hosted) | **OAuth 2** app, or a **group access token** where no OAuth app exists | `read_api`, `read_repository` | group (or project) webhook, `push` | gitbeaker (`@gitbeaker/rest`) |
| **Forgejo / Gitea** | **OAuth 2**, or a personal or org token | read repository | org or repo webhook, `push` | Gitea-compatible REST API (both expose it) |
| **Any git host** | git URL plus an optional token | clone read | polling (today's behaviour) | existing `ingest/git.ts` |

One interface, one adapter per host (the shape Renovate uses): `listRepos(scope)`, `defaultBranch(repo)`, `readFiles(repo, ref, paths)`, `findLockfiles(repo, ref)`, `verifyWebhook(req)`, `parsePush(event) → changed paths`.

## 2. What happens after connecting

1. **Discover.** List the repos and find manifests and lockfiles through the host's tree API. Show them before scanning (screen 3).
2. **Fetch only what is needed.** `package.json`, lockfiles (all workspace roots) and `.github/workflows/*` at the default branch, through the API. No full clone, so it is faster and nothing else is copied.
3. **Store the inventory**, then everything already built takes over: known-bad matching, reach in words, who's behind it, org alerts and Slack.
4. **Re-scan on push** only when the push touched a manifest, lockfile or workflow path. Other pushes are skipped.
5. **No re-scan for new advisories.** The hourly feed (FEEDS-AND-DETECTORS.md) re-checks every stored inventory.
6. **Install events.** A repo added to the installation is discovered and scanned; a removed one stops being watched, and its history is kept.

## 3. Security rules

- **Read-only scopes** only. A connector that cannot get read-only access is not offered.
- **Tokens** are encrypted at rest (envelope encryption, with the key outside the database), never logged and never returned by the API. Installation tokens are short-lived and minted per use. GitHub App private keys and webhook secrets come from the environment.
- **Webhooks:** every delivery is checked against its signature (`X-Hub-Signature-256`, the GitLab token header, the Gitea HMAC) and deduplicated by delivery id. Unsigned or unknown deliveries are dropped and counted.
- **Never execute.** The files are parsed as data, as today.
- **RBAC.** Only roles with `manage_projects` connect hosts and pick repos. Every connect, disconnect and repo change is audited.
- **Health shown, not hidden:** a revoked install, an expired token or a failing webhook marks the source (screen 1) and its repos ("Access lost"). It never shows as silently empty.

## 4. Proof before each host ships

Per host, in the hammer, against real repos:

1. **Same results as a clone.** Connect, discover and scan give the same inventory as today's clone scan of the same commit.
2. **Push re-scans:** a push that changes a lockfile re-scans that repo within 2 minutes; other pushes don't trigger a scan.
3. **New repo:** a repo added to the installation appears and is scanned automatically.
4. **Access lost:** revoking access marks the source as unhealthy. Nothing is deleted.
5. **Webhook security:** a forged webhook (bad signature) is rejected.

## 5. Order

1. **GitHub App** (largest share; cleanest permissions). Server routes `/api/sources`, webhook endpoint `/api/hooks/github`, the Sources UI (screens 1, 3, 4).
2. **GitLab**, OAuth and group token (screen 2).
3. **Forgejo / Gitea.**
4. **Plain git URL** moved under Sources as the fallback.

## 6. GitHub App: status and registration

### Built (server and API; no UI yet)

| Piece | Where |
|---|---|
| `SourceAdapter` interface (host-neutral) | `blastradius/src/server/sources/types.ts` |
| GitHub App adapter on Octokit (`@octokit/app` 16.1.4, `@octokit/core` 7.0.8, `@octokit/webhooks` 14.2.0; exact pins, all MIT) | `sources/github.ts` |
| File selection shared by the directory walk and the tree API | `blastradius/src/ingest/select.ts` |
| Fetch-only checkout: only the inventory files, at one commit, in a temp dir | `sources/materialise.ts` |
| Install, discovery into projects, scans, webhooks, health | `sources/service.ts` |
| Tables `source`, `source_repo`, `webhook_delivery` (migration 6) | `store/sources.ts` |
| Routes `/api/sources…` and `/api/hooks/github` (contract in docs/WEB-API.md, "Sources") | `routes/sources.ts` |

- **Tokens.** No GitHub token is stored. Each operation (listing, discovery, one scan) builds a fresh App client, mints an installation token and revokes it at the end. The App's private key, webhook secret and OAuth client come from the environment only.
- **Install proof.**
  - The install `state` is signed and single use, and expires after 30 minutes.
  - The callback also needs GitHub's OAuth `code`, and the GitHub user it belongs to must see the installation (`GET /user/installations`). An `installation_id` forged into the setup URL therefore connects nothing.
  - An installation already connected to one org cannot be claimed by another.
- **Repos become projects** (`owner/repo`), so findings, alerts, exposure, blast radius and reports work unchanged. Removing a repo, losing access or disconnecting keeps the project and its history.
- **Push filter.** A push re-scans only if it is on the default branch and touches `package.json`, `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `.github/workflows/*.yml`, a Dockerfile or `.blastradius.yml`. The rules are the same as the ones ingest uses. A push with more than 20 commits or a forced push counts as touching.
- **Not yet built:**
  - The UI screens.
  - A periodic health probe. Health is updated on webhook events, on every discovery and scan, and on `POST /api/sources/:id/check`.
  - GitHub Enterprise Server. It is configurable (`BLASTRADIUS_GITHUB_API_URL` / `_WEB_URL`) but untested, and its project targets are not on the git host allow-list (fetch-only scans do not need it).
  - Symlinked manifests. The tree API's symlinks are not read. A hook-free clone would turn them into small text files that fail to parse.

### Proved

1. **Same results as a clone** (§4.1), against `mochajs/mocha@a9fc5296831641fbbcc8862e561e498549d840dc`:
   - Live run, `npx tsx test/sources/equivalence.ts` in `blastradius/`. A hook-free fetch of that commit, checked out and ingested, was compared with the fetch-only path. The fetch-only path listed the tree and read only the 29 inventory files of 692 (735 KB) from `raw.githubusercontent.com`.
   - The result is identical: 26 assets, 1,185 components and 2,520 edges, the same warnings, and inventory SHA-256 `f58af6ec…a649a`.
   - In this sandbox the tree listing came from `git ls-tree` of a blob-less fetch, because `api.github.com` was not reachable for that repository. Where the API is reachable, the script uses the tree API.
   - `--record` stored the tree, in the API's shape, and the 29 files. Their blob ids are checked against the tree. `test/sources/equivalence.test.ts` replays them offline through the real `GitHubAdapter` against a fake GitHub and gets the same hash.
2. **Push re-scans and skips** (§4.2), **new repo** (§4.3), **access lost** (§4.4) and **forged webhook** (§4.5) are covered by `src/server/sources.test.ts`. It runs against a fake GitHub that verifies the App JWT with a throwaway RSA key. It also checks replayed deliveries, RBAC, cross-org claims and token revocation.
3. **Still to prove:** the same five checks in the hammer against a real installation. That needs the App registered (below).

### Register the GitHub App (one time, about 10 minutes)

`PUBLIC_URL` below is where Blastradius is served over https, for example `https://<vm>.exe.xyz`. GitHub must be able to reach it.

1. Open GitHub → your organisation → **Settings → Developer settings → GitHub Apps → New GitHub App**. Use your user settings instead for a personal account.
2. **GitHub App name:** for example `Blastradius (acme)`. **Homepage URL:** `PUBLIC_URL`.
3. **Identifying and authorizing users:**
   - **Callback URL:** `PUBLIC_URL/api/sources/github/callback`
   - Tick **Request user authorization (OAuth) during installation**. This is required: the server uses the code to prove the installer can see the installation. GitHub then sends the browser back to the callback URL with `installation_id`, `setup_action`, `state` and `code`. The Setup URL field is disabled, which is expected.
   - Leave **Enable Device Flow** off. **Expire user authorization tokens** can stay on: the server revokes the token right after the check anyway.
4. **Post installation:** tick **Redirect on update**. Changing the repo selection on GitHub then lands on the Sources page (`install=updated`); the webhook carries the change itself.
5. **Webhook:**
   - Tick **Active**.
   - **Webhook URL:** `PUBLIC_URL/api/hooks/github`
   - **Webhook secret:** generate one with `openssl rand -hex 32` and keep it for step 9.
   - Keep SSL verification on.
6. **Permissions.** Repository permissions: **Contents: Read-only** and **Metadata: Read-only** (Metadata is mandatory). Leave everything else at **No access**, with no organisation or account permissions.
7. **Subscribe to events:** tick **Push**. `installation` and `installation_repositories` events are always sent to Apps, so there is nothing to tick for them.
8. **Where can this GitHub App be installed:** **Only on this account** for your own org, or **Any account** if other orgs will connect. Then click **Create GitHub App**.
9. On the App's page, collect the credentials:
   - Note the **App ID** and the **Client ID**.
   - Click **Generate a new client secret** and copy it.
   - Click **Generate a private key**: a `.pem` file downloads. Store it on the server with `chmod 600`, for example at `/etc/blastradius/github-app.pem`.
10. Set the environment for `blastradius serve` (systemd `Environment=` or an env file). Never commit these values:
    ```sh
    BLASTRADIUS_GITHUB_APP_ID=123456
    BLASTRADIUS_GITHUB_PRIVATE_KEY_FILE=/etc/blastradius/github-app.pem   # or BLASTRADIUS_GITHUB_PRIVATE_KEY with the PEM
    BLASTRADIUS_GITHUB_WEBHOOK_SECRET=<from step 5>
    BLASTRADIUS_GITHUB_CLIENT_ID=<from step 9>
    BLASTRADIUS_GITHUB_CLIENT_SECRET=<from step 9>
    ```
    Restart. The log says `sources: GitHub App connector configured`. A partial setup stops the server and names the missing variables.
11. Connect. The Sources screen is not built yet, so use the API:
    - As an Org admin, call `POST /api/sources {"host":"github"}`.
    - Open the returned `installUrl` within 30 minutes, pick the org and the repos, then install.
    - GitHub returns to the callback, and the repos appear in `GET /api/sources/:id/repos`. Each repo with a lockfile becomes a project and is scanned.
12. Check webhooks: the App's **Advanced** tab lists each delivery and its response. A `ping` answers 202 with `{"outcome":"pong"}`, and a forged delivery answers 401.
