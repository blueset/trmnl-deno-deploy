import { assertEquals, assertThrows } from "@std/assert";
import {
  extractResultPayload,
  MalformedRunnerOutputError,
  parseRunnerOutput,
  type RunnerOutputLimits,
} from "../../src/google-fonts/runner.ts";
import { RESULT_SENTINEL } from "../../src/google-fonts/runner/program-source.ts";

const limits: RunnerOutputLimits = {
  fontCount: 5,
  largeRuleCount: 1,
  smallRuleCount: 0,
  maxTotalIndices: 100,
};

function frame(body: string, noise = ""): string {
  return `${noise}${RESULT_SENTINEL}${body}`;
}

Deno.test("extracts the payload after the sentinel", () => {
  assertEquals(extractResultPayload(frame(`{"ok":true}`, "guest noise\n")), `{"ok":true}`);
});

Deno.test("uses the last sentinel when the guest forges one", () => {
  const stdout = `${RESULT_SENTINEL}{"ok":false}${RESULT_SENTINEL}{"ok":true}`;
  assertEquals(extractResultPayload(stdout), `{"ok":true}`);
});

Deno.test("missing sentinel is rejected", () => {
  assertThrows(() => extractResultPayload("just noise"), MalformedRunnerOutputError);
});

Deno.test("valid output is accepted", () => {
  const outcome = parseRunnerOutput(
    `{"ok":true,"candidates":[0,2],"large":[[2]],"small":[]}`,
    limits,
  );
  assertEquals(outcome.ok, true);
  if (!outcome.ok) return;
  assertEquals(outcome.result.candidateIndices, [0, 2]);
  assertEquals(outcome.result.largeOverrideMatches, [[2]]);
  assertEquals(outcome.result.smallOverrideMatches, []);
});

Deno.test("declared failures are surfaced, not thrown", () => {
  const outcome = parseRunnerOutput(
    `{"ok":false,"error":{"code":"invalid_filter","message":"boom"}}`,
    limits,
  );
  assertEquals(outcome.ok, false);
  if (outcome.ok) return;
  assertEquals(outcome.failure.code, "invalid_filter");
  assertEquals(outcome.failure.message, "boom");
});

Deno.test("unknown failure codes collapse to evaluation_failed", () => {
  const outcome = parseRunnerOutput(`{"ok":false,"error":{"code":"pwned"}}`, limits);
  assertEquals(outcome.ok, false);
  if (outcome.ok) return;
  assertEquals(outcome.failure.code, "evaluation_failed");
});

Deno.test("non-JSON output is rejected", () => {
  assertThrows(() => parseRunnerOutput("not json", limits), MalformedRunnerOutputError);
});

Deno.test("array output is rejected", () => {
  assertThrows(() => parseRunnerOutput("[1,2,3]", limits), MalformedRunnerOutputError);
});

Deno.test("missing ok flag is rejected", () => {
  assertThrows(() => parseRunnerOutput(`{"candidates":[]}`, limits), MalformedRunnerOutputError);
});

Deno.test("out-of-range indices are rejected", () => {
  assertThrows(
    () => parseRunnerOutput(`{"ok":true,"candidates":[9],"large":[[]],"small":[]}`, limits),
    MalformedRunnerOutputError,
  );
});

Deno.test("negative and fractional indices are rejected", () => {
  assertThrows(
    () => parseRunnerOutput(`{"ok":true,"candidates":[-1],"large":[[]],"small":[]}`, limits),
    MalformedRunnerOutputError,
  );
  assertThrows(
    () => parseRunnerOutput(`{"ok":true,"candidates":[1.5],"large":[[]],"small":[]}`, limits),
    MalformedRunnerOutputError,
  );
});

Deno.test("duplicate indices are rejected", () => {
  assertThrows(
    () => parseRunnerOutput(`{"ok":true,"candidates":[1,1],"large":[[]],"small":[]}`, limits),
    MalformedRunnerOutputError,
  );
});

Deno.test("override matches outside the candidate set are rejected", () => {
  assertThrows(
    () => parseRunnerOutput(`{"ok":true,"candidates":[0],"large":[[1]],"small":[]}`, limits),
    MalformedRunnerOutputError,
  );
});

Deno.test("override match count must equal the rule count", () => {
  assertThrows(
    () => parseRunnerOutput(`{"ok":true,"candidates":[0],"large":[],"small":[]}`, limits),
    MalformedRunnerOutputError,
  );
});

Deno.test("index budget is enforced", () => {
  const candidates = Array.from({ length: 5 }, (_, i) => i);
  assertThrows(
    () =>
      parseRunnerOutput(
        JSON.stringify({ ok: true, candidates, large: [candidates], small: [] }),
        { ...limits, maxTotalIndices: 6 },
      ),
    MalformedRunnerOutputError,
  );
});
