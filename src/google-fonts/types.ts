/** Shared types for the `/google-fonts` endpoint. */

/**
 * A single entry of `$.fonts[]` in the upstream metadata document.
 *
 * The shape is intentionally open: user filters may reference any property, and
 * the upstream document evolves independently of this service.
 */
export interface FontMetadata {
  name?: string;
  primary_language?: string;
  primary_script?: string;
  sample_text?: unknown[];
  [key: string]: unknown;
}

/** Language-keyed sample text bundle from `$.sample_texts`. */
export interface SampleTextEntry {
  sample_text?: unknown[];
  [key: string]: unknown;
}

/** The parsed upstream metadata document. */
export interface GoogleFontsMetadata {
  fonts: FontMetadata[];
  sample_texts: Record<string, SampleTextEntry | undefined>;
  scripts: Record<string, unknown>;
  axes: Record<string, unknown>;
  [key: string]: unknown;
}

/** A single override rule: `[condition, sampleText]`. */
export type OverrideRule = [condition: string, sampleText: string];

export interface OverrideConfig {
  large?: OverrideRule[];
  small?: OverrideRule[];
}

/** The validated `POST /google-fonts` request body. */
export interface GoogleFontsRequest {
  /** Empty string means "all fonts". */
  filter: string;
  override: Required<OverrideConfig>;
}

export interface GoogleFontsResponse {
  font: FontMetadata;
  sampleText: unknown;
  script: unknown;
  axes: unknown;
  sampleOverrides: {
    large: string | null;
    small: string | null;
  };
  metadataVersion: string;
  errors: string[];
}

/**
 * The compact, cacheable product of one sandbox evaluation.
 *
 * `largeOverrideMatches[i]` holds the font indices matched by override rule `i`
 * of the `large` list (same for `small`). Indices are validated against the
 * metadata font count before use.
 */
export interface EvaluatedFilterResult {
  candidateIndices: number[];
  largeOverrideMatches: number[][];
  smallOverrideMatches: number[][];
}

/** A deterministic evaluation failure, cached briefly to blunt repeat abuse. */
export interface EvaluationFailure {
  code: "invalid_filter" | "invalid_override" | "evaluation_failed";
  /** Bounded, sanitised message safe to return to the client. */
  message: string;
  /**
   * Infrastructure failures (sandbox provisioning, timeouts) are transient:
   * they are never cached and are reported as 503 rather than 422.
   */
  transient?: boolean;
}

export type EvaluationOutcome =
  | { ok: true; result: EvaluatedFilterResult }
  | { ok: false; failure: EvaluationFailure };

/** Input handed to the untrusted sandbox runner. */
export interface RunnerInput {
  filter: string;
  large: string[];
  small: string[];
  fonts: FontMetadata[];
  /** Soft, cooperative budget checked between fonts by the runner. */
  softDeadlineMs: number;
  /** Runner-side cap on the serialised output size. */
  maxOutputBytes: number;
}

/** Raw runner output, before trusted-side validation. */
export interface RunnerOutput {
  ok: boolean;
  candidates?: number[];
  large?: number[][];
  small?: number[][];
  error?: { code?: string; message?: string };
}

/** Abstraction over "evaluate these expressions somewhere untrusted". */
export interface Evaluator {
  evaluate(input: RunnerInput): Promise<EvaluationOutcome>;
}
