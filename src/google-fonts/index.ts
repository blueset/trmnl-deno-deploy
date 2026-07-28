/**
 * `POST /google-fonts` — validates input, evaluates the user's expressions in a
 * sandbox (or reuses a cached evaluation), picks a random matching font in the
 * trusted process and resolves the small payload the TRMNL plugin renders.
 */

import { ApiError, ErrorCode, jsonResponse, weakEtag } from "../http.ts";
import { logger } from "../log.ts";
import { ConcurrencyGate } from "../rate-limit.ts";
import { createBodyStore, FilterResultCache, type KvLike, openKvStore } from "./cache.ts";
import { DEFAULT_METADATA_URL, MetadataService } from "./metadata.ts";
import { failureToApiError } from "./runner.ts";
import { DenoSandboxDriver, SANDBOX_DEFAULTS, SandboxEvaluator } from "./sandbox.ts";
import { canonicalize, parseRequest, readJsonBody } from "./schema.ts";
import type {
  EvaluatedFilterResult,
  Evaluator,
  FontMetadata,
  GoogleFontsMetadata,
  GoogleFontsRequest,
  GoogleFontsResponse,
} from "./types.ts";

/** Cooperative budget the runner enforces between fonts, inside the sandbox. */
const SOFT_DEADLINE_MS = 10_000;

export interface GoogleFontsServiceOptions {
  metadata: MetadataService;
  filterCache: FilterResultCache;
  evaluator: Evaluator;
  gate?: ConcurrencyGate;
  /** Injectable for deterministic tests. */
  random?: () => number;
}

/**
 * Resolves the sample text with the same precedence as the original plugin:
 * the font's own sample text, then the primary language bundle, then `en_Latn`.
 */
export function resolveSampleText(data: GoogleFontsMetadata, font: FontMetadata): unknown {
  const own = Array.isArray(font.sample_text) ? font.sample_text[0] : undefined;
  if (own) return own;

  const language = typeof font.primary_language === "string" ? font.primary_language : undefined;
  if (language) {
    const byLanguage = data.sample_texts[language]?.sample_text?.[0];
    if (byLanguage) return byLanguage;
  }

  const fallback = data.sample_texts["en_Latn"]?.sample_text?.[0];
  if (!fallback) {
    throw new ApiError(
      500,
      ErrorCode.METADATA_INCOMPLETE,
      "Font metadata is missing the en_Latn fallback sample text.",
    );
  }
  return fallback;
}

/**
 * Later matching rules override earlier ones, mirroring the sequential
 * assignment performed by the current `shared.liquid`.
 */
export function resolveOverride(
  rules: Array<[condition: string, sampleText: string]>,
  matches: number[][],
  fontIndex: number,
): string | null {
  let selected: string | null = null;
  for (let i = 0; i < rules.length; i++) {
    if (matches[i]?.includes(fontIndex)) selected = rules[i]![1];
  }
  return selected;
}

export class GoogleFontsService {
  readonly #metadata: MetadataService;
  readonly #filterCache: FilterResultCache;
  readonly #evaluator: Evaluator;
  readonly #gate: ConcurrencyGate;
  readonly #random: () => number;

  constructor(options: GoogleFontsServiceOptions) {
    this.#metadata = options.metadata;
    this.#filterCache = options.filterCache;
    this.#evaluator = options.evaluator;
    this.#gate = options.gate ?? new ConcurrencyGate(2);
    this.#random = options.random ?? Math.random;
  }

  async handle(request: Request): Promise<Response> {
    const parsed = parseRequest(await readJsonBody(request));
    const snapshot = await this.#metadata.get();
    const canonical = canonicalize(parsed);
    const cacheKey = await FilterResultCache.keyFor(snapshot.version, canonical);

    const cached = await this.#filterCache.get(cacheKey, snapshot.version, snapshot.fontCount);
    logger.info("filter.cache", {
      status: cached.status,
      key: cacheKey.slice(0, 16),
      metadataVersion: snapshot.version,
    });

    let outcome = cached.outcome;
    if (!outcome) {
      outcome = await this.#evaluateWithGate(parsed, snapshot.metadata);
      // Transient infrastructure failures must not poison the cache.
      if (outcome.ok || !outcome.failure.transient) {
        await this.#filterCache.set(cacheKey, snapshot.version, snapshot.fontCount, outcome);
      }
    }

    if (!outcome.ok) throw failureToApiError(outcome.failure);

    const body = this.#assemble(parsed, snapshot.metadata, snapshot.version, outcome.result, [
      ...(snapshot.status === "stale"
        ? ["Font metadata could not be revalidated upstream; serving a cached copy."]
        : []),
    ]);

    const serialized = JSON.stringify(body);
    return jsonResponse(body, {
      headers: {
        // The response is a random draw, so it must never be reused.
        "cache-control": "no-store, max-age=0",
        "etag": await weakEtag(serialized),
        "x-metadata-version": snapshot.version,
        "x-metadata-cache": snapshot.status,
        "x-filter-cache": cached.status,
        "x-candidate-count": String(outcome.result.candidateIndices.length),
      },
    });
  }

  async #evaluateWithGate(parsed: GoogleFontsRequest, metadata: GoogleFontsMetadata) {
    const release = this.#gate.tryAcquire();
    if (!release) {
      throw new ApiError(
        503,
        ErrorCode.SERVICE_BUSY,
        "The evaluation queue is full. Please retry shortly.",
      );
    }
    try {
      return await this.#evaluator.evaluate({
        filter: parsed.filter,
        large: parsed.override.large.map(([condition]) => condition),
        small: parsed.override.small.map(([condition]) => condition),
        fonts: metadata.fonts,
        softDeadlineMs: SOFT_DEADLINE_MS,
        maxOutputBytes: SANDBOX_DEFAULTS.maxOutputBytes,
      });
    } finally {
      release();
    }
  }

  #assemble(
    parsed: GoogleFontsRequest,
    metadata: GoogleFontsMetadata,
    version: string,
    result: EvaluatedFilterResult,
    errors: string[],
  ): GoogleFontsResponse {
    if (result.candidateIndices.length === 0) {
      throw new ApiError(
        422,
        ErrorCode.NO_FONT_MATCHED,
        "No font matched the supplied filter.",
      );
    }

    const pick = Math.floor(this.#random() * result.candidateIndices.length);
    const fontIndex = result.candidateIndices[
      Math.min(pick, result.candidateIndices.length - 1)
    ]!;
    const font = metadata.fonts[fontIndex]!;

    return {
      font,
      sampleText: resolveSampleText(metadata, font),
      script: metadata.scripts[
        typeof font.primary_script === "string" ? font.primary_script : ""
      ],
      axes: metadata.axes,
      sampleOverrides: {
        large: resolveOverride(parsed.override.large, result.largeOverrideMatches, fontIndex),
        small: resolveOverride(parsed.override.small, result.smallOverrideMatches, fontIndex),
      },
      metadataVersion: version,
      errors,
    };
  }
}

function envNumber(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

let singleton: Promise<GoogleFontsService> | null = null;

/** Lazily builds the production service wiring. */
export function getGoogleFontsService(): Promise<GoogleFontsService> {
  if (!singleton) {
    singleton = (async () => {
      const { kv, durable } = await openKvStore();
      logger.info("startup.kv", { durable });
      return buildService(kv);
    })();
  }
  return singleton;
}

export function buildService(kv: KvLike): GoogleFontsService {
  const metadata = new MetadataService({
    url: Deno.env.get("GOOGLE_FONTS_METADATA_URL") ?? DEFAULT_METADATA_URL,
    kv,
    bodyStore: createBodyStore(),
    revalidateIntervalMs: envNumber("METADATA_REVALIDATE_SECONDS", 86_400) * 1000,
  });
  const evaluator = new SandboxEvaluator({
    driver: new DenoSandboxDriver({
      memoryMb: envNumber("SANDBOX_MEMORY_MB", SANDBOX_DEFAULTS.memoryMb),
    }),
    timeoutMs: envNumber("SANDBOX_TIMEOUT_MS", SANDBOX_DEFAULTS.timeoutMs),
    maxOutputBytes: envNumber("SANDBOX_MAX_OUTPUT_BYTES", SANDBOX_DEFAULTS.maxOutputBytes),
  });
  return new GoogleFontsService({
    metadata,
    filterCache: new FilterResultCache(kv),
    evaluator,
    gate: new ConcurrencyGate(envNumber("SANDBOX_MAX_CONCURRENCY", 2)),
  });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const service = await getGoogleFontsService();
    return await service.handle(request);
  },
};
