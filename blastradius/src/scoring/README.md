# scoring — PLAN §3.6

`scoreInventory(inv, facts, { now, incidents?, entityPaths? | links?, workflows?, outboundDependents?, weights?, minScore?, pathLimits? })`
→ `{ findings, outbound, warnings }`; `buildScanResult({ target, inventory, score, generatedAt?, warnings? })` → `ScanResult`.

- Intrinsic (`intrinsic.ts`): noisy-OR over vuln, ownership change (publisher/maintainer/repo transfer, 90-day decay),
  install script, weak Scorecard, no provenance, single maintainer, abandoned. Malware (OSV fact, or a confirmed
  compromised-release incident naming the exact version) overrides to 1.0.
- Entity (`entity.ts`): max over paths of severity × status × Π link confidence × age decay (3y half-life) × hop decay.
  Pass `entityPaths: buildEntityGraph(...)` from src/entities, or `links` for the built-in traversal.
  Unreviewed probabilistic links < 0.8 are ignored.
- Inbound (`blast.ts`): exact widest-path scope exposure per asset, shortest-first capped path listing, reach multipliers,
  criticality/5 × environment weight. Truncation is reported in `warnings`.
- Outbound (`outbound.ts`): takes ingest `WorkflowInfo[]` (structural subset `WorkflowRiskInput`).
- All weights live in `weights.ts`.
