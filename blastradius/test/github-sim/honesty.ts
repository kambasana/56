/**
 * Checks that keep the simulator honest: REST bodies validated against GitHub's own OpenAPI
 * description (@octokit/openapi, pinned), and webhook payloads compared with the shapes of the
 * @octokit/webhooks-examples payloads they were built from.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Ajv, type ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';

type Json = Record<string, any>;

const require = createRequire(import.meta.url);

/** OpenAPI 3.0 `nullable: true` → JSON Schema (`anyOf` with null), recursively. */
function convertNullable(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(convertNullable);
  if (!node || typeof node !== 'object') return node;
  const out: Json = {};
  for (const [k, v] of Object.entries(node as Json)) out[k] = k === 'example' || k === 'examples' ? v : convertNullable(v);
  if (out.nullable === true) {
    delete out.nullable;
    return { anyOf: [out, { type: 'null' }] };
  }
  return out;
}

export interface OpenApi {
  spec: Json;
  /** Validator for the JSON body of `method path` answering `status`; null when the spec gives no JSON body. */
  validator(method: string, path: string, status: number): { validate: ValidateFunction | null; documented: boolean };
}

let cached: OpenApi | null = null;

/** GitHub's REST description for api.github.com from the pinned @octokit/openapi. */
export function openApi(): OpenApi {
  if (cached) return cached;
  const file = require.resolve('@octokit/openapi/generated/api.github.com.json');
  const spec = JSON.parse(readFileSync(file, 'utf8')) as Json;
  const ajv = new Ajv({ strict: false, allErrors: true, validateSchema: false, logger: false });
  const addFormats = (addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ?? addFormatsModule;
  (addFormats as unknown as (a: Ajv) => void)(ajv);
  ajv.addSchema({ $id: 'gh.json', components: convertNullable(spec.components) as Json, paths: convertNullable(spec.paths) as Json });
  const compiled = new Map<string, { validate: ValidateFunction | null; documented: boolean }>();
  const ptr = (s: string) => s.replace(/~/g, '~0').replace(/\//g, '~1');
  cached = {
    spec,
    validator(method, path, status) {
      const key = `${method} ${path} ${status}`;
      const hit = compiled.get(key);
      if (hit) return hit;
      const op = spec.paths[path]?.[method.toLowerCase()];
      let resp = op?.responses?.[String(status)];
      let out: { validate: ValidateFunction | null; documented: boolean };
      if (!resp) out = { validate: null, documented: false };
      else {
        let respPtr = `gh.json#/paths/${ptr(path)}/${method.toLowerCase()}/responses/${status}`;
        if (resp.$ref) {
          const name = String(resp.$ref).split('/').pop()!;
          resp = spec.components.responses[name];
          respPtr = `gh.json#/components/responses/${ptr(name)}`;
        }
        const hasJson = Boolean(resp?.content?.['application/json']?.schema);
        out = { validate: hasJson ? ajv.compile({ $ref: `${respPtr}/content/application~1json/schema` }) : null, documented: true };
      }
      compiled.set(key, out);
      return out;
    },
  };
  return cached;
}

/** Maps whose keys depend on the App or repo, not on the event: compared as objects only. */
const FREE_FORM = new Set(['permissions', 'custom_properties']);

/**
 * Differences between `actual` and the `example` it should look like: every key of the example
 * must be present with the same JSON type (null matches anything, as GitHub nulls optional
 * objects). Arrays are compared through their first element.
 */
export function shapeDiff(example: unknown, actual: unknown, path = '$'): string[] {
  if (FREE_FORM.has(path.slice(path.lastIndexOf('.') + 1)) && example && actual && typeof example === 'object' && typeof actual === 'object') return [];
  const t = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
  if (example === null || actual === null || example === undefined) return [];
  if (t(example) !== t(actual)) return [`${path}: ${t(actual)} where the example has ${t(example)}`];
  if (Array.isArray(example)) {
    const a = actual as unknown[];
    return example.length && a.length ? shapeDiff(example[0], a[0], `${path}[0]`) : [];
  }
  if (typeof example === 'object') {
    const out: string[] = [];
    for (const [k, v] of Object.entries(example as Json)) {
      if (!(k in (actual as Json))) out.push(`${path}.${k}: missing`);
      else out.push(...shapeDiff(v, (actual as Json)[k], `${path}.${k}`));
    }
    return out;
  }
  return [];
}
