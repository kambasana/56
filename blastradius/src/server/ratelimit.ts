/** Fixed-window in-memory rate limiter (single process). */
export class RateLimiter {
  private readonly hits = new Map<string, { start: number; n: number }>();

  constructor(
    readonly max: number,
    readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Count one hit; false when the key is over its limit. */
  hit(key: string): boolean {
    const t = this.now();
    const h = this.hits.get(key);
    if (!h || t - h.start >= this.windowMs) {
      this.hits.set(key, { start: t, n: 1 });
      this.prune(t);
      return true;
    }
    h.n++;
    return h.n <= this.max;
  }

  /** True when the key is already over its limit (does not count). */
  blocked(key: string): boolean {
    const h = this.hits.get(key);
    return h !== undefined && this.now() - h.start < this.windowMs && h.n >= this.max;
  }

  /** Give back one counted hit (e.g. an attempt that turned out to succeed). */
  release(key: string): void {
    const h = this.hits.get(key);
    if (h && h.n > 0) h.n--;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  private prune(t: number): void {
    if (this.hits.size < 10_000) return;
    for (const [k, h] of this.hits) if (t - h.start >= this.windowMs) this.hits.delete(k);
  }
}

/**
 * Caps concurrent expensive work (password hashing). Up to `max` run at once and up to `queue`
 * wait; beyond that acquire() returns null and the caller should refuse the request.
 */
export class ConcurrencyGate {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    readonly max: number,
    readonly queue: number,
  ) {}

  async acquire(): Promise<(() => void) | null> {
    if (this.active >= this.max) {
      if (this.waiting.length >= this.queue) return null;
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active++;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    };
  }
}
