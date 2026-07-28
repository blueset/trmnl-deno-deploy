/**
 * Exercises the pure sandbox program logic.
 *
 * `PROGRAM_CORE` is plain data in the trusted build; here it is instantiated
 * with `new Function` inside the *test* process so the documented expression
 * semantics can be verified without a sandbox, a subprocess or a network.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { PROGRAM_CORE } from "../../src/google-fonts/runner/program-source.ts";
import type { FontMetadata } from "../../src/google-fonts/types.ts";
import { makeMetadata } from "./fixtures.ts";

interface ProgramInput {
  filter: string;
  large: string[];
  small: string[];
  fonts: FontMetadata[];
  softDeadlineMs: number;
  maxOutputBytes: number;
}

interface ProgramOutput {
  ok: boolean;
  candidates?: number[];
  large?: number[][];
  small?: number[][];
  error?: { code: string; message: string };
}

const evaluateProgram = new Function(
  `${PROGRAM_CORE}\nreturn evaluateProgram;`,
)() as (input: ProgramInput) => ProgramOutput;

const fonts = makeMetadata().fonts;

function run(partial: Partial<ProgramInput>): ProgramOutput {
  return evaluateProgram({
    filter: "",
    large: [],
    small: [],
    fonts,
    softDeadlineMs: 5_000,
    maxOutputBytes: 1_000_000,
    ...partial,
  });
}

Deno.test("empty filter includes every font", () => {
  const result = run({});
  assertEquals(result.ok, true);
  assertEquals(result.candidates, [0, 1, 2, 3, 4]);
});

Deno.test("whitespace-only filter includes every font", () => {
  const result = run({ filter: "   \n  " });
  assertEquals(result.candidates, [0, 1, 2, 3, 4]);
});

Deno.test("documented example: primary_language.endsWith('Latn')", () => {
  const result = run({ filter: "f.primary_language.endsWith('Latn')" });
  assertEquals(result.candidates, [0, 1]);
});

Deno.test("documented example: optional chaining with some()", () => {
  const result = run({ filter: "f.qualities?.some(q => q.quality == 'Pixel')" });
  assertEquals(result.candidates, [1]);
});

Deno.test("documented example: f.axes?.length > 0", () => {
  const result = run({ filter: "f.axes?.length > 0" });
  assertEquals(result.candidates, [2, 3]);
});

Deno.test("documented example: subsets.includes('cyrillic-ext')", () => {
  const result = run({ filter: "f.subsets.includes('cyrillic-ext')" });
  assertEquals(result.candidates, [2]);
});

Deno.test("documented example: array-wide reduce with Date", () => {
  const result = run({
    filter:
      "f == array.reduce((latest, current) => new Date(current.date_added) > new Date(latest.date_added) ? current : latest)",
  });
  assertEquals(result.candidates, [3]);
});

Deno.test("expression receives index and array", () => {
  const result = run({ filter: "index === array.length - 1" });
  assertEquals(result.candidates, [4]);
});

Deno.test("literal truthy condition selects everything", () => {
  const result = run({ filter: "1" });
  assertEquals(result.candidates, [0, 1, 2, 3, 4]);
});

Deno.test("syntactically invalid filter is reported, not thrown", () => {
  const result = run({ filter: "f...name" });
  assertEquals(result.ok, false);
  assertEquals(result.error?.code, "invalid_filter");
  assertStringIncludes(result.error!.message, "SyntaxError");
});

Deno.test("filter that throws is reported", () => {
  const result = run({ filter: "f.nope.deep" });
  assertEquals(result.ok, false);
  assertEquals(result.error?.code, "invalid_filter");
  assertStringIncludes(result.error!.message, "TypeError");
});

Deno.test("filter throwing a primitive is described safely", () => {
  const result = run({ filter: "(() => { throw 'boom' })()" });
  assertEquals(result.ok, false);
  assertStringIncludes(result.error!.message, "boom");
});

Deno.test("filter throwing an object does not leak its contents", () => {
  const result = run({ filter: "(() => { throw { secret: 1 } })()" });
  assertEquals(result.ok, false);
  assertStringIncludes(result.error!.message, "thrown object");
});

Deno.test("no matching fonts yields an empty candidate list", () => {
  const result = run({ filter: "false" });
  assertEquals(result.ok, true);
  assertEquals(result.candidates, []);
});

Deno.test("soft deadline aborts a slow filter", () => {
  const result = run({ filter: "true", softDeadlineMs: -1 });
  assertEquals(result.ok, false);
  assertEquals(result.error?.code, "evaluation_failed");
  assertStringIncludes(result.error!.message, "time budget");
});

Deno.test("override conditions are evaluated per rule over candidates", () => {
  const result = run({
    filter: "",
    large: ["f.primary_language.endsWith('Latn')", "f.axes?.length > 0"],
    small: ["1"],
  });
  assertEquals(result.ok, true);
  assertEquals(result.large, [[0, 1], [2, 3]]);
  assertEquals(result.small, [[0, 1, 2, 3, 4]]);
});

Deno.test("a failing override condition is reported with its position", () => {
  const result = run({ large: ["1", "f.missing.deep"] });
  assertEquals(result.ok, false);
  assertEquals(result.error?.code, "invalid_override");
  assertStringIncludes(result.error!.message, "large override condition #2");
});

Deno.test("override conditions only consider filtered candidates", () => {
  const result = run({ filter: "f.primary_script === 'Cyrl'", large: ["1"] });
  assertEquals(result.candidates, [2]);
  assertEquals(result.large, [[2]]);
});
