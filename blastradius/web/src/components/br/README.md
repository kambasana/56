# Blastradius shared components (`@/components/br`)

React versions of the Blastradius Design System components (design system artifact
`DToocoexEfjkPhoG88ggrK`, rules in `docs/UX.md`). Every screen builds on these; do not restyle
them per page. Import from the barrel:

```ts
import { SeverityBadge, ReachTag, StatusTrack, ScopeBar, FilterChips, AppliedFilters, BulkBar, PeekSheet, Verdict, StateBlock } from '@/components/br';
```

Colours come only from the tokens in `src/index.css` (`sev-*`, `reach-*`, `selection`, `success`,
`destructive`, …) through Tailwind classes such as `text-sev-critical` or `bg-selection-soft`.
Colour carries severity only; reach is weight and outline.

## URL conventions

Every view state is in the URL and pushes history, so Back undoes it (docs/UX.md §2).

| Param | Owner | Values | Default (omitted) |
|---|---|---|---|
| `projects` | ScopeBar | comma-separated project ids | all projects |
| `env` | ScopeBar | `prod` · `dev` | production and dev |
| `range` | ScopeBar | `7d` · `30d` · `90d` · `all` | `30d` |
| `<filter key>` | FilterChips / AppliedFilters | comma-separated values, e.g. `severity=critical,high` | no filter |
| `peek` | PeekSheet (`usePeek`) | the open row id | closed |

- Values within one filter are OR, different filters are AND (`applyFilters`).
- Filter keys must not reuse `projects`, `env`, `range` or `peek`. Suggested keys for Findings:
  `severity`, `reach`, `status`, `owner`, `new` (`new=week`).
- Scope carries across Overview, Findings and Incidents: the sidebar appends `scopeSearch(sp)`
  to those links. Use `scopeSearch()` for any link between scoped pages.

## Components

### SeverityBadge
`<SeverityBadge level="critical" variant="filled|plain" size="sm|md" />` — glyph + word, never
colour alone (◆ Critical, ▲ High, ● Medium, ○ Low). `plain` in table rows, `filled` in headers
and sheets. Helpers in `severity.ts`: `SEVERITIES`, `SEVERITY_LABEL`, `SEVERITY_GLYPH`,
`severityText()`, `isSeverity()`.

### ReachTag
`<ReachTag reach="production|dev|unknown" count?={n} />` — "Production" (solid, bold),
"Dev and test" (dashed, muted), "Unknown". With `count` it reads "1 prod". `reachOf(production)`
maps the API's boolean.

### StatusTrack
`<StatusTrack steps={FINDING_STEPS} current="Triaged" label="Finding status" />`. Steps:
`FINDING_STEPS` (Open › Triaged › Fixing › Resolved), `INCIDENT_STEPS` (Investigating › Fixing ›
Monitoring › Closed). A `current` outside the steps (`ACCEPTED_RISK`) shows as a separate end
state. Read-only: the page's one primary action moves it.

### ScopeBar
`<ScopeBar projects={projects} showRange? showProjects? />` under the page title (`showProjects={false}` on a page already scoped to one project). `useScope()` returns
`[scope, setScope]` with `scope = { projects: string[], env: 'all'|'prod'|'dev', range }`.
`parseScope(sp)`, `scopeSearch(sp)`, `SCOPE_PARAMS`, `ENV_LABEL`, `RANGE_LABEL`.

### FilterChips and AppliedFilters
Define filters once at module level (stable identity):

```ts
const FILTERS: FilterDef[] = [{ key: 'severity', label: 'Severity', options: [{ value: 'critical', label: 'Critical' }, …] }, …];
const QUICK: QuickFilter[] = [{ label: 'Critical', key: 'severity', value: 'critical' }, …];
<FilterChips filters={FILTERS} quick={QUICK} />
<AppliedFilters filters={FILTERS} count="128 findings · showing 50" />
const { values } = useFilters(FILTERS);
const rows = applyFilters(all, values, (row, key) => row[key]);
```

`FilterDef.info` adds a ⓘ explanation (jargon filters). Lists over 8 options get a search box.
`useFilters()` also gives `toggle`, `set`, `remove`, `clearAll`, `has`, `count`.

### BulkBar
`<BulkBar count={n} actions={[{ label: 'Set status', onSelect }, { label: 'Accept risk…', onSelect, disabledReason }]} onClear status="4 set to Triaged" />`.
Fixed at the bottom centre (never shifts the table); hidden at 0. Actions can also be nodes
(e.g. a dropdown). Disabled actions stay visible with their reason.

### PeekSheet
```ts
const peek = usePeek();               // ?peek=<id>; open() pushes, J/K replaces, close() goes Back
useJK({ ids: visibleIds, current: peek.id, onMove: peek.open, enabled: peek.id !== null });
<PeekSheet open={peek.id !== null} onClose={peek.close} title={…} description="Malicious release" fullPageHref={`/projects/${p}/findings/${id}`} footer={statusControl}>…</PeekSheet>
```
Width `--sheet-w` (440px) on `popover`. Highlight the open row with `bg-selection-soft`.

### Verdict
`<Verdict data={{ pkg: 'ua-parser-js@0.7.29', projects: 3, production: 1, searched: 42, advisory?, detail? }} to={packagePath(name, version)} />`
— one link: "Yes, it is here: 3 projects, 1 in production" on `sev-critical-soft`, or "Not found
in any of 42 projects" on `success-soft`. `VerdictContent` is the same body without the link
(used inside the ⌘K list, which owns Enter). `verdictHeadline()` gives the sentence.

### StateBlock
Render it inside the frame it replaces (table body, section):

- `kind="all-clear"` `title` `description` (what was checked, when) `actions?`
- `kind="no-results"` `title` `actions` (exact recoveries: "Remove 'Severity: Critical' (6 results)", "Search all projects")
- `kind="error"` `title` `cause` (raw reason, shown in mono) `onRetry?` `actions?` (where to fix it)
- `kind="not-allowed"` `title` `permission` `admins?`
- `kind="loading"` `rows?` `columns?` `label?` — skeleton rows, never a spinner in a table

For a disabled control, keep it visible and add `<NotAllowedHint id permission />` with
`aria-describedby` on the control; `needsPermissionText(permission)` gives the sentence
("Needs the Triage permission: ask an admin.").

## Routes stage 2 builds on

- `/` Overview · `/findings` org-wide Findings (`group=project` for one row per finding; `/projects/:id/findings` is the same list for one project)
- `/incidents` · `/alerts` · `/projects` (list) · `/projects/:id/*` (project pages)
- `/packages?name=<name>&version=<version>` package / incident verdict page (`packagePath()` in `src/nav.ts`)
- `/settings`, `/integrations` (Settings › Sources), `/reports`
