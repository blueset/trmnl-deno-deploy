import { assertEquals, assertThrows } from "@std/assert";
import {
  decodeIndexSet,
  encodeIndexSet,
  FilterResultCache,
  MemoryKv,
  sha256Hex,
} from "../../src/google-fonts/cache.ts";
import type { EvaluationOutcome } from "../../src/google-fonts/types.ts";

Deno.test("index sets round-trip through the bitset codec", () => {
  const indices = [0, 3, 17, 2019];
  const encoded = encodeIndexSet(indices, 2020);
  assertEquals(decodeIndexSet(encoded, 2020), indices);
});

Deno.test("a full 2020-font bitset stays far below the 64 KiB KV value limit", () => {
  const all = Array.from({ length: 2020 }, (_, i) => i);
  const encoded = encodeIndexSet(all, 2020);
  assertEquals(encoded.length < 1024, true);
});

Deno.test("out-of-range indices cannot be encoded", () => {
  assertThrows(() => encodeIndexSet([5], 5), RangeError);
});

Deno.test("bitsets of the wrong length are rejected", () => {
  const encoded = encodeIndexSet([1], 16);
  assertThrows(() => decodeIndexSet(encoded, 32), RangeError);
});

Deno.test("cache keys hash their material", async () => {
  const key = await FilterResultCache.keyFor("v1", `{"filter":"f.name"}`);
  assertEquals(key.length, 64);
  assertEquals(key.includes("f.name"), false);
  assertEquals(key, await sha256Hex(`v1|v1|{"filter":"f.name"}`));
});

const success: EvaluationOutcome = {
  ok: true,
  result: {
    candidateIndices: [0, 2],
    largeOverrideMatches: [[2]],
    smallOverrideMatches: [],
  },
};

Deno.test("filter cache misses then hits", async () => {
  const cache = new FilterResultCache(new MemoryKv());
  assertEquals((await cache.get("k", "v1", 5)).status, "miss");
  await cache.set("k", "v1", 5, success);
  const hit = await cache.get("k", "v1", 5);
  assertEquals(hit.status, "hit");
  assertEquals(hit.outcome, success);
});

Deno.test("a metadata version change invalidates cached results", async () => {
  const cache = new FilterResultCache(new MemoryKv());
  await cache.set("k", "v1", 5, success);
  assertEquals((await cache.get("k", "v2", 5)).status, "miss");
});

Deno.test("a font-count change invalidates cached results", async () => {
  const cache = new FilterResultCache(new MemoryKv());
  await cache.set("k", "v1", 5, success);
  assertEquals((await cache.get("k", "v1", 6)).status, "miss");
});

Deno.test("deterministic failures are cached", async () => {
  const cache = new FilterResultCache(new MemoryKv());
  const failure: EvaluationOutcome = {
    ok: false,
    failure: { code: "invalid_filter", message: "nope" },
  };
  await cache.set("k", "v1", 5, failure);
  const hit = await cache.get("k", "v1", 5);
  assertEquals(hit.status, "hit");
  assertEquals(hit.outcome, failure);
});

Deno.test("results survive a fresh in-process cache backed by the same store", async () => {
  const kv = new MemoryKv();
  await new FilterResultCache(kv).set("k", "v1", 5, success);
  const hit = await new FilterResultCache(kv).get("k", "v1", 5);
  assertEquals(hit.status, "hit");
  assertEquals(hit.outcome, success);
});

Deno.test("expired failure entries fall back to a miss", async () => {
  const kv = new MemoryKv();
  const cache = new FilterResultCache(kv, { failureTtlMs: 1 });
  await cache.set("k", "v1", 5, { ok: false, failure: { code: "invalid_filter", message: "x" } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assertEquals((await cache.get("k", "v1", 5)).status, "miss");
});
