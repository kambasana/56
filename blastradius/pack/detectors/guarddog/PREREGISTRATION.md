# GuardDog gate: pre-registered measures (written before any catch scan)

Written 2026-10-08 12:48 UTC, before any malware sample was scanned. Committed before the catch
results exist so the mapping cannot be tuned on them. Gate rules: docs/FEEDS-AND-DETECTORS.md §3.

## Tool

GuardDog 3.2.0 (Apache-2.0), installed with pip into a throwaway venv. In 3.2.0 all npm source
rules are YARA rules (`guarddog/analyzer/sourcecode/*.yar`), each carrying its own `severity`,
`specificity` and `sophistication`; GuardDog then correlates findings into "risks" and computes a
package score 0-10 with a label (`no_risks_detected`, `low` < 5, `suspicious` 5-6.9,
`high_risk` >= 7). Scans run with GuardDog's default kernel sandbox on, on tarballs or extracted
directories only. Nothing under test is installed, imported or executed.

## Severity mapping (fixed now, not tuned)

We do not invent our own rule weights. We take GuardDog's own package label:

| GuardDog label | Blastradius severity |
|---|---|
| `high_risk` (score >= 7) | high |
| `suspicious` (score 5.0-6.9) | medium |
| `low` (score > 0, < 5) | low |
| `no_risks_detected` | none |

- **Primary measure (M1), "medium or above":** label `suspicious` or `high_risk`.
- **Strict measure (M2), "high":** label `high_risk` only.
- **Loose measure (M3), "any risk":** any formed GuardDog risk (label `low` or above). Reported
  for completeness; a `low` finding is not shown to users and does not count as noise.
- Capability-only matches (rules named `capability-*` that do not form a risk) are never findings.

Per-rule tables report which rules fired; they do not change the mapping.

## Rule set

All 3.2.0 npm source-code rules, defaults. Metadata rules (`provenance_regression`,
`risky_new_dependency`, `typosquatting`, etc.) need registry metadata, which no longer exists for
removed malicious versions, so the catch side cannot run them. To keep catch and noise symmetric,
both sides run source-code rules only (local tarball / directory scans, no `--metadata`).

## Sets

- **Catch (gating):** every npm `compromised_lib` sample in DataDog/malicious-software-packages-dataset
  at the cloned commit, plus the replay incidents (blastradius/test/replay) that have a sample there,
  matched by exact name@version.
- **Catch (reported, not gating):** a deterministic sample of `malicious_intent` npm samples
  (those whose sha256("name@version") hex starts with "0", i.e. about 1/16).
- **Noise:** exact versions in the lockfiles of microsoft/TypeScript@de61e6962143,
  mochajs/mocha@a9fc52968316 and the 6 replay org repos in test/replay/data/org; tarballs from
  registry.npmjs.org. Known-bad versions present in those lockfiles (the replay incidents) are
  excluded from noise. Findings per repo = number of distinct package versions in its lockfile
  at the measure's level.

## Holdout for any rule-subset hypothesis

If the full rule set fails and a rule subset is proposed:
- Split compromised samples by sha256("name@version"): first hex digit even = **dev**, odd = **holdout**.
- Split controls: **dev** = TypeScript and mocha; **holdout** = the 6 replay org repos.
- The subset is chosen only from dev results, then measured once on holdout. Even if it passes on
  holdout it is reported as a hypothesis needing a fresh check, not as a gate pass.

## Gate (from docs/FEEDS-AND-DETECTORS.md §3)

1. Catch: on the replay incidents plus Datadog compromised samples, GuardDog at M1 flags more bad
   releases than our current signals (11/16 on the replay set), or the union is higher.
2. Noise: <= 1 added finding per control repo at M1 (every repo, not the mean).
3. Cost: scan time per new or changed version fits a per-scan budget on lockfile diffs.
