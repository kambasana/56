/**
 * Optional Syft adapter. When `syft` is on PATH it can produce a CycloneDX JSON
 * SBOM for the target (Syft reads files statically; it does not install or run
 * project code). When it is missing, ingest skips this step.
 */
import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import path from 'node:path';
import { normalizePurl, parsePurl, type Component, type Ecosystem } from '../core/types.js';
import { cap, isRecord, own } from './fs.js';

/** Locate an executable on PATH without invoking a shell. */
export async function findOnPath(bin: string, envPath = process.env.PATH ?? ''): Promise<string | null> {
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, bin);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

export interface CycloneDxImport {
  components: Component[];
  /** purl → purls it depends on (from the CycloneDX `dependencies` section). */
  dependencies: Map<string, string[]>;
  warnings: string[];
}

function ecosystemOf(type: string): Ecosystem {
  return type === 'npm' || type === 'githubactions' || type === 'docker' ? type : 'generic';
}

/** Convert CycloneDX JSON (as produced by `syft -o cyclonedx-json`) into components. Untrusted input. */
export function parseCycloneDx(json: unknown): CycloneDxImport {
  const warnings: string[] = [];
  const components = new Map<string, Component>();
  const refToPurl = new Map<string, string>();
  const list = own(json, 'components');
  if (!Array.isArray(list)) return { components: [], dependencies: new Map(), warnings: ['CycloneDX document has no components'] };
  let skipped = 0;
  for (const c of list.slice(0, 200_000)) {
    const rawPurl = own(c, 'purl');
    if (typeof rawPurl !== 'string') {
      skipped++;
      continue;
    }
    let purl: string;
    let parsed;
    try {
      purl = normalizePurl(rawPurl);
      parsed = parsePurl(purl);
    } catch {
      skipped++;
      continue;
    }
    if (!parsed.version) {
      skipped++;
      continue;
    }
    const name = parsed.namespace ? `${parsed.namespace}/${parsed.name}` : parsed.name;
    if (!components.has(purl)) components.set(purl, { purl, ecosystem: ecosystemOf(parsed.type), name: cap(name, 300), version: cap(parsed.version, 256) });
    const ref = own(c, 'bom-ref');
    if (typeof ref === 'string') refToPurl.set(ref, purl);
  }
  if (skipped > 0) warnings.push(`syft: ${skipped} component(s) without a usable versioned purl were skipped`);
  const dependencies = new Map<string, string[]>();
  const deps = own(json, 'dependencies');
  if (Array.isArray(deps)) {
    for (const d of deps) {
      if (!isRecord(d)) continue;
      const from = refToPurl.get(String(own(d, 'ref')));
      const on = own(d, 'dependsOn');
      if (!from || !Array.isArray(on)) continue;
      const tos = on.map((r) => refToPurl.get(String(r))).filter((x): x is string => !!x && x !== from);
      if (tos.length > 0) dependencies.set(from, tos);
    }
  }
  return { components: [...components.values()], dependencies, warnings };
}

/** Run syft on a directory and import its CycloneDX output. Returns null when syft is not installed. */
export async function runSyft(dir: string, opts: { timeoutMs?: number; maxBytes?: number } = {}): Promise<CycloneDxImport | null> {
  const bin = await findOnPath('syft');
  if (!bin) return null;
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      bin,
      ['scan', `dir:${dir}`, '-o', 'cyclonedx-json', '-q'],
      { timeout: opts.timeoutMs ?? 300_000, maxBuffer: opts.maxBytes ?? 256 * 1024 * 1024, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', SYFT_CHECK_FOR_APP_UPDATE: 'false' } },
      (err, out) => (err ? reject(new Error(`syft failed: ${err.message.slice(0, 300)}`)) : resolve(out)),
    );
  });
  return parseCycloneDx(JSON.parse(stdout));
}
