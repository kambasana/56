# Blastradius UX: one system for every screen

**Why (2026-10-08).** The current UI grew screen by screen and reads that way. The incident flow dead-ends, default roles cannot triage, nav items are not real pages, the same content is laid out two ways, every page has a different primary action, and there is a lot of jargon (inventory in the redesign notes). This document is the single pattern set every screen follows. Each rule cites its evidence: **[M]** a Mobbin reference, **[B#]** a Baymard rule (numbered as in the research notes), **[ours]** a call we made where neither source covers it.

Design: [Blastradius UX redesign](https://claude.ai/artifact/9nJNMZVhxDirSnnnaFfuPV), 10 linked screens (Overview, Findings, Finding, ⌘K, Incident, Connect, Import, Sources, Alerts, States) sharing one sidebar.

Visual base: the Claude Design System (shadcn new-york-v4, 28px controls, DM Sans and JetBrains Mono, tokens only, light and dark).

## 1. Who and what for

- **AppSec lead:** "What's on fire, are we hit, who's handling it?"
- **Developer:** "Is my repo affected, and what do I change?"
- **Auditor:** "Show me the record."

Every screen answers one of those questions first.

## 2. Navigation model

- **Left sidebar, one level** [M Sentry, Vercel]: org switcher · **Overview** · **Findings** · **Incidents** · **Projects** · **Alerts**, with **Settings** at the bottom. No anchors posing as pages, no duplicate entries, nothing labelled "coming soon".
- **⌘K everywhere** [M Vapi, GitHub; B3]: it finds packages, projects, people and orgs, plus settings and actions ("Connect GitLab", "Slack alerts"). A package query answers inline: *"lodash@4.17.20: in 7 projects, 3 in production"* [ours, no reference exists].
- **Scope bar** under the page title on Overview, Findings and Incidents [M Sentry]: Projects ▾ · Environment (Production / Dev and test) ▾ · Time ▾. It carries across pages and lives in the URL.
- **Every view has a URL.** Filters, sort, an open panel and paging all push history, so Back works and returns to the same row and scroll position [B1, B2].
- **Breadcrumbs:** every crumb is a link.

## 3. Four page templates

| Template | Used by | Shape |
|---|---|---|
| **Overview** | Overview, Project home | "Needs attention" tiles (clickable, with counts) [M Vanta] → trend by severity [M GitLab] → Top-N lists [M Vercel] |
| **List** | Findings, Incidents, Projects, Alerts | scope bar → promoted filter chips plus "All filters" → applied-filter row → table → floating bulk bar |
| **Detail** | Finding, Incident, Project, Repo | header (title, severity, status, **one** primary action) → main column of **stacked sections with an on-page index, no tabs** [B19] → right rail of editable fields [M Sentry, GitLab] |
| **Settings** | Sources, Alerts and Slack, Members and roles, Feeds | grouped left sub-nav → one card per thing [M Neon, Hex] |

## 4. Tables

- On desktop, a sortable table with 50 rows per load and "Load more" [B4, B13]. Below 768px it turns into stacked rows.
- The primary cell is two lines: **package@version** over *project · manifest path*.
- Columns (findings): Severity · Package · Projects (with a production count) · Reach · Introduced by · First seen · Status · Owner. **One** score is shown, as a severity level, not two numbers.
- Grouping by severity, project or package [M Linear], plus a switch between **By package** and **By project** [M Vanta].
- Every column can be filtered [B8]. Several values within one filter combine with OR, different filters with AND [B6]. Long value lists get a search box [B7]. Jargon filters get a ⓘ explanation [B9].
- Promoted chips: *Critical*, *In production*, *New this week*, *Unassigned* [B10]. The applied filters show as removable chips above the table, with "Clear all" [B5].
- Selecting rows brings up a **floating bulk bar**: Set status · Assign · Accept risk… · Create ticket [M Linear, ClickUp].
- Clicking a row opens a **peek sheet** for quick triage. "Open full page" goes to the Detail page, which has its own URL. One hit area per destination [B14].

## 5. Words

- **Severity:** Critical · High · Medium · Low, always shown with a shape and a word, never colour alone: ◆ Critical, ▲ High, ● Medium, ○ Low [M GitLab; contrast rules].
- **Status:** Open → Triaged → Fixing → Resolved, plus *Accepted risk* (needs a reason and an expiry date).
- **Reach**, separate from severity: *In production* / *Dev and test only* / *Unknown*.
- **Renamed:**
  - "Upkeep signals" → **Maintenance**
  - "Blast" → removed
  - "noisy-OR" → removed; the score explains itself as a list of reasons
  - "Purl" → **Package**
  - "Snapshot" → **Scan**
- **Body copy:** sentences of 50–75 characters, the fact first [B21]. Every number has a unit or a source.

## 6. States

- **Empty:** the table frame and filters stay, with one line of text and one action [M Whop]. An all-clear shows a green "No open findings" banner inside the table [M Replit].
- **No results:** never a dead end. Offer "Remove filter X" or "Search all projects" [B16].
- **Errors:** shown inline, where they happened, with the real reason in monospace and **Retry** [M Steep, Buffer; B25]. "Token lacks read_repository", never "Connection failed".
- **Loading:** skeleton rows matching the final layout. No spinners in tables.
- **Permissions:** a control you can't use stays visible but disabled, with *"Needs the Triage permission: ask an admin"*. It never silently disappears.

## 7. Forms

One column, labels above fields, required (*) and optional both marked [B22, B23]. Validation happens when you leave a field, not while you type, and the error clears once fixed [B24]. Every permission or field that may look sensitive gets a one-line *why* [B26]. A dropdown is used only for 5–10 options; fewer than 5 are radio buttons [B27].

## 8. Core flows (each has screens on the canvas)

1. **First run:** Connect a source → pick repos ("watch all, including new ones") → import progress per repo → Overview [M Render, Graphite, Greptile].
2. **Triage:** Findings → peek sheet → set status and owner, or bulk → next finding (J/K keys).
3. **Incident, "are we hit?":** a ⌘K verdict, an Incident page listing affected projects (production first), who brought it in, and a link to each finding. One click to "Notify owners".
4. **Investigate:** Finding detail → reach paths → who's behind it → evidence → timeline.
5. **Alerts:** a WHEN → THEN rule builder with "would have fired N times in 30 days" [M Sentry, LangChain]. The Slack channel is set for the team; personal notification preferences are separate [M Vercel].
6. **Settings:** Sources (one card per host, health shown, a clear Remove area that states its impact) [M Neon].

## 9. Default roles

AppSec gets triage, accept-risk and alert-rule permissions. Developer gets triage on the projects they own. Auditor is read-only plus reports. The 2026-10-08 inventory found AppSec and Developer had no actions at all; this fixes that.
