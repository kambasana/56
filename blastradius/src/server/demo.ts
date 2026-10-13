/**
 * The demo project (`serve --dev-seed`): "payments-platform" on the e2e fixture repo, scanned
 * offline from recorded 2018 data. It is badged "demo" everywhere and left out of org totals
 * (Tier 0.5), so it never reads as a real project's numbers. `serve --dev` alone does not create it.
 */
import { fileURLToPath } from 'node:url';

/** The e2e fixture repo the demo project scans (from src/ and dist/). */
export const E2E_REPO_DIR = fileURLToPath(new URL('../../test/fixtures/e2e-repo', import.meta.url));

/** True for a project whose target is the demo fixture repo. */
export function isDemoTarget(target: string): boolean {
  return target.replace(/\/+$/, '') === E2E_REPO_DIR.replace(/\/+$/, '');
}
