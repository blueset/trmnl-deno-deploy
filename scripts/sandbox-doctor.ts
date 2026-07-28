/**
 * Sandbox doctor — diagnoses Deno Sandbox connectivity outside the request path.
 *
 * Runs the *real* driver against a tiny font array and prints the raw failure,
 * which the service deliberately hides from HTTP clients. Use it to tell a
 * configuration problem apart from a platform or driver problem.
 *
 *   deno task doctor
 *
 * Requires DENO_DEPLOY_TOKEN (and DENO_DEPLOY_ORG for a ddp_ token).
 * Nothing is written to disk and the token itself is never printed.
 */

import { DenoSandboxDriver, describeThrown, redactSecrets } from "../src/google-fonts/sandbox.ts";
import { RESULT_SENTINEL, RUNNER_SOURCE } from "../src/google-fonts/runner/program-source.ts";

const token = Deno.env.get("DENO_DEPLOY_TOKEN") ?? "";
const org = Deno.env.get("DENO_DEPLOY_ORG") ?? "";

console.log("— configuration —");
console.log(`  DENO_DEPLOY_TOKEN : ${token ? `set (${token.slice(0, 4)}…)` : "MISSING"}`);
console.log(`  DENO_DEPLOY_ORG   : ${org ? "set" : "unset"}`);
if (token && !token.startsWith("ddo_") && !org) {
  console.log("  ! a non-organization token also requires DENO_DEPLOY_ORG");
}
if (!token) {
  console.error("\nCannot continue without DENO_DEPLOY_TOKEN.");
  Deno.exit(1);
}

const fonts = [
  { name: "Alpha", primary_language: "en_Latn", axes: [] },
  { name: "Beta", primary_language: "ru_Cyrl", axes: [{ tag: "wght" }] },
];

const input = {
  filter: "f.primary_language.endsWith('Latn')",
  large: ["f.axes?.length > 0"],
  small: [],
  fonts,
  softDeadlineMs: 5_000,
  maxOutputBytes: 1_000_000,
};

console.log("\n— provisioning sandbox —");
const startedAt = performance.now();
try {
  const result = await new DenoSandboxDriver({ memoryMb: 768, lifetime: "60s" }).run({
    runnerSource: RUNNER_SOURCE,
    inputJson: JSON.stringify(input),
    timeoutMs: 30_000,
    maxOutputBytes: 1_000_000,
  });
  const elapsed = Math.round(performance.now() - startedAt);

  console.log(`  completed in ${elapsed} ms`);
  console.log(`  exitCode        : ${result.exitCode}`);
  console.log(`  timedOut        : ${result.timedOut}`);
  console.log(`  outputTruncated : ${result.outputTruncated}`);
  console.log(`  stderr          : ${redactSecrets(result.stderr).slice(0, 800) || "(empty)"}`);

  const at = result.stdout.lastIndexOf(RESULT_SENTINEL);
  if (at === -1) {
    console.log(`  stdout (no result frame): ${JSON.stringify(result.stdout.slice(0, 800))}`);
    console.error("\nFAILED: the runner produced no result frame");
    Deno.exit(1);
  }
  console.log(`  result          : ${result.stdout.slice(at + RESULT_SENTINEL.length, at + 800)}`);
  console.log("\nOK: sandbox execution works");
} catch (error) {
  const elapsed = Math.round(performance.now() - startedAt);
  const described = describeThrown(error);
  console.error(`\nFAILED after ${elapsed} ms`);
  console.error(`  error : ${described.name}`);
  console.error(`  detail: ${described.detail}`);
  const cause = (error as { cause?: unknown }).cause;
  if (cause !== undefined) {
    const describedCause = describeThrown(cause);
    console.error(`  cause : ${describedCause.name}: ${describedCause.detail}`);
  }
  const status = (error as { status?: unknown }).status;
  if (status !== undefined) console.error(`  status: ${status}`);
  Deno.exit(1);
}
