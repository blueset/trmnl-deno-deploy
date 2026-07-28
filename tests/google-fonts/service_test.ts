import { assertEquals, assertRejects } from "@std/assert";
import { ApiError } from "../../src/http.ts";
import { FilterResultCache, MemoryBodyStore, MemoryKv } from "../../src/google-fonts/cache.ts";
import { MetadataService } from "../../src/google-fonts/metadata.ts";
import {
  GoogleFontsService,
  resolveOverride,
  resolveSampleText,
} from "../../src/google-fonts/index.ts";
import type {
  EvaluationOutcome,
  Evaluator,
  GoogleFontsResponse,
  RunnerInput,
} from "../../src/google-fonts/types.ts";
import { makeMetadata, metadataJson } from "./fixtures.ts";

const URL_ = "https://metadata.test/metadata.json";

class RecordingEvaluator implements Evaluator {
  calls = 0;
  lastInput: RunnerInput | null = null;
  constructor(private readonly outcome: EvaluationOutcome) {}
  evaluate(input: RunnerInput): Promise<EvaluationOutcome> {
    this.calls += 1;
    this.lastInput = input;
    return Promise.resolve(this.outcome);
  }
}

function makeService(evaluator: Evaluator, random = () => 0) {
  const kv = new MemoryKv();
  const metadata = new MetadataService({
    url: URL_,
    kv,
    bodyStore: new MemoryBodyStore(),
    fetchImpl: (() =>
      Promise.resolve(
        new Response(metadataJson(), { status: 200, headers: { etag: `"v1"` } }),
      )) as typeof fetch,
  });
  return new GoogleFontsService({
    metadata,
    filterCache: new FilterResultCache(kv),
    evaluator,
    random,
  });
}

function post(body: unknown): Request {
  return new Request("https://api.test/google-fonts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

Deno.test("resolveSampleText prefers the font's own sample text", () => {
  const data = makeMetadata();
  assertEquals(resolveSampleText(data, data.fonts[3]!), {
    styles: "愛のあるユニークで豊かな書体",
  });
});

Deno.test("resolveSampleText falls back to the primary language bundle", () => {
  const data = makeMetadata();
  assertEquals(resolveSampleText(data, data.fonts[2]!), data.sample_texts.ru_Cyrl!.sample_text![0]);
});

Deno.test("resolveSampleText falls back to en_Latn", () => {
  const data = makeMetadata();
  assertEquals(resolveSampleText(data, data.fonts[4]!), data.sample_texts.en_Latn!.sample_text![0]);
});

Deno.test("resolveSampleText raises a controlled error when the fallback is missing", () => {
  const data = makeMetadata();
  delete data.sample_texts.en_Latn;
  try {
    resolveSampleText(data, data.fonts[4]!);
    throw new Error("expected a failure");
  } catch (error) {
    assertEquals(error instanceof ApiError, true);
    assertEquals((error as ApiError).code, "metadata_incomplete");
  }
});

Deno.test("later override rules win over earlier ones", () => {
  const rules: Array<[string, string]> = [["a", "first"], ["b", "second"], ["c", "third"]];
  assertEquals(resolveOverride(rules, [[1], [1], [2]], 1), "second");
  assertEquals(resolveOverride(rules, [[1], [], []], 1), "first");
  assertEquals(resolveOverride(rules, [[], [], []], 1), null);
});

Deno.test("a successful request returns a resolved payload", async () => {
  const evaluator = new RecordingEvaluator({
    ok: true,
    result: {
      candidateIndices: [2, 3],
      largeOverrideMatches: [[2, 3], [3]],
      smallOverrideMatches: [],
    },
  });
  const service = makeService(evaluator);
  const response = await service.handle(post({
    filter: "f.axes?.length > 0",
    override: { large: [["1", "first"], ["f.primary_script === 'Jpan'", "second"]] },
  }));

  assertEquals(response.status, 200);
  assertEquals(response.headers.get("cache-control"), "no-store, max-age=0");
  assertEquals(response.headers.get("x-filter-cache"), "miss");
  assertEquals(response.headers.get("x-candidate-count"), "2");
  assertEquals(typeof response.headers.get("etag"), "string");

  const body = await response.json() as GoogleFontsResponse;
  assertEquals(body.font.name, "Gamma Cyrillic");
  assertEquals(body.script, { name: "Cyrillic" });
  assertEquals(body.axes, makeMetadata().axes);
  assertEquals(body.sampleOverrides.large, "first");
  assertEquals(body.sampleOverrides.small, null);
  assertEquals(body.errors, []);
  assertEquals(body.metadataVersion, response.headers.get("x-metadata-version"));
});

Deno.test("override precedence follows the selected font", async () => {
  const evaluator = new RecordingEvaluator({
    ok: true,
    result: {
      candidateIndices: [2, 3],
      largeOverrideMatches: [[2, 3], [3]],
      smallOverrideMatches: [],
    },
  });
  // random() -> 0.9 selects the second candidate (index 3).
  const service = makeService(evaluator, () => 0.9);
  const response = await service.handle(post({
    override: { large: [["1", "first"], ["f.primary_script === 'Jpan'", "second"]] },
  }));
  const body = await response.json() as GoogleFontsResponse;
  assertEquals(body.font.name, "Delta Japanese");
  assertEquals(body.sampleOverrides.large, "second");
});

Deno.test("only the condition strings are sent to the evaluator", async () => {
  const evaluator = new RecordingEvaluator({
    ok: true,
    result: { candidateIndices: [0], largeOverrideMatches: [[0]], smallOverrideMatches: [] },
  });
  const service = makeService(evaluator);
  await service.handle(post({ override: { large: [["1", "OVERRIDE-TEXT"]] } }));
  assertEquals(evaluator.lastInput?.large, ["1"]);
  assertEquals(JSON.stringify(evaluator.lastInput).includes("OVERRIDE-TEXT"), false);
});

Deno.test("repeated identical requests reuse the cached evaluation", async () => {
  const evaluator = new RecordingEvaluator({
    ok: true,
    result: { candidateIndices: [0, 1], largeOverrideMatches: [], smallOverrideMatches: [] },
  });
  const service = makeService(evaluator);
  const first = await service.handle(post({ filter: "1" }));
  const second = await service.handle(post({ filter: "1" }));
  assertEquals(evaluator.calls, 1);
  assertEquals(first.headers.get("x-filter-cache"), "miss");
  assertEquals(second.headers.get("x-filter-cache"), "hit");
});

Deno.test("a different filter is a cache miss", async () => {
  const evaluator = new RecordingEvaluator({
    ok: true,
    result: { candidateIndices: [0], largeOverrideMatches: [], smallOverrideMatches: [] },
  });
  const service = makeService(evaluator);
  await service.handle(post({ filter: "1" }));
  const second = await service.handle(post({ filter: "2" }));
  assertEquals(evaluator.calls, 2);
  assertEquals(second.headers.get("x-filter-cache"), "miss");
});

Deno.test("an empty candidate set returns 422", async () => {
  const service = makeService(
    new RecordingEvaluator({
      ok: true,
      result: { candidateIndices: [], largeOverrideMatches: [], smallOverrideMatches: [] },
    }),
  );
  const error = await assertRejects(() => service.handle(post({ filter: "false" })), ApiError);
  assertEquals(error.status, 422);
  assertEquals(error.code, "no_font_matched");
});

Deno.test("an invalid filter surfaces as a 422 validation error", async () => {
  const service = makeService(
    new RecordingEvaluator({
      ok: false,
      failure: { code: "invalid_filter", message: "SyntaxError: bad" },
    }),
  );
  const error = await assertRejects(() => service.handle(post({ filter: "f..." })), ApiError);
  assertEquals(error.status, 422);
  assertEquals(error.code, "invalid_filter");
});

Deno.test("a failing override condition surfaces as a 422 validation error", async () => {
  const service = makeService(
    new RecordingEvaluator({
      ok: false,
      failure: { code: "invalid_override", message: "large override condition #1 failed" },
    }),
  );
  const error = await assertRejects(
    () => service.handle(post({ override: { large: [["f.x.y", "t"]] } })),
    ApiError,
  );
  assertEquals(error.code, "invalid_override");
});

Deno.test("sandbox timeouts surface as a controlled 422", async () => {
  const service = makeService(
    new RecordingEvaluator({
      ok: false,
      failure: { code: "evaluation_failed", message: "Expression evaluation timed out." },
    }),
  );
  const error = await assertRejects(() => service.handle(post({ filter: "while(1){}" })), ApiError);
  assertEquals(error.code, "evaluation_failed");
});

Deno.test("transient evaluation failures return 503 and are not cached", async () => {
  const evaluator = new RecordingEvaluator({
    ok: false,
    failure: { code: "evaluation_failed", message: "temporarily unavailable", transient: true },
  });
  const service = makeService(evaluator);
  const error = await assertRejects(() => service.handle(post({ filter: "1" })), ApiError);
  assertEquals(error.status, 503);
  await assertRejects(() => service.handle(post({ filter: "1" })), ApiError);
  assertEquals(evaluator.calls, 2);
});

Deno.test("stale metadata is reported in the errors array", async () => {
  const kv = new MemoryKv();
  const bodyStore = new MemoryBodyStore();
  let now = 1_000;
  let call = 0;
  const metadata = new MetadataService({
    url: URL_,
    kv,
    bodyStore,
    revalidateIntervalMs: 1_000,
    now: () => now,
    fetchImpl: (() => {
      call += 1;
      if (call === 1) {
        return Promise.resolve(
          new Response(metadataJson(), { status: 200, headers: { etag: `"v1"` } }),
        );
      }
      return Promise.reject(new TypeError("down"));
    }) as typeof fetch,
  });
  const service = new GoogleFontsService({
    metadata,
    filterCache: new FilterResultCache(kv),
    evaluator: new RecordingEvaluator({
      ok: true,
      result: { candidateIndices: [0], largeOverrideMatches: [], smallOverrideMatches: [] },
    }),
    random: () => 0,
  });

  await service.handle(post({}));
  now = 50_000;
  const response = await service.handle(post({}));
  const body = await response.json() as GoogleFontsResponse;
  assertEquals(response.headers.get("x-metadata-cache"), "stale");
  assertEquals(body.errors.length, 1);
});
