/**
 * Trusted-side handling of sandbox output.
 *
 * Everything the sandbox produces is treated as hostile: the payload is
 * extracted from a sentinel frame, size-capped, JSON-parsed defensively and
 * every index is re-validated against the metadata the trusted process holds.
 */

import { ApiError, ErrorCode } from "../http.ts";
import { RESULT_SENTINEL } from "./runner/program-source.ts";
import type { EvaluationOutcome, RunnerOutput } from "./types.ts";

export interface RunnerOutputLimits {
  /** Number of fonts in the metadata document the input was built from. */
  fontCount: number;
  largeRuleCount: number;
  smallRuleCount: number;
  /** Upper bound on the total number of indices across all lists. */
  maxTotalIndices: number;
}

export class MalformedRunnerOutputError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "MalformedRunnerOutputError";
  }
}

/** Pulls the sentinel-framed JSON document out of raw sandbox stdout. */
export function extractResultPayload(stdout: string): string {
  const at = stdout.lastIndexOf(RESULT_SENTINEL);
  if (at === -1) {
    throw new MalformedRunnerOutputError("sandbox produced no result frame");
  }
  return stdout.slice(at + RESULT_SENTINEL.length);
}

function isIndexList(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((n) => typeof n === "number");
}

function validateIndices(
  raw: number[],
  limits: { fontCount: number },
  seenBudget: { total: number; max: number },
  label: string,
  allowed?: Set<number>,
): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const value of raw) {
    if (!Number.isInteger(value) || value < 0 || value >= limits.fontCount) {
      throw new MalformedRunnerOutputError(`${label} contained an out-of-range index`);
    }
    if (seen.has(value)) {
      throw new MalformedRunnerOutputError(`${label} contained a duplicate index`);
    }
    if (allowed && !allowed.has(value)) {
      throw new MalformedRunnerOutputError(`${label} referenced a non-candidate index`);
    }
    seen.add(value);
    out.push(value);
    seenBudget.total += 1;
    if (seenBudget.total > seenBudget.max) {
      throw new MalformedRunnerOutputError("sandbox output exceeded the index budget");
    }
  }
  return out;
}

function normaliseFailureCode(
  code: unknown,
): "invalid_filter" | "invalid_override" | "evaluation_failed" {
  if (code === "invalid_filter" || code === "invalid_override") return code;
  return "evaluation_failed";
}

function boundedMessage(message: unknown): string {
  const text = typeof message === "string" ? message : "evaluation failed";
  const cleaned = text.replace(/[\r\n\t]+/g, " ").trim();
  return cleaned.length > 300 ? `${cleaned.slice(0, 300)}…` : cleaned || "evaluation failed";
}

/**
 * Parses and validates the runner document.
 *
 * @throws {MalformedRunnerOutputError} when the payload cannot be trusted.
 */
export function parseRunnerOutput(payload: string, limits: RunnerOutputLimits): EvaluationOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new MalformedRunnerOutputError("sandbox result was not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new MalformedRunnerOutputError("sandbox result was not an object");
  }
  const output = parsed as RunnerOutput;

  if (output.ok !== true) {
    if (output.ok !== false) {
      throw new MalformedRunnerOutputError("sandbox result had no ok flag");
    }
    return {
      ok: false,
      failure: {
        code: normaliseFailureCode(output.error?.code),
        message: boundedMessage(output.error?.message),
      },
    };
  }

  if (!isIndexList(output.candidates)) {
    throw new MalformedRunnerOutputError("sandbox result had no candidate list");
  }
  const budget = { total: 0, max: limits.maxTotalIndices };
  const candidateIndices = validateIndices(
    output.candidates,
    limits,
    budget,
    "candidate list",
  );
  const allowed = new Set(candidateIndices);

  const readMatches = (value: unknown, expected: number, label: string): number[][] => {
    if (!Array.isArray(value)) {
      throw new MalformedRunnerOutputError(`${label} override matches were not an array`);
    }
    if (value.length !== expected) {
      throw new MalformedRunnerOutputError(`${label} override match count mismatch`);
    }
    return value.map((entry, i) => {
      if (!isIndexList(entry)) {
        throw new MalformedRunnerOutputError(`${label} override match #${i + 1} was malformed`);
      }
      return validateIndices(entry, limits, budget, `${label} override match`, allowed);
    });
  };

  return {
    ok: true,
    result: {
      candidateIndices,
      largeOverrideMatches: readMatches(output.large, limits.largeRuleCount, "large"),
      smallOverrideMatches: readMatches(output.small, limits.smallRuleCount, "small"),
    },
  };
}

/** Maps a deterministic evaluation failure onto the public error envelope. */
export function failureToApiError(failure: {
  code: string;
  message: string;
  transient?: boolean;
}): ApiError {
  if (failure.transient) {
    return new ApiError(503, ErrorCode.EVALUATION_FAILED, failure.message);
  }
  switch (failure.code) {
    case "invalid_filter":
      return new ApiError(422, ErrorCode.INVALID_FILTER, failure.message);
    case "invalid_override":
      return new ApiError(422, ErrorCode.INVALID_OVERRIDE, failure.message);
    default:
      return new ApiError(422, ErrorCode.EVALUATION_FAILED, failure.message);
  }
}
