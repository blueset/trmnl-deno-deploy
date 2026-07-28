import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { ApiError } from "../../src/http.ts";
import { canonicalize, LIMITS, parseRequest, readJsonBody } from "../../src/google-fonts/schema.ts";

function jsonRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request("https://example.test/google-fonts", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

Deno.test("accepts a minimal body", () => {
  const parsed = parseRequest({});
  assertEquals(parsed.filter, "");
  assertEquals(parsed.override, { large: [], small: [] });
});

Deno.test("accepts the documented body", () => {
  const parsed = parseRequest({
    filter: "f.primary_language.endsWith('Latn')",
    override: { large: [["f.axes?.length > 0", "Variable font sample"]], small: [] },
  });
  assertEquals(parsed.filter, "f.primary_language.endsWith('Latn')");
  assertEquals(parsed.override.large, [["f.axes?.length > 0", "Variable font sample"]]);
});

Deno.test("accepts override supplied as a JSON string", () => {
  const parsed = parseRequest({
    override: JSON.stringify({ large: [["1", "Hello"]] }),
  });
  assertEquals(parsed.override.large, [["1", "Hello"]]);
  assertEquals(parsed.override.small, []);
});

Deno.test("accepts an empty override string", () => {
  assertEquals(parseRequest({ override: "" }).override, { large: [], small: [] });
});

Deno.test("rejects unknown top-level fields", () => {
  const error = assertThrows(() => parseRequest({ nope: 1 }), ApiError);
  assertEquals(error.status, 400);
  assertEquals(error.code, "invalid_request");
});

Deno.test("rejects unknown override fields", () => {
  const error = assertThrows(() => parseRequest({ override: { medium: [] } }), ApiError);
  assertEquals(error.code, "invalid_override");
});

Deno.test("rejects a non-object body", () => {
  assertThrows(() => parseRequest([1, 2]), ApiError);
  assertThrows(() => parseRequest("hello"), ApiError);
});

Deno.test("rejects a non-string filter", () => {
  assertThrows(() => parseRequest({ filter: 42 }), ApiError);
});

Deno.test("rejects an over-long expression", () => {
  const error = assertThrows(
    () => parseRequest({ filter: "a".repeat(LIMITS.maxExpressionLength + 1) }),
    ApiError,
  );
  assertEquals(error.status, 400);
});

Deno.test("rejects too many override rules", () => {
  const rules = Array.from({ length: LIMITS.maxOverrideRules + 1 }, () => ["1", "x"]);
  assertThrows(() => parseRequest({ override: { large: rules } }), ApiError);
});

Deno.test("rejects an over-long sample text", () => {
  const rules = [["1", "x".repeat(LIMITS.maxSampleTextLength + 1)]];
  assertThrows(() => parseRequest({ override: { large: rules } }), ApiError);
});

Deno.test("rejects malformed override tuples", () => {
  assertThrows(() => parseRequest({ override: { large: [["1"]] } }), ApiError);
  assertThrows(() => parseRequest({ override: { large: ["1"] } }), ApiError);
  assertThrows(() => parseRequest({ override: { large: [["1", 2]] } }), ApiError);
});

Deno.test("rejects excessive nesting", () => {
  let nested: unknown = "leaf";
  for (let i = 0; i < LIMITS.maxDepth + 2; i++) nested = [nested];
  assertThrows(() => parseRequest({ override: nested }), ApiError);
});

Deno.test("rejects NUL bytes in expressions", () => {
  assertThrows(() => parseRequest({ filter: "f\u0000" }), ApiError);
});

Deno.test("readJsonBody requires application/json", async () => {
  const error = await assertRejects(
    () =>
      readJsonBody(
        new Request("https://example.test/google-fonts", {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "{}",
        }),
      ),
    ApiError,
  );
  assertEquals(error.status, 415);
});

Deno.test("readJsonBody rejects an oversized declared length", async () => {
  const error = await assertRejects(
    () =>
      readJsonBody(
        jsonRequest("{}", { "content-length": String(LIMITS.maxBodyBytes + 1) }),
      ),
    ApiError,
  );
  assertEquals(error.status, 413);
});

Deno.test("readJsonBody rejects an oversized streamed body", async () => {
  const big = JSON.stringify({ filter: "a".repeat(LIMITS.maxBodyBytes) });
  const error = await assertRejects(() => readJsonBody(jsonRequest(big)), ApiError);
  assertEquals(error.status, 413);
});

Deno.test("readJsonBody rejects malformed JSON", async () => {
  const error = await assertRejects(() => readJsonBody(jsonRequest("{")), ApiError);
  assertEquals(error.code, "invalid_json");
});

Deno.test("readJsonBody rejects an empty body", async () => {
  const error = await assertRejects(() => readJsonBody(jsonRequest("   ")), ApiError);
  assertEquals(error.code, "invalid_json");
});

Deno.test("canonicalisation is stable and order-sensitive", () => {
  const a = canonicalize(parseRequest({ filter: "1", override: { large: [["1", "x"]] } }));
  const b = canonicalize(parseRequest({ override: { large: [["1", "x"]] }, filter: "1" }));
  const c = canonicalize(parseRequest({ filter: "1", override: { small: [["1", "x"]] } }));
  assertEquals(a, b);
  assertEquals(a === c, false);
});
