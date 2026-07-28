/**
 * Source text of the untrusted sandbox runner.
 *
 * IMPORTANT: nothing in this file is executed by the trusted process. The
 * exported strings are plain data that get written into a Deno Sandbox and run
 * there. `PROGRAM_CORE` is kept separate from the bootstrap so unit tests can
 * exercise the pure evaluation logic in isolation without a sandbox, a network
 * or a subprocess (see `tests/google-fonts/program_test.ts`).
 *
 * Keep the program dependency-free, ES5-ish and free of template literals so it
 * can live safely inside a `String.raw` literal.
 */

/** Frames the result so stray guest writes to stdout cannot be mistaken for it. */
export const RESULT_SENTINEL = "\u0000<TRMNL-RESULT>\u0000";

/** Pure evaluation logic. Defines `evaluateProgram(input)`. */
export const PROGRAM_CORE = String.raw`
"use strict";

var __EVAL = new Function(
  "f",
  "index",
  "array",
  "__src",
  // A direct eval keeps the completion-value semantics of the original
  // browser-side plugin, so expressions such as "1" or
  // "f.axes?.length > 0" behave identically.
  "return eval(__src);"
);

function __describe(err) {
  var text;
  try {
    if (err instanceof Error) {
      text = String(err.name) + ": " + String(err.message);
    } else if (err === null) {
      text = "null";
    } else if (typeof err === "object") {
      text = "thrown object";
    } else {
      text = typeof err + " " + String(err);
    }
  } catch (_ignored) {
    text = "unrepresentable value";
  }
  text = text.replace(/[\r\n\t]+/g, " ");
  if (text.length > 200) text = text.slice(0, 200) + "...";
  return text;
}

function __fail(code, message) {
  return { ok: false, error: { code: code, message: message } };
}

function __evalRules(rules, candidates, fonts, deadline, label) {
  var matches = [];
  for (var r = 0; r < rules.length; r++) {
    var expr = rules[r];
    var hits = [];
    for (var c = 0; c < candidates.length; c++) {
      if ((c & 63) === 0 && Date.now() > deadline) {
        return {
          failure: __fail(
            "evaluation_failed",
            "override evaluation exceeded the time budget"
          ),
        };
      }
      var index = candidates[c];
      var matched;
      try {
        matched = __EVAL(fonts[index], index, fonts, expr);
      } catch (err) {
        return {
          failure: __fail(
            "invalid_override",
            label + " override condition #" + (r + 1) + " failed: " + __describe(err)
          ),
        };
      }
      if (matched) hits.push(index);
    }
    matches.push(hits);
  }
  return { matches: matches };
}

function evaluateProgram(input) {
  var fonts = (input && input.fonts) || [];
  var filter = input && typeof input.filter === "string" ? input.filter : "";
  var large = (input && input.large) || [];
  var small = (input && input.small) || [];
  var budget = input && typeof input.softDeadlineMs === "number"
    ? input.softDeadlineMs
    : 10000;
  var deadline = Date.now() + budget;

  var candidates = [];
  var i;
  var n = fonts.length;

  if (filter.trim() === "") {
    for (i = 0; i < n; i++) candidates.push(i);
  } else {
    for (i = 0; i < n; i++) {
      if ((i & 63) === 0 && Date.now() > deadline) {
        return __fail(
          "evaluation_failed",
          "filter evaluation exceeded the time budget"
        );
      }
      var keep;
      try {
        keep = __EVAL(fonts[i], i, fonts, filter);
      } catch (err) {
        return __fail(
          "invalid_filter",
          "filter expression failed: " + __describe(err)
        );
      }
      if (keep) candidates.push(i);
    }
  }

  var largeResult = __evalRules(large, candidates, fonts, deadline, "large");
  if (largeResult.failure) return largeResult.failure;
  var smallResult = __evalRules(small, candidates, fonts, deadline, "small");
  if (smallResult.failure) return smallResult.failure;

  return {
    ok: true,
    candidates: candidates,
    large: largeResult.matches,
    small: smallResult.matches,
  };
}
`;

/**
 * Bootstrap appended after `PROGRAM_CORE` to produce the file uploaded into the
 * sandbox. It reads the input file passed as `Deno.args[0]`, silences guest
 * console output, drops the `Deno` global before any untrusted expression runs,
 * and emits a single sentinel-framed JSON document on stdout.
 */
export const PROGRAM_BOOTSTRAP = String.raw`
(function () {
  var encoder = new TextEncoder();
  var writeSync = Deno.stdout.writeSync.bind(Deno.stdout);
  var readTextFileSync = Deno.readTextFileSync;
  var exit = Deno.exit.bind(Deno);
  var sentinel = "\u0000<TRMNL-RESULT>\u0000";

  var input;
  try {
    input = JSON.parse(readTextFileSync(Deno.args[0]));
  } catch (_err) {
    writeSync(
      encoder.encode(
        sentinel +
          JSON.stringify({
            ok: false,
            error: { code: "evaluation_failed", message: "runner input unreadable" },
          })
      )
    );
    exit(0);
    return;
  }

  var maxOutputBytes = typeof input.maxOutputBytes === "number"
    ? input.maxOutputBytes
    : 2097152;

  // Reduce the guest surface before any untrusted expression is evaluated.
  var noop = function () {};
  for (var key in globalThis.console) {
    if (typeof globalThis.console[key] === "function") {
      globalThis.console[key] = noop;
    }
  }
  try {
    delete globalThis.Deno;
  } catch (_ignored) {
    globalThis.Deno = undefined;
  }

  var out;
  try {
    out = evaluateProgram(input);
  } catch (err) {
    out = {
      ok: false,
      error: { code: "evaluation_failed", message: "runner failure" },
    };
  }

  var text;
  try {
    text = JSON.stringify(out);
  } catch (_err) {
    text = null;
  }
  if (typeof text !== "string" || text.length > maxOutputBytes) {
    text = JSON.stringify({
      ok: false,
      error: {
        code: "evaluation_failed",
        message: "evaluation output exceeded the size limit",
      },
    });
  }

  writeSync(encoder.encode(sentinel + text));
  exit(0);
})();
`;

/** The complete file written into the sandbox. */
export const RUNNER_SOURCE = `${PROGRAM_CORE}\n${PROGRAM_BOOTSTRAP}\n`;
