/**
 * Small in-memory abuse controls.
 *
 * Deno Deploy runs many isolates, so these limits are per-instance and are a
 * cheap first line of defence rather than a global guarantee. The expensive
 * work (sandbox creation) is additionally protected by a concurrency gate.
 */

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the caller may retry. Only meaningful when denied. */
  retryAfterSeconds: number;
  remaining: number;
}

/** Fixed-window counter keyed by an opaque client identifier. */
export class RateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #maxKeys: number;
  readonly #hits = new Map<string, { count: number; resetAt: number }>();

  constructor(options: { limit: number; windowMs?: number; maxKeys?: number }) {
    this.#limit = Math.max(1, options.limit);
    this.#windowMs = options.windowMs ?? 60_000;
    this.#maxKeys = options.maxKeys ?? 10_000;
  }

  check(key: string, now: number = Date.now()): RateLimitDecision {
    const existing = this.#hits.get(key);
    if (!existing || existing.resetAt <= now) {
      if (this.#hits.size >= this.#maxKeys) this.#evict(now);
      this.#hits.set(key, { count: 1, resetAt: now + this.#windowMs });
      return { allowed: true, retryAfterSeconds: 0, remaining: this.#limit - 1 };
    }
    if (existing.count >= this.#limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
        remaining: 0,
      };
    }
    existing.count += 1;
    return {
      allowed: true,
      retryAfterSeconds: 0,
      remaining: this.#limit - existing.count,
    };
  }

  #evict(now: number): void {
    for (const [key, value] of this.#hits) {
      if (value.resetAt <= now) this.#hits.delete(key);
    }
    if (this.#hits.size >= this.#maxKeys) this.#hits.clear();
  }
}

/** Bounded concurrency gate. Rejects immediately when saturated. */
export class ConcurrencyGate {
  #active = 0;
  readonly #limit: number;

  constructor(limit: number) {
    this.#limit = Math.max(1, limit);
  }

  get active(): number {
    return this.#active;
  }

  tryAcquire(): (() => void) | null {
    if (this.#active >= this.#limit) return null;
    this.#active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active -= 1;
    };
  }
}

/**
 * Derives a stable, opaque rate-limit key for a request. Prefers the left-most
 * `x-forwarded-for` hop, then `cf-connecting-ip`, then the socket address
 * supplied by the server.
 */
export function clientKey(request: Request, remoteAddr?: string): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("cf-connecting-ip") ?? remoteAddr ?? "unknown";
}
