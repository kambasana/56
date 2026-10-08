# Repo connectors: connect once, watch automatically

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
