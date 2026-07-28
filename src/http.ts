/**
 * HTTP helpers: consistent JSON envelopes for success and failure.
 *
 * Error responses never expose stack traces, filesystem paths, sandbox
 * identifiers or other internal implementation details.
 */

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

/** Error codes exposed to clients. Stable, documented, and safe to surface. */
export const ErrorCode = {
  NOT_FOUND: "not_found",
  METHOD_NOT_ALLOWED: "method_not_allowed",
  UNSUPPORTED_MEDIA_TYPE: "unsupported_media_type",
  PAYLOAD_TOO_LARGE: "payload_too_large",
  INVALID_JSON: "invalid_json",
  INVALID_REQUEST: "invalid_request",
  INVALID_FILTER: "invalid_filter",
  INVALID_OVERRIDE: "invalid_override",
  NO_FONT_MATCHED: "no_font_matched",
  EVALUATION_TIMEOUT: "evaluation_timeout",
  EVALUATION_OUTPUT_INVALID: "evaluation_output_invalid",
  EVALUATION_FAILED: "evaluation_failed",
  METADATA_UNAVAILABLE: "metadata_unavailable",
  METADATA_INCOMPLETE: "metadata_incomplete",
  RATE_LIMITED: "rate_limited",
  SERVICE_BUSY: "service_busy",
  INTERNAL: "internal_error",
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/** An error that is safe to render into an HTTP response. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCodeValue;
  readonly details?: Record<string, unknown>;

  constructor(
    status: number,
    code: ErrorCodeValue,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...init.headers,
    },
  });
}

export function errorResponse(error: ApiError, headers: Record<string, string> = {}): Response {
  const body: ApiErrorBody = {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    },
  };
  return jsonResponse(body, {
    status: error.status,
    headers: { "cache-control": "no-store", ...headers },
  });
}

/** Weak ETag derived from the response body bytes. */
export async function weakEtag(body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  const hex = Array.from(new Uint8Array(digest).slice(0, 12))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `W/"${hex}"`;
}
