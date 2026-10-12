/**
 * SBOM export with licences (docs/WHO-BEHIND-PLAN.md L5).
 *
 * - CycloneDX 1.6 JSON, built and serialised with the OWASP CycloneDX JavaScript library
 *   (@cyclonedx/cyclonedx-library, Apache-2.0; spec https://cyclonedx.org/specification/overview/).
 *   Licences are "declared" acknowledgements: a single SPDX id as `license.id`, a compound
 *   expression as `expression`, anything else as `license.name` (the author's string).
 * - SPDX 2.3 JSON, written to the published JSON schema (spdx-spec v2.3 schemas/spdx-schema.json).
 *   `licenseDeclared` is the SPDX expression; strings with no SPDX form become a LicenseRef with
 *   the original text; no licence is NOASSERTION. `licenseConcluded` is always NOASSERTION: we
 *   report what sources declare and never conclude a licence ourselves.
 *
 * Our own annotations are CycloneDX properties in the "blastradius:" namespace (category, source,
 * status, changes). Untrusted strings are carried as data only.
 */
import { createHash } from 'node:crypto';
import * as CDX from '@cyclonedx/cyclonedx-library';
import { parsePurl, unversionedPurl, type ComponentLicense, type Inventory, type ScanResult } from '../core/types.js';
import { describeChangePlacement, isRangeChange } from '../licenses/history.js';
import { parseSpdx } from '../licenses/spdx.js';
import { componentScopes, type ComponentScope } from '../core/scope.js';
import { notAnalysedLine } from '../ingest/manifests.js';
import { productNameOf } from '../core/repo-url.js';

/** CycloneDX scope for our project scope: runtime is required, optional/peer optional, the rest excluded. */
function cdxScope(scope: ComponentScope): CDX.Enums.ComponentScope {
  if (scope === 'runtime') return CDX.Enums.ComponentScope.Required;
  if (scope === 'optional' || scope === 'peer') return CDX.Enums.ComponentScope.Optional;
  return CDX.Enums.ComponentScope.Excluded;
}

function scopesOf(inventory: Pick<Inventory, 'components' | 'edges' | 'assets'> | undefined): Map<string, ComponentScope> {
  return inventory && inventory.assets.length > 0 ? componentScopes(inventory) : new Map();
}

const TOOL = { vendor: 'blastradius', name: 'blastradius', version: '0.1.0' };

function componentType(ecosystem: string): CDX.Enums.ComponentType {
  if (ecosystem === 'docker') return CDX.Enums.ComponentType.Container;
  return CDX.Enums.ComponentType.Library;
}

function splitName(purl: string, fallback: string): { group?: string; name: string } {
  try {
    const p = parsePurl(purl);
    return p.namespace ? { group: p.namespace, name: p.name } : { name: p.name };
  } catch {
    return { name: fallback };
  }
}

/** A plain SPDX id (no operators, no exception, no "+"). */
function isSingleId(expression: string): boolean {
  const ast = parseSpdx(expression);
  return !!ast && 'license' in ast && !ast.plus && !ast.exception;
}

function cdxLicenses(c: ComponentLicense): CDX.Models.License[] {
  const ack = CDX.Enums.LicenseAcknowledgement.Declared;
  if (c.expressions.length === 1 && !isSingleId(c.expressions[0]!)) {
    const expr = new CDX.Models.LicenseExpression(c.expressions[0]!);
    expr.acknowledgement = ack;
    return [expr];
  }
  if (c.expressions.length > 0) {
    return c.expressions.map((e) => (isSingleId(e) ? new CDX.Models.SpdxLicense(e, { acknowledgement: ack }) : new CDX.Models.NamedLicense(e, { acknowledgement: ack })));
  }
  const raw = c.sources.find((s) => s.source === c.source)?.raw ?? [];
  return raw.map((r) => new CDX.Models.NamedLicense(r, { acknowledgement: ack }));
}

/** The product an SBOM describes: the scan's `product`, else the target's repository or directory name. */
function productOf(result: ScanResult): { name: string; version?: string } {
  const name = (result.product?.name || productNameOf(result.target)).slice(0, 300);
  const version = result.product?.version?.slice(0, 100);
  return version ? { name, version } : { name };
}

function licenseIndex(result: ScanResult): Map<string, ComponentLicense> {
  return new Map((result.licenses?.components ?? []).map((c) => [c.purl, c]));
}

/** CycloneDX 1.6 BOM object for a scan. */
export function toCycloneDxBom(result: ScanResult, inventory?: Pick<Inventory, 'components' | 'edges' | 'assets'>): CDX.Models.Bom {
  const bom = new CDX.Models.Bom();
  bom.serialNumber = `urn:uuid:${uuidFrom(`${result.target}\u0000${result.generatedAt}`)}`;
  bom.metadata.timestamp = new Date(result.generatedAt);
  bom.metadata.tools.components.add(new CDX.Models.Component(CDX.Enums.ComponentType.Application, TOOL.name, { version: TOOL.version, group: TOOL.vendor }));
  // Tier 0.5: the product name (never the scan machine's absolute path).
  const product = productOf(result);
  const root = new CDX.Models.Component(CDX.Enums.ComponentType.Application, product.name, { bomRef: 'root', ...(product.version ? { version: product.version } : {}) });
  bom.metadata.component = root;
  // Tier 0: manifests found but not analysed are part of what this SBOM does not cover.
  for (const n of result.notAnalysed ?? []) bom.metadata.properties.add(new CDX.Models.Property('blastradius:notAnalysed', `${n.file}: ${n.reason}${n.packages !== undefined ? ` (~${n.packages} packages)` : ''}`));
  if (result.notAnalysed?.length) bom.metadata.properties.add(new CDX.Models.Property('blastradius:notAnalysed:summary', notAnalysedLine(result.notAnalysed)));
  for (const src of result.coverage?.sources ?? []) if (src.status !== 'ok') bom.metadata.properties.add(new CDX.Models.Property('blastradius:source', `${src.source} ${src.status}${src.reason ? `: ${src.reason}` : ''}`));
  const scopes = scopesOf(inventory);

  const licenses = licenseIndex(result);
  const changes = new Map<string, string[]>();
  for (const ch of result.licenses?.changes ?? []) {
    const list = changes.get(ch.purl) ?? [];
    // A change across releases without licence data is a range, written as such.
    const where = isRangeChange(ch) ? describeChangePlacement(ch) : `${ch.previousVersion} → ${ch.version}`;
    list.push(`${where}: ${ch.from.join(' · ')} → ${ch.to.join(' · ')}${ch.date ? ` (${ch.date.slice(0, 10)})` : ''}`);
    changes.set(ch.purl, list);
  }

  const source: { purl: string; name: string; version: string; ecosystem: string }[] = inventory
    ? inventory.components.map((c) => ({ purl: c.purl, name: c.name, version: c.version, ecosystem: c.ecosystem }))
    : (result.licenses?.components ?? []).map((c) => ({ purl: c.purl, name: c.name, version: c.version, ecosystem: c.ecosystem }));
  const byRef = new Map<string, CDX.Models.Component>();
  for (const c of [...source].sort((a, b) => (a.purl < b.purl ? -1 : a.purl > b.purl ? 1 : 0))) {
    if (byRef.has(c.purl)) continue;
    const { group, name } = splitName(c.purl, c.name);
    const comp = new CDX.Models.Component(componentType(c.ecosystem), name, { bomRef: c.purl, version: c.version, ...(group ? { group } : {}) });
    comp.purl = c.purl;
    const scope = scopes.get(c.purl);
    if (scope) {
      comp.scope = cdxScope(scope);
      comp.properties.add(new CDX.Models.Property('blastradius:scope', scope));
    }
    const lic = licenses.get(c.purl);
    if (lic) {
      for (const l of cdxLicenses(lic)) comp.licenses.add(l);
      comp.properties.add(new CDX.Models.Property('blastradius:license:category', lic.category));
      comp.properties.add(new CDX.Models.Property('blastradius:license:status', lic.status));
      comp.properties.add(new CDX.Models.Property('blastradius:license:source', lic.source));
      if (lic.disagreement) comp.properties.add(new CDX.Models.Property('blastradius:license:disagreement', 'true'));
    }
    let pkg: string | undefined;
    try {
      pkg = unversionedPurl(c.purl);
    } catch {
      pkg = undefined;
    }
    for (const text of (pkg && changes.get(pkg)) || []) comp.properties.add(new CDX.Models.Property('blastradius:license:change', text));
    bom.components.add(comp);
    byRef.set(c.purl, comp);
  }

  if (inventory) {
    const assets = new Set(inventory.assets.map((a) => a.id));
    for (const e of inventory.edges) {
      const to = byRef.get(e.to);
      if (!to) continue;
      if (assets.has(e.from)) root.dependencies.add(to.bomRef);
      else byRef.get(e.from)?.dependencies.add(to.bomRef);
    }
  }
  return bom;
}

/** CycloneDX 1.6 JSON text. */
export function renderCycloneDx(result: ScanResult, inventory?: Pick<Inventory, 'components' | 'edges' | 'assets'>): string {
  const spec = CDX.Spec.Spec1dot6;
  const serializer = new CDX.Serialize.JsonSerializer(new CDX.Serialize.JSON.Normalize.Factory(spec));
  return `${serializer.serialize(toCycloneDxBom(result, inventory), { sortLists: true, space: 2 })}\n`;
}

export const CYCLONEDX_SPEC_VERSION = CDX.Spec.Spec1dot6.version;

/** Deterministic RFC 4122 v5-style UUID from text (no randomness, so re-renders match). */
function uuidFrom(text: string): string {
  const b = createHash('sha1').update(text).digest();
  b[6] = (b[6]! & 0x0f) | 0x50;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const x = b.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

// ---------------------------------------------------------------------------
// SPDX 2.3
// ---------------------------------------------------------------------------

interface SpdxPackage {
  SPDXID: string;
  name: string;
  versionInfo?: string;
  downloadLocation: string;
  filesAnalyzed: false;
  licenseConcluded: string;
  licenseDeclared: string;
  licenseComments?: string;
  copyrightText: string;
  comment?: string;
  primaryPackagePurpose?: string;
  externalRefs?: { referenceCategory: 'PACKAGE-MANAGER'; referenceType: 'purl'; referenceLocator: string }[];
}

export interface SpdxDocument {
  spdxVersion: 'SPDX-2.3';
  dataLicense: 'CC0-1.0';
  SPDXID: 'SPDXRef-DOCUMENT';
  name: string;
  documentNamespace: string;
  creationInfo: { created: string; creators: string[]; comment?: string };
  packages: SpdxPackage[];
  relationships: { spdxElementId: string; relationshipType: string; relatedSpdxElement: string }[];
  hasExtractedLicensingInfos?: { licenseId: string; extractedText: string; name: string }[];
}

function spdxIdFor(i: number): string {
  return `SPDXRef-Package-${i}`;
}

/** SPDX 2.3 JSON document for a scan. */
export function toSpdx(result: ScanResult, inventory?: Pick<Inventory, 'components' | 'edges' | 'assets'>): SpdxDocument {
  const licenses = licenseIndex(result);
  const extracted = new Map<string, { licenseId: string; extractedText: string; name: string }>();
  const refFor = (raw: string): string => {
    const id = `LicenseRef-blastradius-${createHash('sha256').update(raw).digest('hex').slice(0, 12)}`;
    if (!extracted.has(id)) extracted.set(id, { licenseId: id, extractedText: raw, name: raw.slice(0, 200) });
    return id;
  };
  const declared = (c: ComponentLicense | undefined): { value: string; comment?: string } => {
    if (!c) return { value: 'NOASSERTION' };
    if (c.expressions.length === 1) return { value: c.expressions[0]! };
    if (c.expressions.length > 1) {
      return {
        value: c.expressions
          .map((e) => {
            const ast = parseSpdx(e);
            return ast && !('license' in ast) ? `(${e})` : e;
          })
          .join(' AND '),
        comment: `${c.source} lists ${c.expressions.length} licences without stating how they combine; shown as AND (all apply).`,
      };
    }
    const raw = c.sources.find((s) => s.source === c.source)?.raw ?? [];
    if (raw.length === 0) return { value: 'NOASSERTION' };
    return { value: raw.map(refFor).join(' AND '), comment: `Declared as ${raw.map((r) => JSON.stringify(r)).join(', ')} (${c.status.replace('_', '-')}).` };
  };

  const comps = inventory
    ? inventory.components.map((c) => ({ purl: c.purl, name: c.name, version: c.version }))
    : (result.licenses?.components ?? []).map((c) => ({ purl: c.purl, name: c.name, version: c.version }));
  const sorted = [...new Map(comps.map((c) => [c.purl, c])).values()].sort((a, b) => (a.purl < b.purl ? -1 : a.purl > b.purl ? 1 : 0));
  const ids = new Map<string, string>();
  const scopes = scopesOf(inventory);
  const product = productOf(result);
  const root: SpdxPackage = {
    SPDXID: 'SPDXRef-Root',
    name: product.name,
    ...(product.version ? { versionInfo: product.version } : {}),
    downloadLocation: 'NOASSERTION',
    filesAnalyzed: false,
    licenseConcluded: 'NOASSERTION',
    licenseDeclared: 'NOASSERTION',
    copyrightText: 'NOASSERTION',
    primaryPackagePurpose: 'APPLICATION',
  };
  const packages: SpdxPackage[] = [root];
  sorted.forEach((c, i) => {
    const id = spdxIdFor(i + 1);
    ids.set(c.purl, id);
    const d = declared(licenses.get(c.purl));
    const pkg: SpdxPackage = {
      SPDXID: id,
      name: c.name.slice(0, 300),
      versionInfo: c.version.slice(0, 200),
      downloadLocation: 'NOASSERTION',
      filesAnalyzed: false,
      licenseConcluded: 'NOASSERTION',
      licenseDeclared: d.value,
      copyrightText: 'NOASSERTION',
      externalRefs: [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: c.purl }],
    };
    if (d.comment) pkg.licenseComments = d.comment;
    const scope = scopes.get(c.purl);
    if (scope) pkg.comment = `blastradius:scope=${scope}`;
    packages.push(pkg);
  });
  const relationships: SpdxDocument['relationships'] = [{ spdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'DESCRIBES', relatedSpdxElement: 'SPDXRef-Root' }];
  if (inventory) {
    const assets = new Set(inventory.assets.map((a) => a.id));
    const seen = new Set<string>();
    for (const e of inventory.edges) {
      const to = ids.get(e.to);
      const from = assets.has(e.from) ? 'SPDXRef-Root' : ids.get(e.from);
      if (!to || !from || from === to) continue;
      const k = `${from} ${to}`;
      if (seen.has(k)) continue;
      seen.add(k);
      relationships.push({ spdxElementId: from, relationshipType: 'DEPENDS_ON', relatedSpdxElement: to });
    }
  }
  const doc: SpdxDocument = {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `blastradius ${product.name}`.slice(0, 300),
    documentNamespace: `https://blastradius.invalid/spdx/${uuidFrom(`${result.target}\u0000${result.generatedAt}`)}`,
    creationInfo: {
      created: result.generatedAt.replace(/\.\d{3}Z$/, 'Z'),
      creators: [`Tool: ${TOOL.name}-${TOOL.version}`],
      ...(result.notAnalysed?.length
        ? { comment: `${notAnalysedLine(result.notAnalysed)}. Not covered by this document: ${result.notAnalysed.map((n) => `${n.file} (${n.reason})`).join('; ')}`.slice(0, 4000) }
        : {}),
    },
    packages,
    relationships,
  };
  if (extracted.size > 0) doc.hasExtractedLicensingInfos = [...extracted.values()];
  return doc;
}

export function renderSpdx(result: ScanResult, inventory?: Pick<Inventory, 'components' | 'edges' | 'assets'>): string {
  return `${JSON.stringify(toSpdx(result, inventory), null, 2)}\n`;
}
