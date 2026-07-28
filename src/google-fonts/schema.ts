/**
 * Request validation for `POST /google-fonts`.
 *
 * Validation is strict and explicit: unknown fields, oversized payloads and
 * malformed override shapes are rejected rather than silently dropped.
 */

import { ApiError, ErrorCode } from "../http.ts";
import type { GoogleFontsRequest, OverrideRule } from "./types.ts";

export const LIMITS = {
  /** Maximum accepted request body size, in bytes. */
  maxBodyBytes: 16 * 1024,
  /** Maximum length of any single JavaScript expression. */
  maxExpressionLength: 2_000,
  /** Maximum number of override rules per size bucket. */
  maxOverrideRules: 20,
  /** Maximum length of a replacement sample text. */
  maxSampleTextLength: 2_000,
  /** Maximum nesting depth of the decoded request body. */
  maxDepth: 6,
} as const;

const ALLOWED_TOP_LEVEL = new Set(["filter", "override"]);
const ALLOWED_OVERRIDE_KEYS = new Set(["large", "small"]);

function depthOf(value: unknown, depth = 1): number {
  if (depth > LIMITS.maxDepth + 1) return depth;
  if (Array.isArray(value)) {
    let max = depth;
    for (const item of value) max = Math.max(max, depthOf(item, depth + 1));
    return max;
  }
  if (typeof value === "object" && value !== null) {
    let max = depth;
    for (const item of Object.values(value)) max = Math.max(max, depthOf(item, depth + 1));
    return max;
  }
  return depth;
}

/** Reads the body with a hard byte cap and content-type check. */
export async function readJsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (mime !== "application/json") {
    throw new ApiError(
      415,
      ErrorCode.UNSUPPORTED_MEDIA_TYPE,
      "Content-Type must be application/json.",
    );
  }

  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isFinite(length) || length < 0) {
      throw new ApiError(400, ErrorCode.INVALID_REQUEST, "Invalid Content-Length header.");
    }
    if (length > LIMITS.maxBodyBytes) {
      throw new ApiError(
        413,
        ErrorCode.PAYLOAD_TOO_LARGE,
        `Request body must not exceed ${LIMITS.maxBodyBytes} bytes.`,
      );
    }
  }

  const raw = await readCapped(request.body, LIMITS.maxBodyBytes);
  if (raw === null) {
    throw new ApiError(
      413,
      ErrorCode.PAYLOAD_TOO_LARGE,
      `Request body must not exceed ${LIMITS.maxBodyBytes} bytes.`,
    );
  }
  if (raw.trim() === "") {
    throw new ApiError(400, ErrorCode.INVALID_JSON, "Request body must not be empty.");
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError(400, ErrorCode.INVALID_JSON, "Request body must be valid JSON.");
  }
}

/** Reads a stream as UTF-8, returning `null` when the cap is exceeded. */
export async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<string | null> {
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function assertExpression(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new ApiError(400, ErrorCode.INVALID_REQUEST, `${label} must be a string.`);
  }
  if (value.length > LIMITS.maxExpressionLength) {
    throw new ApiError(
      400,
      ErrorCode.INVALID_REQUEST,
      `${label} must not exceed ${LIMITS.maxExpressionLength} characters.`,
    );
  }
  if (/\0/.test(value)) {
    throw new ApiError(400, ErrorCode.INVALID_REQUEST, `${label} must not contain NUL bytes.`);
  }
  return value;
}

function parseRuleList(value: unknown, label: string): OverrideRule[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ApiError(400, ErrorCode.INVALID_OVERRIDE, `override.${label} must be an array.`);
  }
  if (value.length > LIMITS.maxOverrideRules) {
    throw new ApiError(
      400,
      ErrorCode.INVALID_OVERRIDE,
      `override.${label} must not contain more than ${LIMITS.maxOverrideRules} rules.`,
    );
  }
  return value.map((entry, i) => {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new ApiError(
        400,
        ErrorCode.INVALID_OVERRIDE,
        `override.${label}[${i}] must be a [condition, sampleText] pair.`,
      );
    }
    const condition = assertExpression(entry[0], `override.${label}[${i}] condition`);
    const sampleText = entry[1];
    if (typeof sampleText !== "string") {
      throw new ApiError(
        400,
        ErrorCode.INVALID_OVERRIDE,
        `override.${label}[${i}] sample text must be a string.`,
      );
    }
    if (sampleText.length > LIMITS.maxSampleTextLength) {
      throw new ApiError(
        400,
        ErrorCode.INVALID_OVERRIDE,
        `override.${label}[${i}] sample text must not exceed ${LIMITS.maxSampleTextLength} characters.`,
      );
    }
    return [condition, sampleText] as OverrideRule;
  });
}

/**
 * Validates a decoded request body.
 *
 * `override` may be supplied either as an object or as a JSON string, because
 * TRMNL passes the plugin's code field through verbatim.
 */
export function parseRequest(body: unknown): GoogleFontsRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ApiError(400, ErrorCode.INVALID_REQUEST, "Request body must be a JSON object.");
  }
  if (depthOf(body) > LIMITS.maxDepth) {
    throw new ApiError(
      400,
      ErrorCode.INVALID_REQUEST,
      `Request body must not nest deeper than ${LIMITS.maxDepth} levels.`,
    );
  }

  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_TOP_LEVEL.has(key)) {
      throw new ApiError(400, ErrorCode.INVALID_REQUEST, `Unknown field "${key}".`);
    }
  }

  const filterRaw = record.filter ?? "";
  const filter = filterRaw === null ? "" : assertExpression(filterRaw, "filter");

  let overrideValue = record.override ?? {};
  if (overrideValue === null) overrideValue = {};
  if (typeof overrideValue === "string") {
    const trimmed = overrideValue.trim();
    if (trimmed === "") {
      overrideValue = {};
    } else {
      if (trimmed.length > LIMITS.maxBodyBytes) {
        throw new ApiError(413, ErrorCode.PAYLOAD_TOO_LARGE, "override string is too large.");
      }
      try {
        overrideValue = JSON.parse(trimmed);
      } catch {
        throw new ApiError(
          400,
          ErrorCode.INVALID_OVERRIDE,
          "override must be a JSON object or a JSON-encoded string.",
        );
      }
    }
  }
  if (typeof overrideValue !== "object" || overrideValue === null || Array.isArray(overrideValue)) {
    throw new ApiError(400, ErrorCode.INVALID_OVERRIDE, "override must be a JSON object.");
  }

  const overrideRecord = overrideValue as Record<string, unknown>;
  for (const key of Object.keys(overrideRecord)) {
    if (!ALLOWED_OVERRIDE_KEYS.has(key)) {
      throw new ApiError(400, ErrorCode.INVALID_OVERRIDE, `Unknown override field "${key}".`);
    }
  }

  return {
    filter: filter.trim(),
    override: {
      large: parseRuleList(overrideRecord.large, "large"),
      small: parseRuleList(overrideRecord.small, "small"),
    },
  };
}

/** Deterministic serialisation used as cache-key material. */
export function canonicalize(request: GoogleFontsRequest): string {
  return JSON.stringify({
    filter: request.filter,
    large: request.override.large,
    small: request.override.small,
  });
}
