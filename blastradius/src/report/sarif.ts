/**
 * SARIF 2.1.0 renderer. One rule per factor family; one result per (finding, family), located at
 * the manifest/lockfile/workflow file of each asset that reaches the component.
 */
import { createHash } from 'node:crypto';
import { levelForScore, type Asset, type Finding, type OutboundFinding, type RiskLevel, type ScanResult } from '../core/types.js';
import { plainText } from './escape.js';

export const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';
export const TOOL_NAME = 'blastradius';

export interface RuleFamily {
  id: string;
  name: string;
  factors: readonly string[];
  short: string;
  full: string;
  /** GitHub code scanning `security-severity` (0–10). */
  securitySeverity: number;
}

export const RULE_FAMILIES: readonly RuleFamily[] = [
  { id: 'BR001', name: 'malware', factors: ['malware', 'compromised_release'], short: 'Known malicious or compromised release', full: 'The component version is listed as malicious in OSV or as an affected release in a confirmed incident.', securitySeverity: 9.8 },
  { id: 'BR002', name: 'vulnerability', factors: ['vuln'], short: 'Known vulnerability', full: 'The component version has known vulnerabilities (CVSS, EPSS and CISA KEV are taken into account).', securitySeverity: 7.5 },
  { id: 'BR003', name: 'ownership-change', factors: ['publisher_change', 'maintainer_change', 'repo_transfer'], short: 'Recent publisher, maintainer or repository-owner change', full: 'Publishing rights or repository ownership changed recently; the signal decays over 90 days.', securitySeverity: 6.0 },
  { id: 'BR004', name: 'install-script', factors: ['install_script'], short: 'Install-time script', full: 'The package runs lifecycle scripts on install; raised when static checks flag network or obfuscation.', securitySeverity: 5.0 },
  { id: 'BR005', name: 'weak-posture', factors: ['weak_posture'], short: 'Weak OpenSSF Scorecard posture', full: 'The source repository has a low OpenSSF Scorecard score.', securitySeverity: 4.0 },
  { id: 'BR006', name: 'no-provenance', factors: ['no_provenance'], short: 'No build provenance', full: 'No build provenance or attestation was found for this version.', securitySeverity: 3.0 },
  { id: 'BR007', name: 'single-maintainer', factors: ['single_maintainer'], short: 'Single maintainer', full: 'The package has a single registry maintainer account (low bus factor).', securitySeverity: 3.0 },
  { id: 'BR008', name: 'abandoned', factors: ['abandoned'], short: 'Abandoned or archived', full: 'No release in two years and/or an archived source repository.', securitySeverity: 4.0 },
  { id: 'BR009', name: 'entity-incident', factors: ['entity_incident', 'incident_affected'], short: 'Linked to a recorded incident', full: 'The package, or an account/org linked to it by reviewed public evidence, is referenced by an incident in the knowledge base.', securitySeverity: 6.5 },
  { id: 'BR010', name: 'workflow-outbound', factors: [], short: 'Risky publishing workflow', full: 'A workflow combines compromise-prone settings (privileged triggers, unpinned actions, write tokens, OIDC) with the ability to publish.', securitySeverity: 6.0 },
  { id: 'BR099', name: 'other', factors: [], short: 'Other supply-chain risk signal', full: 'Other risk factor.', securitySeverity: 3.0 },
];

const OUTBOUND_RULE = 'BR010';
const OTHER_RULE = 'BR099';

export function ruleForFactor(factor: string): RuleFamily {
  return RULE_FAMILIES.find((r) => r.factors.includes(factor)) ?? RULE_FAMILIES.find((r) => r.id === OTHER_RULE)!;
}

export function sarifLevel(level: RiskLevel): 'error' | 'warning' | 'note' {
  return level === 'critical' || level === 'high' ? 'error' : level === 'medium' ? 'warning' : 'note';
}

export interface SarifOptions {
  /** Inventory assets, used to locate results at each asset's source file. */
  assets?: readonly Asset[];
  toolVersion?: string;
  informationUri?: string;
  /** Max locations per result. Default 10. */
  maxLocations?: number;
}

/** Relative, forward-slash path safe for a SARIF artifactLocation uri. */
function toUri(path: string): string {
  const p = plainText(path, 1024).replace(/\\/g, '/').replace(/^\.?\/+/, '');
  return (p || 'package.json').split('/').map(encodeURIComponent).join('/');
}

function sourceFileFor(assetId: string, assets: Map<string, Asset>): string {
  const a = assets.get(assetId);
  if (a?.sourceFile) return a.sourceFile;
  const m = /^(workflow|image):(.+)$/.exec(assetId);
  if (m?.[2]) return m[2];
  return 'package-lock.json';
}

function fingerprint(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);
}

function locations(uris: string[]): object[] {
  return uris.map((uri) => ({
    physicalLocation: { artifactLocation: { uri, uriBaseId: '%SRCROOT%' }, region: { startLine: 1 } },
  }));
}

function findingResults(f: Finding, assets: Map<string, Asset>, maxLoc: number): object[] {
  const uris = [...new Set(f.blastRadius.assets.map((a) => toUri(sourceFileFor(a.assetId, assets))))].sort().slice(0, maxLoc);
  if (uris.length === 0) uris.push(toUri('package-lock.json'));
  const byRule = new Map<string, Finding['reasons']>();
  for (const r of f.reasons) {
    const id = ruleForFactor(r.factor).id;
    byRule.set(id, [...(byRule.get(id) ?? []), r]);
  }
  const out: object[] = [];
  for (const [ruleId, reasons] of [...byRule.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const details = reasons.map((r) => plainText(r.detail, 500)).join(' | ');
    const evidence = [...new Set(reasons.flatMap((r) => r.evidence))].sort().slice(0, 10);
    out.push({
      ruleId,
      ruleIndex: RULE_FAMILIES.findIndex((r) => r.id === ruleId),
      level: sarifLevel(f.level),
      message: {
        text: plainText(`${f.purl}: risk ${f.score}/100 (${f.level}), blast radius ${f.blastRadius.score} across ${f.blastRadius.assets.length} asset(s). ${details}`, 3000),
      },
      locations: locations(uris),
      partialFingerprints: { 'blastradius/v1': fingerprint(ruleId, f.purl) },
      properties: {
        purl: f.purl,
        score: f.score,
        riskLevel: f.level,
        blastRadius: f.blastRadius.score,
        assets: f.blastRadius.assets.map((a) => a.assetId),
        factors: reasons.map((r) => r.factor),
        evidence,
      },
    });
  }
  return out;
}

function outboundResult(o: OutboundFinding, assets: Map<string, Asset>): object {
  const level = levelForScore(Math.min(100, o.score));
  return {
    ruleId: OUTBOUND_RULE,
    ruleIndex: RULE_FAMILIES.findIndex((r) => r.id === OUTBOUND_RULE),
    level: sarifLevel(level),
    message: {
      text: plainText(`Outbound blast radius ${o.score} for ${o.assetId}: ${o.reasons.map((r) => r.detail).join(' | ')}`, 3000),
    },
    locations: locations([toUri(sourceFileFor(o.assetId, assets))]),
    partialFingerprints: { 'blastradius/v1': fingerprint(OUTBOUND_RULE, o.assetId) },
    properties: { assetId: o.assetId, score: o.score, factors: o.reasons.map((r) => r.factor), ...(o.dependents !== undefined ? { dependents: o.dependents } : {}) },
  };
}

export function toSarif(result: ScanResult, opts: SarifOptions = {}): Record<string, unknown> {
  const assets = new Map((opts.assets ?? []).map((a) => [a.id, a]));
  const maxLoc = opts.maxLocations ?? 10;
  const results = [
    ...result.findings.flatMap((f) => findingResults(f, assets, maxLoc)),
    ...(result.outbound ?? []).filter((o) => o.score > 0).map((o) => outboundResult(o, assets)),
  ];
  const run: Record<string, unknown> = {
    tool: {
      driver: {
        name: TOOL_NAME,
        version: opts.toolVersion ?? '0.1.0',
        informationUri: opts.informationUri ?? 'https://github.com/',
        rules: RULE_FAMILIES.map((r) => ({
          id: r.id,
          name: r.name,
          shortDescription: { text: r.short },
          fullDescription: { text: r.full },
          help: { text: `${r.full} See the result properties for the score, reasons and evidence URLs.` },
          defaultConfiguration: { level: r.securitySeverity >= 7 ? 'error' : 'warning' },
          properties: { tags: ['security', 'supply-chain'], 'security-severity': r.securitySeverity.toFixed(1) },
        })),
      },
    },
    automationDetails: { id: 'blastradius/' },
    results,
    properties: { target: plainText(result.target, 1024), generatedAt: result.generatedAt, schemaVersion: result.schemaVersion },
  };
  if (result.warnings && result.warnings.length > 0) {
    run.invocations = [
      {
        executionSuccessful: true,
        toolExecutionNotifications: result.warnings.map((w) => ({ level: 'warning', message: { text: plainText(w, 1000) } })),
      },
    ];
  }
  return { $schema: SARIF_SCHEMA, version: '2.1.0', runs: [run] };
}

export function renderSarif(result: ScanResult, opts: SarifOptions = {}): string {
  return `${JSON.stringify(toSarif(result, opts), null, 2)}\n`;
}
