import { assertEquals, assertRejects } from "@std/assert";
import { ApiError } from "../../src/http.ts";
import { MemoryBodyStore, MemoryKv } from "../../src/google-fonts/cache.ts";
import { MetadataService } from "../../src/google-fonts/metadata.ts";
import { metadataJson } from "./fixtures.ts";

const URL_ = "https://metadata.test/metadata.json";

interface FetchCall {
  ifNoneMatch: string | null;
  ifModifiedSince: string | null;
}

function harness(options: {
  responses: Array<() => Response | Promise<Response>>;
  now: () => number;
  revalidateIntervalMs?: number;
  kv?: MemoryKv;
  bodyStore?: MemoryBodyStore;
}) {
  const calls: FetchCall[] = [];
  let i = 0;
  const kv = options.kv ?? new MemoryKv();
  const bodyStore = options.bodyStore ?? new MemoryBodyStore();
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      ifNoneMatch: headers.get("if-none-match"),
      ifModifiedSince: headers.get("if-modified-since"),
    });
    const next = options.responses[Math.min(i, options.responses.length - 1)]!;
    i += 1;
    return await next();
  }) as typeof fetch;

  const service = new MetadataService({
    url: URL_,
    kv,
    bodyStore,
    fetchImpl,
    revalidateIntervalMs: options.revalidateIntervalMs ?? 86_400_000,
    now: options.now,
  });
  return { service, calls, kv, bodyStore };
}

function ok(etag: string, lastModified = "Wed, 01 Jan 2025 00:00:00 GMT"): Response {
  return new Response(metadataJson(), {
    status: 200,
    headers: { etag, "last-modified": lastModified, "content-type": "application/json" },
  });
}

Deno.test("initial cache miss fetches and parses upstream", async () => {
  const { service, calls } = harness({ responses: [() => ok(`"v1"`)], now: () => 1_000 });
  const snapshot = await service.get();
  assertEquals(snapshot.status, "refreshed");
  assertEquals(snapshot.fontCount, 5);
  assertEquals(calls.length, 1);
  assertEquals(calls[0], { ifNoneMatch: null, ifModifiedSince: null });
});

Deno.test("second read within the window is a hot hit", async () => {
  const { service, calls } = harness({ responses: [() => ok(`"v1"`)], now: () => 1_000 });
  await service.get();
  const snapshot = await service.get();
  assertEquals(snapshot.status, "hot");
  assertEquals(calls.length, 1);
});

Deno.test("a cold isolate reuses the shared body cache without contacting upstream", async () => {
  const kv = new MemoryKv();
  const bodyStore = new MemoryBodyStore();
  const first = harness({ responses: [() => ok(`"v1"`)], now: () => 1_000, kv, bodyStore });
  const initial = await first.service.get();

  const second = harness({
    responses: [() => {
      throw new Error("upstream must not be contacted");
    }],
    now: () => 2_000,
    kv,
    bodyStore,
  });
  const warm = await second.service.get();
  assertEquals(warm.status, "warm");
  assertEquals(warm.version, initial.version);
  assertEquals(second.calls.length, 0);
});

Deno.test("upstream 304 keeps the cached body and refreshes the revalidation time", async () => {
  let now = 1_000;
  const { service, calls, kv } = harness({
    responses: [() => ok(`"v1"`), () => new Response(null, { status: 304 })],
    now: () => now,
    revalidateIntervalMs: 1_000,
  });
  const first = await service.get();
  now = 10_000;
  const second = await service.get();

  assertEquals(second.status, "revalidated");
  assertEquals(second.version, first.version);
  assertEquals(calls[1], {
    ifNoneMatch: `"v1"`,
    ifModifiedSince: "Wed, 01 Jan 2025 00:00:00 GMT",
  });
  const state = await kv.get<{ revalidatedAt: number }>(["gf", "metadata", "state"]);
  assertEquals(state?.revalidatedAt, 10_000);
});

Deno.test("upstream 200 with a changed ETag replaces the metadata version", async () => {
  let now = 1_000;
  const { service } = harness({
    responses: [() => ok(`"v1"`), () => ok(`"v2"`)],
    now: () => now,
    revalidateIntervalMs: 1_000,
  });
  const first = await service.get();
  now = 10_000;
  const second = await service.get();
  assertEquals(second.status, "refreshed");
  assertEquals(second.version === first.version, false);
});

Deno.test("stale data is served when upstream fails", async () => {
  let now = 1_000;
  const { service } = harness({
    responses: [
      () => ok(`"v1"`),
      () => {
        throw new TypeError("network down");
      },
    ],
    now: () => now,
    revalidateIntervalMs: 1_000,
  });
  const first = await service.get();
  now = 10_000;
  const second = await service.get();
  assertEquals(second.status, "stale");
  assertEquals(second.version, first.version);
});

Deno.test("upstream 500 with cached data is also served stale", async () => {
  let now = 1_000;
  const { service } = harness({
    responses: [() => ok(`"v1"`), () => new Response("boom", { status: 500 })],
    now: () => now,
    revalidateIntervalMs: 1_000,
  });
  await service.get();
  now = 10_000;
  assertEquals((await service.get()).status, "stale");
});

Deno.test("upstream failure with no cached data returns a controlled 503", async () => {
  const { service } = harness({
    responses: [() => new Response("boom", { status: 502 })],
    now: () => 1_000,
  });
  const error = await assertRejects(() => service.get(), ApiError);
  assertEquals(error.status, 503);
  assertEquals(error.code, "metadata_unavailable");
});

Deno.test("structurally invalid metadata is refused", async () => {
  const { service } = harness({
    responses: [() =>
      new Response(JSON.stringify({ fonts: [] }), {
        status: 200,
        headers: { etag: `"bad"` },
      })],
    now: () => 1_000,
  });
  await assertRejects(() => service.get(), ApiError);
});

Deno.test("concurrent refreshes are deduplicated", async () => {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { service, calls } = harness({
    responses: [async () => {
      await gate;
      return ok(`"v1"`);
    }],
    now: () => 1_000,
  });

  const all = Promise.all([service.get(), service.get(), service.get()]);
  release!();
  const snapshots = await all;

  assertEquals(calls.length, 1);
  assertEquals(snapshots.map((s) => s.version).every((v) => v === snapshots[0]!.version), true);
});
