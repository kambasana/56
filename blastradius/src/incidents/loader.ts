/**
 * Incident KB loader and validator (used by `blastradius kb validate`).
 *
 * Reads `*.yaml` / `*.yml` files from a directory (non-recursive), parses them
 * with the YAML core schema (no custom tags, capped aliases and size) and
 * validates every record with `incidentSchema`. Cross-file rules: incident ids
 * are unique across the KB.
 *
 * A file may contain one incident (a mapping) or a list of incidents.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Incident } from '../core/types.js';
import { parseIncident } from './schema.js';

/** KB files are small, hand-curated records; anything larger is rejected. */
export const MAX_KB_FILE_BYTES = 1_000_000;

export interface KbError {
  file: string;
  message: string;
}

export interface KbLoadResult {
  incidents: Incident[];
  files: number;
  errors: KbError[];
}

/** Same shape as `KbValidationResult` in src/pipeline.ts. */
export interface KbValidateResult {
  ok: boolean;
  files: number;
  errors: KbError[];
}

/** Parse and validate the text of one YAML file. `file` is used only in error messages. */
export function parseIncidentYaml(text: string, file = '<input>'): { incidents: Incident[]; errors: KbError[] } {
  const errors: KbError[] = [];
  const incidents: Incident[] = [];
  if (text.length > MAX_KB_FILE_BYTES) {
    return { incidents, errors: [{ file, message: `file larger than ${MAX_KB_FILE_BYTES} bytes` }] };
  }
  let doc: unknown;
  try {
    doc = parseYaml(text, { schema: 'core', maxAliasCount: 50, uniqueKeys: true, prettyErrors: false });
  } catch (e) {
    return { incidents, errors: [{ file, message: `YAML parse error: ${firstLine((e as Error).message)}` }] };
  }
  if (doc === null || doc === undefined) {
    return { incidents, errors: [{ file, message: 'empty file' }] };
  }
  const records = Array.isArray(doc) ? doc : [doc];
  records.forEach((rec, idx) => {
    const res = parseIncident(rec);
    const where = records.length > 1 ? `[${idx}] ` : '';
    const label = labelOf(rec);
    if (res.ok) incidents.push(res.incident);
    else for (const msg of res.errors) errors.push({ file, message: `${where}${label}${msg}` });
  });
  return { incidents, errors };
}

/** Load all incidents from a KB directory. Never throws for bad content; reports errors instead. */
export async function loadIncidents(dir: string): Promise<KbLoadResult> {
  const errors: KbError[] = [];
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => /\.ya?ml$/i.test(n)).sort();
  } catch (e) {
    return { incidents: [], files: 0, errors: [{ file: dir, message: `cannot read directory: ${firstLine((e as Error).message)}` }] };
  }

  const all: { incident: Incident; file: string }[] = [];
  for (const name of names) {
    const full = path.join(dir, name);
    try {
      const st = await stat(full);
      if (!st.isFile()) continue;
      if (st.size > MAX_KB_FILE_BYTES) {
        errors.push({ file: name, message: `file larger than ${MAX_KB_FILE_BYTES} bytes` });
        continue;
      }
      const text = await readFile(full, 'utf8');
      const res = parseIncidentYaml(text, name);
      errors.push(...res.errors);
      for (const incident of res.incidents) all.push({ incident, file: name });
    } catch (e) {
      errors.push({ file: name, message: `cannot read file: ${firstLine((e as Error).message)}` });
    }
  }

  // Cross-file rule: ids are unique.
  const seen = new Map<string, string>();
  const incidents: Incident[] = [];
  for (const { incident, file } of all) {
    const prev = seen.get(incident.id);
    if (prev !== undefined) {
      errors.push({ file, message: `${incident.id}: duplicate id (already defined in ${prev})` });
      continue;
    }
    seen.set(incident.id, file);
    incidents.push(incident);
  }
  incidents.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { incidents, files: names.length, errors };
}

/** Validate a KB directory. `ok` is true when there are no errors and at least one file was read. */
export async function validateKbDir(dir: string): Promise<KbValidateResult> {
  const res = await loadIncidents(dir);
  const errors = [...res.errors];
  if (res.files === 0 && errors.length === 0) errors.push({ file: dir, message: 'no incident YAML files found' });
  return { ok: errors.length === 0, files: res.files, errors };
}

function labelOf(rec: unknown): string {
  if (rec && typeof rec === 'object' && 'id' in rec && typeof (rec as { id: unknown }).id === 'string') {
    return `${String((rec as { id: string }).id).slice(0, 40)}: `;
  }
  return '';
}

function firstLine(s: string): string {
  return (s.split('\n')[0] ?? '').slice(0, 300);
}
