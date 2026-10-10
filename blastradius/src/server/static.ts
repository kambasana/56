/**
 * Static SPA serving from web/dist. Files are served only from inside the web directory
 * (after realpath), never as a directory listing. Unknown paths without a file extension
 * fall back to index.html so client-side routes work; unknown asset paths are 404.
 */
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPathInside } from '../core/paths.js';

/** blastradius/web/dist, from both src/server and dist/server. */
export const DEFAULT_WEB_DIR = fileURLToPath(new URL('../../web/dist', import.meta.url));

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

export const SPA_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";

/** A resolved file: `file` is its real path inside the web dir, `size` its byte length (from stat). */
export type StaticResult = { status: 200; file: string; size: number; type: string; cache: string } | { status: 400 | 404 };

/** Stream a resolved file's bytes (GET); HEAD needs only the StaticResult headers. */
export function staticBody(file: string): ReadableStream<Uint8Array> {
  return Readable.toWeb(createReadStream(file)) as unknown as ReadableStream<Uint8Array>;
}

/**
 * Resolve a URL pathname to a file response. Rejects encoded traversal, NUL bytes, backslashes
 * and dot segments outright (400) instead of normalising them.
 */
export async function resolveStatic(webDir: string, urlPath: string): Promise<StaticResult> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return { status: 400 };
  }
  if (!decoded.startsWith('/') || decoded.includes('\0') || decoded.includes('\\')) return { status: 400 };
  const segments = decoded.split('/').slice(1);
  if (segments.some((s) => s === '..' || s === '.')) return { status: 400 };
  if (segments.some((s) => s.startsWith('.') && s.length > 0)) return { status: 404 };

  let root: string;
  try {
    root = await realpath(webDir);
  } catch {
    return { status: 404 };
  }
  const rel = segments.join('/');
  const candidate = path.resolve(root, rel);
  if (!isPathInside(candidate, root)) return { status: 400 };

  if (rel !== '') {
    const file = await safeFile(root, candidate);
    if (file) return file;
    // Asset-looking paths (with an extension) are real 404s; routes fall back to the SPA.
    if (path.extname(segments[segments.length - 1] ?? '') !== '') return { status: 404 };
  }
  const index = await safeFile(root, path.join(root, 'index.html'));
  if (!index || index.status !== 200) return { status: 404 };
  return { ...index, cache: 'no-cache' };
}

async function safeFile(root: string, candidate: string): Promise<StaticResult | null> {
  let real: string;
  try {
    real = await realpath(candidate);
  } catch {
    return null;
  }
  if (!isPathInside(real, root)) return null;
  let size: number;
  try {
    const st = await stat(real);
    if (!st.isFile()) return null;
    size = st.size;
  } catch {
    return null;
  }
  const ext = path.extname(real).toLowerCase();
  const type = TYPES[ext] ?? 'application/octet-stream';
  const hashed = path.relative(root, real).split(path.sep)[0] === 'assets';
  return { status: 200, file: real, size, type, cache: ext === '.html' ? 'no-cache' : hashed ? 'public, max-age=31536000, immutable' : 'public, max-age=3600' };
}
