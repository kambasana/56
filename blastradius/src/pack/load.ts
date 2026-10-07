/**
 * Read a knowledge pack and answer scan-time lookups. The pack is data from public sources; it is
 * parsed with JSON.parse only and checked against the schema version before use.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { inRanges } from '../core/osv-range.js';
import { PACK_SCHEMA, type KnowledgePack, type PackMalwareRef } from './types.js';

export interface LoadedPack {
  pack: KnowledgePack;
  sha256: string;
  path: string;
}

export async function loadPack(path: string, expectSha256?: string): Promise<LoadedPack> {
  const bytes = await readFile(path);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (expectSha256 && expectSha256.toLowerCase() !== sha256) throw new Error(`Knowledge pack ${path}: SHA-256 ${sha256} does not match the expected ${expectSha256}`);
  const text = (bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes).toString('utf8');
  const pack = JSON.parse(text) as KnowledgePack;
  if (!pack || pack.schema !== PACK_SCHEMA || typeof pack.malware !== 'object') throw new Error(`Knowledge pack ${path}: unsupported schema ${String(pack?.schema)} (expected ${PACK_SCHEMA})`);
  return { pack, sha256, path };
}

/** Malware refs for a package version: whole-package entries plus that exact release. */
export function packMalware(pack: KnowledgePack, name: string, version: string | undefined): PackMalwareRef[] {
  const whole = pack.malware.packages[name] ?? [];
  const exact = version !== undefined ? (pack.malware.versions[name]?.[version] ?? []) : [];
  const ranged = version !== undefined ? (pack.malware.ranges[name] ?? []).filter((x) => inRanges(version, x.ranges)).map((x) => x.ref) : [];
  return [...whole, ...exact, ...ranged];
}
