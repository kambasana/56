# Blastradius web app

Vite + React + TypeScript + Tailwind CSS v4 + shadcn/ui (Radix) + React Router + TanStack Table/Virtual + Cytoscape.js.
`npm run build` writes `dist/`, which `blastradius serve` serves. `npm run dev` serves on
http://127.0.0.1:5173 and proxies `/api` to http://127.0.0.1:8000.

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server with the `/api` proxy |
| `npm run build` | Typecheck, then build to `dist/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest + Testing Library (jsdom) |

## Shared pieces for screen authors

- **Contract:** import types from `@server/api-types` and the permission model from `@server/permissions`
  (alias for `../src/server/`). Do not copy types.
- **`src/api.ts`:** `api.<endpoint>(...)`, one function per endpoint in `docs/WEB-API.md`. Mutations send
  `X-Requested-With: blastradius`. Errors throw `ApiRequestError` (`code`, `status`, `fields`).
- **`src/lib/useApi.ts`:** `useApi((signal) => api.findings({ project }, signal), [project])` gives `{ data, error, loading, reload }`.
- **`src/auth.tsx`:** `useAuth()` gives `me`, `can(permission, projectId?)`, `login`, `logout`, `switchOrg` and `switchUser` (dev).
- **`src/project.tsx`:** `useProject()` gives the current `projectId`, `project` and `projects`.
- **Components** (`src/components`, built on `src/components/ui`): `PageHeader` (breadcrumb + actions go
  into the shell top bar), `DataTable` (shadcn data-table: sort buttons, filter, faceted filters via
  `meta.facet` / `riskLevelFacet`, column menu, skeleton `loading`, virtual rows, row click opens
  `renderPanel`), `SidePanel` (Sheet), `RiskBadge`/`Badge`, `StatTile` (Card), `EmptyState`/`ErrorState`/
  `LoadingState`/`ForbiddenState` (Empty), `Button`/`ButtonLink`/`ButtonAnchor`. `ScopedGraph` (Cytoscape) is imported
  directly from `src/components/ScopedGraph.tsx` so it stays out of the main bundle.
- **Screens** live in `src/pages/*.tsx` (one default export each). Route registration and permission guards
  are in `src/routes.tsx`; screen agents edit only their page files.
- Render untrusted values as React text only. Never use `dangerouslySetInnerHTML`.

## Design system: shadcn/ui

The UI uses [shadcn/ui](https://ui.shadcn.com) as published, not a look-alike:

- `components.json`: style `new-york` (registry `new-york-v4`, Tailwind v4, `radix-ui`), base colour
  `neutral`, CSS variables, lucide icons, aliases `@/components`, `@/components/ui`, `@/lib/utils`, `@/hooks`.
- `src/components/ui/*.tsx` and `src/hooks/use-mobile.ts` are copied verbatim from the upstream registry
  (`apps/v4/registry/new-york-v4/{ui,hooks}`), at upstream commit
  `e8c3143b1cd191280befcd6c9538284bb43399a8` (shadcn-ui/ui, 2026-10-07). The only edits are import paths
  (`@/registry/new-york-v4/...` to the aliases above, upstream's `cn` package to `@/lib/utils`) and, in
  `sonner.tsx`, `useTheme` from `@/components/theme-provider` instead of `next-themes`. Do not hand-edit
  these files; compose them in `src/components/*` instead. To add one, copy it from the same registry
  path (or `npx shadcn@latest add <name>` where ui.shadcn.com is reachable).
- `src/index.css`: the neutral theme (OKLCH variables for light and `.dark`, `@theme inline`,
  `tw-animate-css`), plus app tokens `--level-critical|high|medium|low`, `--warning`, `--success`, `--info`.
- The app layout is the `sidebar-07` block (icon-collapsible sidebar, org switcher, user menu);
  `src/components/theme-provider.tsx` is the shadcn Vite dark-mode provider (class on `<html>`,
  light/dark/system, stored in `localStorage`). Toasts: `import { toast } from 'sonner'`
  (`<Toaster />` is mounted once in `App.tsx`).
