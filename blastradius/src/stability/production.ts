/**
 * Which components are production dependencies (plan §4: "S3 ended while a production dependency";
 * the roll-up counts production dependencies only by default): one scope per (project, package)
 * from src/core/scope.ts, so stability agrees with findings, exposure and the SBOM. Production is
 * runtime, peer and npm optional (Tier 0.5: what `npm ci --omit=dev` installs); Python extras
 * (scope `extra`, Tier 0.6) are not, because pip installs them only on request.
 */
import type { Inventory, PurlString } from '../core/types.js';
import { productionSet } from '../core/scope.js';

export function productionComponents(inv: Inventory): Set<PurlString> {
  return productionSet(inv);
}
