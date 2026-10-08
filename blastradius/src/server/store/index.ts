/**
 * Blastradius web store (Phase 4a): SQLite via node:sqlite.
 *
 *   const s = openStore({ path: 'blastradius.db' });   // ':memory:' by default
 *   failInterruptedScans(s);
 *   if (dev) await seedDev(s, { devMode: true });
 *
 * Every function takes the Store first. Reads of org-owned data take an `orgId` and return
 * null / not_found for other orgs' rows (the API answers 404, never 403). Mutations of roles,
 * bindings, projects, scans and finding statuses write an audit entry. Permission checks are
 * the server's job (../permissions.ts); `projectIds` arguments let it filter listings.
 *
 * Errors: StoreError with code bad_request | not_found | conflict (maps 1:1 to ApiErrorCode).
 */
export * from './db.js';
export { MIGRATIONS, SCHEMA_VERSION, migrate, currentVersion, type Migration } from './migrations.js';
export * from './audit.js';
export * from './auth.js';
export * from './orgs.js';
export * from './projects.js';
export * from './scans.js';
export * from './findings.js';
export * from './exposure.js';
export * from './changes.js';
export * from './rbac.js';
export * from './invites.js';
export * from './seed.js';
export * from './alerts.js';
export * from './triage.js';
export * from './incidents.js';
export * from './alert-rules.js';
