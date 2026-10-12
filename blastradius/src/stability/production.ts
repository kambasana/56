/**
 * Which components are production dependencies (plan §4: "S3 ended while a production dependency";
 * the roll-up counts production dependencies only by default). Tier 0: one scope per (project,
 * package) from src/core/scope.ts, where only runtime counts as production (optional and peer
 * no longer do), so stability agrees with findings, exposure and the SBOM.
 */
import type { Inventory, PurlString } from '../core/types.js';
import { productionSet } from '../core/scope.js';

export function productionComponents(inv: Inventory): Set<PurlString> {
  return productionSet(inv);
}
