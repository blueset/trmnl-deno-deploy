/**
 * Deno Sandbox execution — the only place where user JavaScript ever runs.
 *
 * The trusted service never evaluates user expressions. It uploads a fixed
 * runner plus a JSON input file into an ephemeral Linux microVM, spawns a Deno
 * process with an explicit, minimal permission set, enforces a wall-clock
 * deadline and an output-byte cap, and then destroys the sandbox.
 *
 * The SDK is behind the {@linkcode SandboxDriver} interface so unit tests can
 * simulate timeouts, oversized output and malformed output without a network
 * or a live sandbox.
 */

import { logger } from "../log.ts";
import { extractResultPayload, MalformedRunnerOutputError, parseRunnerOutput } from "./runner.ts";
import { RUNNER_SOURCE } from "./runner/program-source.ts";
import type { EvaluationOutcome, Evaluator, RunnerInput } from "./types.ts";

export interface SandboxRunRequest {
  runnerSource: string;
  inputJson: string;
  /** Hard wall-clock deadline for the guest process. */
  timeoutMs: number;
  /** Maximum bytes read from guest stdout/stderr. */
  maxOutputBytes: number;
}

export interface SandboxRunResult {
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputTruncated: boolean;
  exitCode: number | null;
}

/** Executes the fixed runner somewhere isolated. */
export interface SandboxDriver {
  run(request: SandboxRunRequest): Promise<SandboxRunResult>;
}

export interface SandboxEvaluatorOptions {
  driver: SandboxDriver;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Upper bound on indices accepted back from the guest. */
  maxTotalIndices?: number;
  now?: () => number;
}

export const SANDBOX_DEFAULTS = {
  timeoutMs: 20_000,
  maxOutputBytes: 2 * 1024 * 1024,
  memoryMb: 768,
  /** Sandbox lifetime ceiling, independent of the process deadline. */
  lifetime: "60s" as const,
  maxTotalIndices: 200_000,
};

/** Reads a stream as UTF-8 text, stopping once `maxBytes` is exceeded. */
export async function readStreamCapped(
  stream: ReadableStream<Uint8Array> | null | undefined,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!stream) return { text: "", truncated: false };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > maxBytes) {
        const remaining = Math.max(0, maxBytes - total);
        if (remaining > 0) chunks.push(value.subarray(0, remaining));
        total += remaining;
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    truncated = true;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The lock is already released when the stream was cancelled.
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(merged), truncated };
}

/** Strips anything that looks like a Deno Deploy token from diagnostic text. */
export function redactSecrets(text: string): string {
  return text.replace(/dd[opw]_[A-Za-z0-9_-]+/g, "dd*_[redacted]");
}

/** Bounded, redacted description of a thrown value, for server-side logs only. */
export function describeThrown(error: unknown): { name: string; detail: string } {
  const name = error instanceof Error ? error.name : typeof error;
  let detail: string;
  try {
    detail = error instanceof Error ? error.message : String(error);
  } catch {
    detail = "unrepresentable value";
  }
  detail = redactSecrets(detail).replace(/[\r\n\t]+/g, " ");
  if (detail.length > 300) detail = `${detail.slice(0, 300)}…`;
  return { name, detail };
}

/** Composes a driver with strict validation of everything it returns. */
export class SandboxEvaluator implements Evaluator {
  readonly #driver: SandboxDriver;
  readonly #timeoutMs: number;
  readonly #maxOutputBytes: number;
  readonly #maxTotalIndices: number;
  readonly #now: () => number;

  constructor(options: SandboxEvaluatorOptions) {
    this.#driver = options.driver;
    this.#timeoutMs = options.timeoutMs ?? SANDBOX_DEFAULTS.timeoutMs;
    this.#maxOutputBytes = options.maxOutputBytes ?? SANDBOX_DEFAULTS.maxOutputBytes;
    this.#maxTotalIndices = options.maxTotalIndices ?? SANDBOX_DEFAULTS.maxTotalIndices;
    this.#now = options.now ?? Date.now;
  }

  async evaluate(input: RunnerInput): Promise<EvaluationOutcome> {
    const startedAt = this.#now();
    let result: SandboxRunResult;
    try {
      result = await this.#driver.run({
        runnerSource: RUNNER_SOURCE,
        inputJson: JSON.stringify(input),
        timeoutMs: this.#timeoutMs,
        maxOutputBytes: this.#maxOutputBytes,
      });
    } catch (error) {
      const described = describeThrown(error);
      logger.error("sandbox.execution", {
        outcome: "driver_error",
        durationMs: this.#now() - startedAt,
        reason: described.name,
        // Server-side only, bounded and token-redacted. Never returned to the
        // client, which receives the generic message below.
        detail: described.detail,
      });
      return {
        ok: false,
        failure: {
          code: "evaluation_failed",
          message: "Expression evaluation could not be completed. Please retry shortly.",
          transient: true,
        },
      };
    }

    const durationMs = this.#now() - startedAt;

    if (result.timedOut) {
      logger.warn("sandbox.execution", { outcome: "timeout", durationMs });
      return {
        ok: false,
        failure: {
          code: "evaluation_failed",
          message: "Expression evaluation timed out. Simplify the expression and try again.",
        },
      };
    }

    if (result.outputTruncated) {
      logger.warn("sandbox.execution", { outcome: "output_truncated", durationMs });
      return {
        ok: false,
        failure: {
          code: "evaluation_failed",
          message: "Expression evaluation produced too much output.",
        },
      };
    }

    try {
      const payload = extractResultPayload(result.stdout);
      const outcome = parseRunnerOutput(payload, {
        fontCount: input.fonts.length,
        largeRuleCount: input.large.length,
        smallRuleCount: input.small.length,
        maxTotalIndices: this.#maxTotalIndices,
      });
      logger.info("sandbox.execution", {
        outcome: outcome.ok ? "ok" : "expression_error",
        durationMs,
        candidates: outcome.ok ? outcome.result.candidateIndices.length : 0,
        exitCode: result.exitCode,
      });
      return outcome;
    } catch (error) {
      if (error instanceof MalformedRunnerOutputError) {
        logger.error("sandbox.execution", {
          outcome: "malformed_output",
          durationMs,
          reason: error.message,
          exitCode: result.exitCode,
        });
        return {
          ok: false,
          failure: {
            code: "evaluation_failed",
            message: "Expression evaluation returned an unusable result.",
          },
        };
      }
      throw error;
    }
  }
}

export interface DenoSandboxDriverOptions {
  memoryMb?: number;
  /** Sandbox lifetime, e.g. `"60s"`. */
  lifetime?: `${number}s` | `${number}m`;
  region?: string;
}

const WORKDIR = "/home/sandbox";
const RUNNER_PATH = `${WORKDIR}/runner.js`;
const INPUT_PATH = `${WORKDIR}/input.json`;

/**
 * Real driver backed by `@deno/sandbox`.
 *
 * Every run gets a brand-new sandbox with no outbound network, no secrets, no
 * inherited environment, the smallest supported memory allocation and a short
 * lifetime. Cleanup is unconditional.
 */
export class DenoSandboxDriver implements SandboxDriver {
  readonly #memoryMb: number;
  readonly #lifetime: `${number}s` | `${number}m`;
  readonly #region?: string;

  constructor(options: DenoSandboxDriverOptions = {}) {
    this.#memoryMb = options.memoryMb ?? SANDBOX_DEFAULTS.memoryMb;
    this.#lifetime = options.lifetime ?? SANDBOX_DEFAULTS.lifetime;
    this.#region = options.region;
  }

  async run(request: SandboxRunRequest): Promise<SandboxRunResult> {
    const { Sandbox } = await import("@deno/sandbox");
    // Passed explicitly rather than relying on the SDK's `process.env` lookup,
    // which depends on the Node compatibility shim being populated.
    const token = Deno.env.get("DENO_DEPLOY_TOKEN");
    const org = Deno.env.get("DENO_DEPLOY_ORG");
    const sandbox = await Sandbox.create({
      ...(token ? { token } : {}),
      ...(org ? { org } : {}),
      // No outbound network access whatsoever.
      allowNet: [],
      memory: `${this.#memoryMb}MiB`,
      timeout: this.#lifetime,
      env: {},
      labels: { service: "trmnl-google-fonts" },
      ...(this.#region ? { region: this.#region as never } : {}),
    });

    const abort = new AbortController();
    const deadline = setTimeout(() => abort.abort(), request.timeoutMs);
    let timedOut = false;

    try {
      await sandbox.fs.writeTextFile(RUNNER_PATH, request.runnerSource);
      await sandbox.fs.writeTextFile(INPUT_PATH, request.inputJson);

      const child = await sandbox.spawn("deno", {
        // The input path is a fixed, service-owned constant: no user input is
        // ever interpolated into a command line.
        args: [
          "run",
          "--quiet",
          "--no-config",
          "--no-lock",
          "--no-remote",
          "--no-npm",
          "--cached-only",
          "--deny-net",
          "--deny-env",
          "--deny-run",
          "--deny-ffi",
          "--deny-write",
          "--deny-sys",
          `--allow-read=${INPUT_PATH}`,
          RUNNER_PATH,
          INPUT_PATH,
        ],
        cwd: WORKDIR,
        clearEnv: true,
        env: {},
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
        signal: abort.signal,
      });

      abort.signal.addEventListener("abort", () => {
        timedOut = true;
        child.kill().catch(() => {});
      });

      const [stdout, stderr] = await Promise.all([
        readStreamCapped(child.stdout, request.maxOutputBytes),
        readStreamCapped(child.stderr, 8 * 1024),
      ]);
      const status = await child.status;

      return {
        stdout: stdout.text,
        stderr: stderr.text,
        timedOut: timedOut || status.signal === "SIGTERM" || status.signal === "SIGKILL",
        outputTruncated: stdout.truncated,
        exitCode: status.code ?? null,
      };
    } finally {
      clearTimeout(deadline);
      // Guaranteed teardown: kill first, then drop the connection.
      await sandbox.kill().catch(() => {});
      await sandbox.close().catch(() => {});
    }
  }
}
