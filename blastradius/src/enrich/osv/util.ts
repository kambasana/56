/** Small helpers local to the OSV enricher. */

/** Run `fn` over `items` with at most `limit` in flight; preserves order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Keep only http(s) URLs, trimmed and size-capped (they are untrusted). */
export function safeHttpUrl(u: unknown): string | undefined {
  if (typeof u !== 'string' || u.length === 0 || u.length > 2048) return undefined;
  try {
    const p = new URL(u);
    return p.protocol === 'https:' || p.protocol === 'http:' ? p.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Truncate untrusted free text. */
export function cap(s: unknown, n: number): string | undefined {
  if (typeof s !== 'string') return undefined;
  const t = s.trim();
  if (!t) return undefined;
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** Plausible exact registry version (excludes git/file/link specs). */
export function isExactVersion(v: string): boolean {
  return v.length > 0 && v.length <= 256 && /^v?\d+\.\d+\.\d+([-+][0-9A-Za-z.+-]*)?$/.test(v);
}
