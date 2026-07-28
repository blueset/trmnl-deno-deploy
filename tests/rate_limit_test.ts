import { assertEquals } from "@std/assert";
import { ConcurrencyGate, RateLimiter } from "../src/rate-limit.ts";

Deno.test("rate limiter allows up to the limit within a window", () => {
  const limiter = new RateLimiter({ limit: 3, windowMs: 1_000 });
  assertEquals(limiter.check("a", 0).allowed, true);
  assertEquals(limiter.check("a", 10).allowed, true);
  assertEquals(limiter.check("a", 20).allowed, true);
  const denied = limiter.check("a", 30);
  assertEquals(denied.allowed, false);
  assertEquals(denied.retryAfterSeconds, 1);
});

Deno.test("rate limiter resets after the window", () => {
  const limiter = new RateLimiter({ limit: 1, windowMs: 1_000 });
  assertEquals(limiter.check("a", 0).allowed, true);
  assertEquals(limiter.check("a", 500).allowed, false);
  assertEquals(limiter.check("a", 1_500).allowed, true);
});

Deno.test("concurrency gate rejects once saturated and recovers on release", () => {
  const gate = new ConcurrencyGate(2);
  const first = gate.tryAcquire();
  const second = gate.tryAcquire();
  assertEquals(first !== null, true);
  assertEquals(second !== null, true);
  assertEquals(gate.tryAcquire(), null);
  first!();
  assertEquals(gate.active, 1);
  assertEquals(gate.tryAcquire() !== null, true);
});

Deno.test("releasing twice is a no-op", () => {
  const gate = new ConcurrencyGate(1);
  const release = gate.tryAcquire()!;
  release();
  release();
  assertEquals(gate.active, 0);
});
