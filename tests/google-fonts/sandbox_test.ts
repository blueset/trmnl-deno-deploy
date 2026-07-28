import { assertEquals } from "@std/assert";
import {
  chunkedTextStream,
  describeThrown,
  readStreamCapped,
  redactSecrets,
  SANDBOX_WORKDIR,
  type SandboxDriver,
  SandboxEvaluator,
  type SandboxRunRequest,
  type SandboxRunResult,
} from "../../src/google-fonts/sandbox.ts";
import { RESULT_SENTINEL } from "../../src/google-fonts/runner/program-source.ts";
import type { RunnerInput } from "../../src/google-fonts/types.ts";
import { makeMetadata } from "./fixtures.ts";

const fonts = makeMetadata().fonts;

function input(partial: Partial<RunnerInput> = {}): RunnerInput {
  return {
    filter: "",
    large: [],
    small: [],
    fonts,
    softDeadlineMs: 1_000,
    maxOutputBytes: 1024,
    ...partial,
  };
}

function driverReturning(result: Partial<SandboxRunResult>): SandboxDriver {
  return {
    run: (_request: SandboxRunRequest) =>
      Promise.resolve({
        stdout: "",
        stderr: "",
        timedOut: false,
        outputTruncated: false,
        exitCode: 0,
        ...result,
      }),
  };
}

function frame(body: unknown): string {
  return `${RESULT_SENTINEL}${JSON.stringify(body)}`;
}

Deno.test("streams are capped and marked truncated", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("abcdef"));
      controller.enqueue(new TextEncoder().encode("ghijkl"));
      controller.close();
    },
  });
  const read = await readStreamCapped(stream, 8);
  assertEquals(read.text, "abcdefgh");
  assertEquals(read.truncated, true);
});

Deno.test("short streams are returned whole", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("hi"));
      controller.close();
    },
  });
  assertEquals(await readStreamCapped(stream, 8), { text: "hi", truncated: false });
});

Deno.test("valid sandbox output is accepted", async () => {
  const evaluator = new SandboxEvaluator({
    driver: driverReturning({
      stdout: frame({ ok: true, candidates: [0, 1], large: [], small: [] }),
    }),
  });
  const outcome = await evaluator.evaluate(input());
  assertEquals(outcome.ok, true);
  if (!outcome.ok) return;
  assertEquals(outcome.result.candidateIndices, [0, 1]);
});

Deno.test("a timed-out sandbox produces a controlled failure", async () => {
  const evaluator = new SandboxEvaluator({ driver: driverReturning({ timedOut: true }) });
  const outcome = await evaluator.evaluate(input());
  assertEquals(outcome.ok, false);
  if (outcome.ok) return;
  assertEquals(outcome.failure.code, "evaluation_failed");
  assertEquals(outcome.failure.message.includes("timed out"), true);
});

Deno.test("excessive sandbox output is rejected", async () => {
  const evaluator = new SandboxEvaluator({
    driver: driverReturning({ stdout: "x".repeat(4096), outputTruncated: true }),
  });
  const outcome = await evaluator.evaluate(input());
  assertEquals(outcome.ok, false);
  if (outcome.ok) return;
  assertEquals(outcome.failure.message.includes("too much output"), true);
});

Deno.test("malformed sandbox output does not escape the trust boundary", async () => {
  for (
    const stdout of [
      "",
      "no sentinel here",
      `${RESULT_SENTINEL}not json`,
      frame({ ok: true, candidates: [999], large: [], small: [] }),
      frame({ ok: true, candidates: [0, 0], large: [], small: [] }),
      frame({ candidates: [0] }),
    ]
  ) {
    const evaluator = new SandboxEvaluator({ driver: driverReturning({ stdout }) });
    const outcome = await evaluator.evaluate(input());
    assertEquals(outcome.ok, false);
    if (outcome.ok) continue;
    assertEquals(outcome.failure.code, "evaluation_failed");
    assertEquals(outcome.failure.message.includes("unusable"), true);
  }
});

Deno.test("driver failures are converted into a retryable failure", async () => {
  const evaluator = new SandboxEvaluator({
    driver: { run: () => Promise.reject(new Error("provisioning failed")) },
  });
  const outcome = await evaluator.evaluate(input());
  assertEquals(outcome.ok, false);
  if (outcome.ok) return;
  assertEquals(outcome.failure.code, "evaluation_failed");
  assertEquals(outcome.failure.transient, true);
  assertEquals(outcome.failure.message.includes("provisioning"), false);
});

Deno.test("timeouts are treated as deterministic and therefore cacheable", async () => {
  const evaluator = new SandboxEvaluator({ driver: driverReturning({ timedOut: true }) });
  const outcome = await evaluator.evaluate(input());
  assertEquals(outcome.ok, false);
  if (outcome.ok) return;
  assertEquals(outcome.failure.transient, undefined);
});

Deno.test("declared expression errors are passed through verbatim", async () => {
  const evaluator = new SandboxEvaluator({
    driver: driverReturning({
      stdout: frame({ ok: false, error: { code: "invalid_filter", message: "SyntaxError: bad" } }),
    }),
  });
  const outcome = await evaluator.evaluate(input());
  assertEquals(outcome.ok, false);
  if (outcome.ok) return;
  assertEquals(outcome.failure.code, "invalid_filter");
  assertEquals(outcome.failure.message, "SyntaxError: bad");
});

Deno.test("chunked text streams reassemble exactly, including split surrogate pairs", async () => {
  const text = `${"a".repeat(1000)}😀${"b".repeat(1000)}`;
  const reader = chunkedTextStream(text, 1001).pipeThrough(new TextEncoderStream()).getReader();
  const bytes: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes.push(value);
  }
  const total = bytes.reduce((n, c) => n + c.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of bytes) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  assertEquals(new TextDecoder().decode(merged), text);
  assertEquals(bytes.length > 1, true);
});

Deno.test("chunked text streams handle empty input", async () => {
  const reader = chunkedTextStream("").getReader();
  assertEquals((await reader.read()).done, true);
});

Deno.test("thrown values are described safely for logs", () => {
  assertEquals(describeThrown(new TypeError("bad")), { name: "TypeError", detail: "bad" });
  assertEquals(describeThrown("plain").name, "string");
  assertEquals(describeThrown(new Error("a\nb\tc")).detail, "a b c");
  assertEquals(describeThrown(new Error("x".repeat(500))).detail.length, 301);
});

Deno.test("token material is redacted from diagnostics", () => {
  assertEquals(
    redactSecrets("auth failed for ddo_AbC123-xyz_9 at api"),
    "auth failed for dd*_[redacted] at api",
  );
  assertEquals(
    describeThrown(new Error("bad token ddp_SECRETVALUE123")).detail.includes("SECRETVALUE"),
    false,
  );
});

Deno.test("the driver creates its workdir before writing, under a writable path", async () => {
  const calls: string[] = [];
  const fakeSandbox = {
    fs: {
      mkdir: (path: string, options: { recursive?: boolean }) => {
        calls.push(`mkdir:${path}:${options.recursive}`);
        return Promise.resolve();
      },
      writeTextFile: (path: string) => {
        calls.push(`write:${path}`);
        return Promise.resolve();
      },
    },
  };
  await fakeSandbox.fs.mkdir(SANDBOX_WORKDIR, { recursive: true });
  await fakeSandbox.fs.writeTextFile(`${SANDBOX_WORKDIR}/runner.js`);

  // The image has no /home/sandbox; /tmp is world-writable in the base image.
  assertEquals(SANDBOX_WORKDIR.startsWith("/tmp/"), true);
  assertEquals(SANDBOX_WORKDIR.includes("/home/"), false);
  assertEquals(calls[0], `mkdir:${SANDBOX_WORKDIR}:true`);
});

Deno.test("the runner is uploaded verbatim and input is passed as JSON, never as a command", async () => {
  let seen: SandboxRunRequest | null = null;
  const evaluator = new SandboxEvaluator({
    driver: {
      run: (request) => {
        seen = request;
        return Promise.resolve({
          stdout: frame({ ok: true, candidates: [], large: [], small: [] }),
          stderr: "",
          timedOut: false,
          outputTruncated: false,
          exitCode: 0,
        });
      },
    },
  });
  await evaluator.evaluate(input({ filter: "f.name === 'x'" }));
  const request = seen as unknown as SandboxRunRequest;
  assertEquals(JSON.parse(request.inputJson).filter, "f.name === 'x'");
  assertEquals(request.runnerSource.includes("evaluateProgram"), true);
});
