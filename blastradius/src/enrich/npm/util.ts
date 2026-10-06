/** Small helpers shared by the npm and GitHub enrichers. */

/** Run `fn` over `items` with at most `limit` in flight. */
export async function mapLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/** Error message capped for warnings (messages may echo untrusted input). */
export function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}
