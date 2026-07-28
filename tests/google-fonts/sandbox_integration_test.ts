/**
 * Opt-in integration test against a real Deno Sandbox.
 *
 * This test is skipped unless BOTH of the following are set:
 *
 *   DENO_SANDBOX_INTEGRATION=1
 *   DENO_DEPLOY_TOKEN=<organization access token from https://console.deno.com>
 *
 * Run it with:
 *
 *   deno task test:integration
 *
 * It provisions a real microVM, so it needs network access and consumes
 * sandbox quota. It is intentionally excluded from CI.
 */

import { assertEquals } from "@std/assert";
import { DenoSandboxDriver, SandboxEvaluator } from "../../src/google-fonts/sandbox.ts";
import { makeMetadata } from "./fixtures.ts";

const enabled = Deno.env.get("DENO_SANDBOX_INTEGRATION") === "1" &&
  Boolean(Deno.env.get("DENO_DEPLOY_TOKEN"));

const fonts = makeMetadata().fonts;

function evaluator() {
  return new SandboxEvaluator({
    driver: new DenoSandboxDriver({ memoryMb: 768, lifetime: "60s" }),
    timeoutMs: 30_000,
  });
}

Deno.test({
  name: "[integration] a real sandbox evaluates a documented filter",
  ignore: !enabled,
  fn: async () => {
    const outcome = await evaluator().evaluate({
      filter: "f.primary_language.endsWith('Latn')",
      large: ["f.axes?.length > 0"],
      small: [],
      fonts,
      softDeadlineMs: 10_000,
      maxOutputBytes: 1_000_000,
    });
    assertEquals(outcome.ok, true);
    if (!outcome.ok) return;
    assertEquals(outcome.result.candidateIndices, [0, 1]);
    assertEquals(outcome.result.largeOverrideMatches, [[]]);
  },
});

Deno.test({
  name: "[integration] a real sandbox survives an infinite loop",
  ignore: !enabled,
  fn: async () => {
    const outcome = await new SandboxEvaluator({
      driver: new DenoSandboxDriver({ memoryMb: 768, lifetime: "60s" }),
      timeoutMs: 8_000,
    }).evaluate({
      filter: "(() => { while (true) {} })()",
      large: [],
      small: [],
      fonts,
      softDeadlineMs: 60_000,
      maxOutputBytes: 1_000_000,
    });
    assertEquals(outcome.ok, false);
    if (outcome.ok) return;
    assertEquals(outcome.failure.code, "evaluation_failed");
  },
});

Deno.test({
  name: "[integration] a real sandbox has no outbound network access",
  ignore: !enabled,
  fn: async () => {
    const outcome = await evaluator().evaluate({
      filter: "fetch('https://example.com') && true",
      large: [],
      small: [],
      fonts,
      softDeadlineMs: 10_000,
      maxOutputBytes: 1_000_000,
    });
    assertEquals(outcome.ok, false);
  },
});
