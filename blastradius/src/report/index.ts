import type { Asset, Inventory, ScanResult } from '../core/types.js';
import type { LicensePolicy } from '../licenses/policy.js';
import { renderJson } from './json.js';
import { renderSarif } from './sarif.js';
import { renderHtml } from './html.js';
import { renderCycloneDx, renderSpdx } from './sbom.js';

export type ReportFormat = 'json' | 'sarif' | 'html' | 'cyclonedx' | 'spdx';

/** File name used for each format. */
export const REPORT_FILENAMES: Readonly<Record<ReportFormat, string>> = {
  json: 'blastradius.json',
  sarif: 'blastradius.sarif',
  html: 'blastradius.html',
  cyclonedx: 'blastradius.cdx.json',
  spdx: 'blastradius.spdx.json',
};

export interface RenderOptions {
  /** Inventory assets: SARIF points at each asset's source file. */
  assets?: readonly Asset[];
  /** Whole inventory: SBOM formats add dependency relationships. */
  inventory?: Pick<Inventory, 'components' | 'edges' | 'assets'>;
  title?: string;
  /** Licence policy for the HTML Licences section (default template otherwise). */
  licensePolicy?: LicensePolicy;
  licensePolicyLabel?: string;
}

/** Render a ScanResult. */
export function renderReport(result: ScanResult, format: ReportFormat, opts: RenderOptions = {}): string {
  const assets = opts.assets ?? opts.inventory?.assets;
  switch (format) {
    case 'json':
      return renderJson(result);
    case 'sarif':
      return renderSarif(result, assets ? { assets } : {});
    case 'html':
      return renderHtml(result, {
        ...(opts.title ? { title: opts.title } : {}),
        ...(opts.licensePolicy ? { licensePolicy: opts.licensePolicy } : {}),
        ...(opts.licensePolicyLabel ? { licensePolicyLabel: opts.licensePolicyLabel } : {}),
      });
    case 'cyclonedx':
      return renderCycloneDx(result, opts.inventory);
    case 'spdx':
      return renderSpdx(result, opts.inventory);
  }
}

export { renderCycloneDx, renderSpdx, toCycloneDxBom, toSpdx, CYCLONEDX_SPEC_VERSION, type SpdxDocument } from './sbom.js';

export { renderJson, toJsonReport, findingReach, nameAndVersion, type JsonReport, type ReportFinding, type FindingReach } from './json.js';
export { describeReach, type ReachAsset } from './reach.js';
export { renderSarif, toSarif, ruleForFactor, sarifLevel, RULE_FAMILIES, SARIF_SCHEMA, type SarifOptions, type RuleFamily } from './sarif.js';
export { renderHtml, type HtmlOptions } from './html.js';
export { escapeHtml, safeHttpUrl, plainText } from './escape.js';
