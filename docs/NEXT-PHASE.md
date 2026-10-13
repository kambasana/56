# Next phase: Blastradius web app (Phase 4a, "see it working")

**Goal:** a running web app that shows real scan results in the table-first UI from the design canvas: Org home → Project → Changes, Findings, Exposure, Investigate, Reports, Integrations, Settings. It uses the CLI engine as it stands (Phase 0–2 work, 268 tests). Phase 4 items not needed for that first working slice stay deferred.

**Exit criteria**
1. `blastradius serve` starts the app at `http://localhost:8000`.
2. You can create an org and a project, point the project at a repo, run a scan, and open the findings in the browser.
3. Every main screen renders real data from at least one scan: the e2e fixture offline, plus one live public repo.
4. RBAC templates from PLAN §12 are enforced server-side, with a role switcher in dev mode.
5. Playwright tests cover every page, and CI runs them headless.
6. A one-command deploy to exe.dev works through `.claude/skills/deploy-exe-dev`.

## Architecture (kept small)

| Layer | Choice | Why |
|---|---|---|
| Server | Node 22 + Hono, inside the existing `blastradius` package (`src/server/`) | One language and one install. It reuses the pipeline directly |
| Store | SQLite through `node:sqlite` (built in, no native build) | Zero setup. Postgres is a later swap behind a repository interface |
| Jobs | An in-process queue running scans with a concurrency limit | Good enough for a single VM. Redis comes later |
| Web | Vite + React + TypeScript + Tailwind, localflare tokens, shadcn components | Matches the design canvas |
| Tables | TanStack Table (virtualised) | Information-dense and handles thousands of rows |
| Graph | Cytoscape.js, opened only for one finding or entity | PLAN §12: never estate-wide by default |
| Auth (dev) | Local users and a session cookie. SSO comes later | RBAC needs identities from day one |

**API (REST, JSON):**
- `/api/orgs`, `/api/projects`, `/api/projects/:id/scans` (POST runs a scan)
- `/api/scans/:id`, `/api/findings?project=&level=&q=`, `/api/findings/:id` (reasons, evidence, paths)
- `/api/exposure` (components × projects), `/api/changes` (diff between scans)
- `/api/reports/:scan.{html,json,sarif}`
- `/api/roles`, `/api/me`

Every handler checks a page or action permission.

**Safety (unchanged from the CLI):**
- Scans never execute repository code.
- Git URLs are cloned shallow into a temporary directory, never with hooks.
- All HTML is escaped.
- Only the configured org's projects can be scanned.

## Work breakdown (workflow)

The work runs as a multi-agent workflow (Workflow tool), one agent per track, with verification after each stage:

| # | Track | Output | Depends on |
|---|---|---|---|
| A | Store + domain | SQLite schema (org, project, scan, finding, role, binding, audit_log); repository layer; migration tests | — |
| B | Server + API | Hono app, scan job runner over `runScan`, the endpoints above, RBAC middleware, API tests | A |
| C | Web shell | Vite app, localflare tokens, Nav filtered by `/api/me` permissions, router, layout | — |
| D | Screens 1 | Org home, Findings (table + side panel), Changes | B, C |
| E | Screens 2 | Exposure matrix, Investigate (scoped Cytoscape graph), Reports, Integrations (read-only for now), Settings (roles matrix) | B, C |
| F | Verify | Playwright e2e per page against the fixture scan, screenshots, CI job `web e2e`, `serve` docs | D, E |
| G | Review | Adversarial review of the diff (security: SSRF in git URLs, path traversal, XSS, authz bypass); fixes | F |

Estimated size: about 7 agents in parallel and pipelined stages. A within, then C runs alongside B.

## Showing it to you

- **In this cloud session:** I run `blastradius serve` on localhost inside the container, drive it with Chromium (Playwright), and send screenshots. The rendered HTML report is also sent. A `localhost` link from here won't open on your machine.
- **On your machine:** `cd blastradius && npm ci && npm run build && node dist/cli.js serve`, then open http://localhost:8000. Any Claude Code session with the built-in browser can open that too.
- **Shareable URL:** deploy with the exe.dev skill (`deploy.sh <vm> server`) to `https://<vm>.exe.xyz/`. This needs network access to exe.dev, which this cloud environment's policy currently blocks. Run it locally, or allow `exe.dev` in the environment's network settings.

## Deferred (later Phase 4 and beyond)

These come after the slice above works:
- the GitHub App and PR gate Action
- continuous monitoring and alerts
- webhooks and connectors
- SSO
- Postgres and Redis
- multi-ecosystem support (Phase 3)
- Bring your own AI (Phase 6)
