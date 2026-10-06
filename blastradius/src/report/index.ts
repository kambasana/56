import type { Asset, ScanResult } from '../core/types.js';
import { renderJson } from './json.js';
import { renderSarif } from './sarif.js';
import { renderHtml } from './html.js';

export type ReportFormat = 'json' | 'sarif' | 'html';

/** File name used for each format. */
export const REPORT_FILENAMES: Readonly<Record<ReportFormat, string>> = {
  json: 'blastradius.json',
  sarif: 'blastradius.sarif',
  html: 'blastradius.html',
};

/** Render a ScanResult. `assets` (inventory assets) lets SARIF point at each asset's source file. */
export function renderReport(result: ScanResult, format: ReportFormat, opts: { assets?: readonly Asset[]; title?: string } = {}): string {
  switch (format) {
    case 'json':
      return renderJson(result);
    case 'sarif':
      return renderSarif(result, opts.assets ? { assets: opts.assets } : {});
    case 'html':
      return renderHtml(result, opts.title ? { title: opts.title } : {});
  }
}

export { renderJson, toJsonReport, findingReach, nameAndVersion, type JsonReport, type ReportFinding, type FindingReach } from './json.js';
export { renderSarif, toSarif, ruleForFactor, sarifLevel, RULE_FAMILIES, SARIF_SCHEMA, type SarifOptions, type RuleFamily } from './sarif.js';
export { renderHtml, type HtmlOptions } from './html.js';
export { escapeHtml, safeHttpUrl, plainText } from './escape.js';
