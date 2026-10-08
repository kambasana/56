/** Request parsing helpers: JSON bodies through zod (unknown keys rejected), query params. */
import { z } from 'zod';
import { badRequest, notFound } from './errors.js';
import type { Ctx } from './context.js';

/** Largest JSON body accepted (bytes). */
export const MAX_BODY_BYTES = 256 * 1024;

/**
 * Read the body as UTF-8 with a hard byte cap. The stream is read chunk by chunk and cancelled
 * as soon as the cap is passed, so a chunked body without Content-Length is never buffered whole.
 */
export async function readBodyText(c: Ctx, maxBytes = MAX_BODY_BYTES): Promise<string> {
  return new TextDecoder('utf-8', { fatal: false }).decode(await readBodyBytes(c, maxBytes));
}

/** The raw body bytes, exactly as sent (webhook signatures are computed over these), capped. */
export async function readBodyBytes(c: Ctx, maxBytes = MAX_BODY_BYTES): Promise<Buffer> {
  const declared = c.req.header('content-length');
  if (declared !== undefined && Number(declared) > maxBytes) throw badRequest('Request body too large');
  const stream = c.req.raw.body;
  if (!stream) return Buffer.alloc(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw badRequest('Request body too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

export async function readJson(c: Ctx): Promise<unknown> {
  const text = await readBodyText(c);
  if (text.trim() === '') return {};
  const type = (c.req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json') throw badRequest('Content-Type must be application/json');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw badRequest('Malformed JSON');
  }
}

export async function parseBody<S extends z.ZodType>(c: Ctx, schema: S): Promise<z.infer<S>> {
  const raw = await readJson(c);
  return schema.parse(raw);
}

export function queryString(c: Ctx, name: string, max = 500): string | undefined {
  const v = c.req.query(name);
  if (v === undefined || v === '') return undefined;
  if (v.length > max) throw badRequest(`${name} is too long`, [name]);
  return v;
}

export function queryInt(c: Ctx, name: string, min: number, max: number): number | undefined {
  const v = c.req.query(name);
  if (v === undefined || v === '') return undefined;
  if (!/^\d{1,9}$/.test(v)) throw badRequest(`${name} must be an integer`, [name]);
  const n = Number(v);
  if (n < min || n > max) throw badRequest(`${name} must be between ${min} and ${max}`, [name]);
  return n;
}

export function pageQuery(c: Ctx): { limit?: number; cursor?: string } {
  const limit = queryInt(c, 'limit', 1, 500);
  const cursor = queryString(c, 'cursor', 100);
  return { ...(limit !== undefined ? { limit } : {}), ...(cursor !== undefined ? { cursor } : {}) };
}

/** Path ids are opaque but bounded: anything odd is simply not found. */
export function idParam(c: Ctx, name: string): string {
  const v = c.req.param(name);
  if (!v || !/^[A-Za-z0-9_-]{1,100}$/.test(v)) throw notFound();
  return v;
}
