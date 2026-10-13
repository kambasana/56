/**
 * API errors (docs/WEB-API.md "Errors"). Every non-2xx response is an `ApiError` body.
 * Messages are safe for clients: no stack traces, file system paths or secrets.
 */
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { ERROR_STATUS, type ApiError, type ApiErrorCode } from './api-types.js';
import { isStoreError } from './store/index.js';

export class ApiHttpError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly fields?: string[],
  ) {
    super(message);
    this.name = 'ApiHttpError';
  }
}

export const badRequest = (message: string, fields?: string[]) => new ApiHttpError('bad_request', message, fields);
export const forbidden = (message: string) => new ApiHttpError('forbidden', message);
export const notFound = (message = 'Not found') => new ApiHttpError('not_found', message);
export const conflict = (message: string) => new ApiHttpError('conflict', message);
export const unauthenticated = (message = 'Sign in required') => new ApiHttpError('unauthenticated', message);

export function errorBody(code: ApiErrorCode, message: string, fields?: string[]): ApiError {
  return { error: fields && fields.length > 0 ? { code, message, fields } : { code, message } };
}

export function errorResponse(c: Context, code: ApiErrorCode, message: string, fields?: string[]): Response {
  return c.json(errorBody(code, message, fields), ERROR_STATUS[code] as ContentfulStatusCode);
}

/** Map any thrown value to an ApiError response. Unknown errors are logged and answered generically. */
export function toErrorResponse(c: Context, err: unknown, log: (m: string) => void): Response {
  if (err instanceof ApiHttpError) return errorResponse(c, err.code, err.message, err.fields);
  if (isStoreError(err)) return errorResponse(c, err.code, err.message, err.fields);
  if (err instanceof z.ZodError) return errorResponse(c, 'bad_request', 'Invalid request', zodFields(err));
  log(`internal error on ${c.req.method} ${new URL(c.req.url).pathname}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  return errorResponse(c, 'internal', 'Internal server error');
}

export function zodFields(err: z.ZodError): string[] {
  const out = new Set<string>();
  for (const issue of err.issues) {
    const path = issue.path.map((p, i) => (typeof p === 'number' ? `[${p}]` : i === 0 ? String(p) : `.${String(p)}`)).join('');
    if (issue.code === 'unrecognized_keys') {
      for (const k of issue.keys) out.add(path ? `${path}.${k}` : k);
    } else {
      out.add(path || '(body)');
    }
  }
  return [...out];
}
