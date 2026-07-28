import { assertEquals } from "@std/assert";
import { createRouter } from "../src/index.ts";
import { ApiError, ErrorCode } from "../src/http.ts";
import { RateLimiter } from "../src/rate-limit.ts";

function router(
  handler: (request: Request) => Promise<Response> = () =>
    Promise.resolve(
      new Response(`{"ok":true}`, { headers: { "content-type": "application/json" } }),
    ),
  rateLimiter = new RateLimiter({ limit: 1000 }),
) {
  return createRouter({ googleFonts: handler }, { rateLimiter });
}

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`https://api.test${path}`, init);
}

Deno.test("healthz responds ok", async () => {
  const response = await router()(req("/healthz"));
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { status: "ok" });
});

Deno.test("unknown routes return 404 with the error envelope", async () => {
  const response = await router()(req("/nope"));
  assertEquals(response.status, 404);
  const body = await response.json();
  assertEquals(body.error.code, ErrorCode.NOT_FOUND);
});

Deno.test("wrong method on /google-fonts returns 405 with Allow", async () => {
  const response = await router()(req("/google-fonts"));
  assertEquals(response.status, 405);
  assertEquals(response.headers.get("allow"), "POST");
  assertEquals((await response.json()).error.code, ErrorCode.METHOD_NOT_ALLOWED);
});

Deno.test("wrong method on /healthz returns 405", async () => {
  const response = await router()(req("/healthz", { method: "POST" }));
  assertEquals(response.status, 405);
  assertEquals(response.headers.get("allow"), "GET, HEAD");
});

Deno.test("trailing slashes are normalised", async () => {
  assertEquals((await router()(req("/healthz/"))).status, 200);
});

Deno.test("POST /google-fonts reaches the handler", async () => {
  const response = await router()(req("/google-fonts", { method: "POST" }));
  assertEquals(response.status, 200);
});

Deno.test("ApiError thrown by the handler becomes a JSON envelope", async () => {
  const response = await router(() =>
    Promise.reject(new ApiError(422, ErrorCode.INVALID_FILTER, "bad filter"))
  )(req("/google-fonts", { method: "POST" }));
  assertEquals(response.status, 422);
  assertEquals(await response.json(), { error: { code: "invalid_filter", message: "bad filter" } });
});

Deno.test("unexpected errors do not leak internals", async () => {
  const response = await router(() => Promise.reject(new Error("/srv/secret/path exploded")))(
    req("/google-fonts", { method: "POST" }),
  );
  assertEquals(response.status, 500);
  const text = await response.text();
  assertEquals(text.includes("secret"), false);
  assertEquals(JSON.parse(text).error.code, ErrorCode.INTERNAL);
});

Deno.test("rate limiting returns 429 with Retry-After", async () => {
  const route = router(undefined, new RateLimiter({ limit: 1 }));
  const first = await route(req("/google-fonts", { method: "POST" }), "10.0.0.1");
  assertEquals(first.status, 200);
  const second = await route(req("/google-fonts", { method: "POST" }), "10.0.0.1");
  assertEquals(second.status, 429);
  assertEquals(typeof second.headers.get("retry-after"), "string");
  assertEquals((await second.json()).error.code, ErrorCode.RATE_LIMITED);
});

Deno.test("rate limiting is per client", async () => {
  const route = router(undefined, new RateLimiter({ limit: 1 }));
  await route(req("/google-fonts", { method: "POST" }), "10.0.0.1");
  const other = await route(
    new Request("https://api.test/google-fonts", {
      method: "POST",
      headers: { "x-forwarded-for": "10.0.0.2, 172.16.0.1" },
    }),
  );
  assertEquals(other.status, 200);
});
