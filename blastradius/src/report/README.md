# report — JSON / SARIF 2.1.0 / single-file HTML renderers of `ScanResult`

`renderReport(result, 'json' | 'sarif' | 'html', { assets?, title? })`; file names in `REPORT_FILENAMES`.

- JSON: ScanResult + additive `summary` and per-finding `name`, `version`, `reach`, `evidence`.
- SARIF: one rule per factor family (`RULE_FAMILIES`), results located at each reaching asset's `sourceFile`
  (pass inventory `assets`), level critical/high → error, medium → warning, low → note.
- HTML: no scripts or external assets, strict CSP, everything escaped, only http(s) evidence links.
