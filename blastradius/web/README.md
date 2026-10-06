# Blastradius web app

Vite + React + TypeScript + Tailwind CSS v4 + React Router + TanStack Table/Virtual + Cytoscape.js.
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
- **`src/auth.tsx`:** `useAuth()` gives `me`, `can(permission, projectId?)`, `login`, `logout` and `switchUser` (dev).
- **`src/project.tsx`:** `useProject()` gives the current `projectId`, `project` and `projects`.
- **Components** (`src/components`): `PageHeader`, `DataTable` (sorting, filter, column menu, virtual rows,
  row click opens `renderPanel`), `SidePanel`, `RiskBadge`/`Badge`, `StatTile`, `EmptyState`/`ErrorState`/
  `LoadingState`/`ForbiddenState`, `Button`/`ButtonLink`/`ButtonAnchor`. `ScopedGraph` (Cytoscape) is imported
  directly from `src/components/ScopedGraph.tsx` so it stays out of the main bundle.
- **Screens** live in `src/pages/*.tsx` (one default export each). Route registration and permission guards
  are in `src/routes.tsx`; screen agents edit only their page files.
- Render untrusted values as React text only. Never use `dangerouslySetInnerHTML`.
