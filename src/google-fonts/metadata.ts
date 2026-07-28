/**
 * Metadata acquisition and caching.
 *
 * The upstream document is ~9.7 MB uncompressed and changes rarely. Three tiers
 * are used:
 *
 *  1. a hot, already-parsed copy held in the isolate;
 *  2. the raw body in the Deno Deploy edge cache (Web Cache API);
 *  3. small revalidation state in Deno KV (ETag, Last-Modified, version, time).
 *
 * Upstream is contacted at most once per revalidation window and always with
 * conditional headers. Concurrent callers share a single in-flight refresh.
 */

import { ApiError, ErrorCode } from "../http.ts";
import { logger } from "../log.ts";
import type { KvLike, RawBodyStore } from "./cache.ts";
import { sha256Hex } from "./cache.ts";
import type { GoogleFontsMetadata } from "./types.ts";

export const DEFAULT_METADATA_URL = "https://blueset.github.io/google-fonts-metadata/metadata.json";

export type MetadataCacheStatus =
  | "hot"
  | "warm"
  | "revalidated"
  | "refreshed"
  | "stale"
  | "cold";

export interface MetadataState {
  etag: string | null;
  lastModified: string | null;
  revalidatedAt: number;
  version: string;
  byteLength: number;
}

export interface MetadataSnapshot {
  metadata: GoogleFontsMetadata;
  version: string;
  status: MetadataCacheStatus;
  fontCount: number;
}

export interface MetadataServiceOptions {
  url?: string;
  kv: KvLike;
  bodyStore: RawBodyStore;
  fetchImpl?: typeof fetch;
  /** Minimum interval between upstream revalidations. Defaults to 24 hours. */
  revalidateIntervalMs?: number;
  /** Cool-off after an upstream failure before trying again. */
  failureBackoffMs?: number;
  now?: () => number;
}

const STATE_KEY = ["gf", "metadata", "state"];

/** Rejects documents that are structurally unusable before they are cached. */
export function assertMetadataShape(value: unknown): asserts value is GoogleFontsMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApiError(502, ErrorCode.METADATA_UNAVAILABLE, "Upstream metadata was not an object.");
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.fonts) || record.fonts.length === 0) {
    throw new ApiError(
      502,
      ErrorCode.METADATA_UNAVAILABLE,
      "Upstream metadata contained no fonts.",
    );
  }
  for (const key of ["sample_texts", "scripts", "axes"] as const) {
    const section = record[key];
    if (typeof section !== "object" || section === null || Array.isArray(section)) {
      throw new ApiError(
        502,
        ErrorCode.METADATA_UNAVAILABLE,
        `Upstream metadata was missing "${key}".`,
      );
    }
  }
}

async function computeVersion(
  etag: string | null,
  lastModified: string | null,
  body: string,
): Promise<string> {
  const basis = etag ?? lastModified ?? `len:${body.length}:${body.slice(0, 4096)}`;
  return (await sha256Hex(basis)).slice(0, 32);
}

export class MetadataService {
  readonly #url: string;
  readonly #kv: KvLike;
  readonly #bodyStore: RawBodyStore;
  readonly #fetch: typeof fetch;
  readonly #revalidateIntervalMs: number;
  readonly #failureBackoffMs: number;
  readonly #now: () => number;

  #hot: { metadata: GoogleFontsMetadata; version: string; revalidatedAt: number } | null = null;
  #inflight: Promise<MetadataSnapshot> | null = null;
  #lastFailureAt = 0;

  constructor(options: MetadataServiceOptions) {
    this.#url = options.url ?? DEFAULT_METADATA_URL;
    this.#kv = options.kv;
    this.#bodyStore = options.bodyStore;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#revalidateIntervalMs = options.revalidateIntervalMs ?? 24 * 60 * 60 * 1000;
    this.#failureBackoffMs = options.failureBackoffMs ?? 5 * 60 * 1000;
    this.#now = options.now ?? Date.now;
  }

  /** Number of refreshes currently in flight (0 or 1). Exposed for tests. */
  get refreshing(): boolean {
    return this.#inflight !== null;
  }

  async get(): Promise<MetadataSnapshot> {
    const now = this.#now();
    if (this.#hot && now - this.#hot.revalidatedAt < this.#revalidateIntervalMs) {
      return this.#snapshot("hot");
    }
    if (this.#inflight) return await this.#inflight;

    const run = this.#refresh().finally(() => {
      this.#inflight = null;
    });
    this.#inflight = run;
    return await run;
  }

  #snapshot(status: MetadataCacheStatus): MetadataSnapshot {
    const hot = this.#hot!;
    return {
      metadata: hot.metadata,
      version: hot.version,
      status,
      fontCount: hot.metadata.fonts.length,
    };
  }

  #adopt(body: string, version: string, revalidatedAt: number): GoogleFontsMetadata {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new ApiError(
        502,
        ErrorCode.METADATA_UNAVAILABLE,
        "Upstream metadata was not valid JSON.",
      );
    }
    assertMetadataShape(parsed);
    const previous = this.#hot?.version;
    this.#hot = { metadata: parsed, version, revalidatedAt };
    if (previous && previous !== version) {
      logger.info("metadata.version_changed", {
        previousVersion: previous,
        version,
        fontCount: parsed.fonts.length,
      });
    }
    return parsed;
  }

  async #refresh(): Promise<MetadataSnapshot> {
    const now = this.#now();
    const state = await this.#kv.get<MetadataState>(STATE_KEY);
    const cachedBody = await this.#bodyStore.get(this.#url);

    // A cold isolate can often be served entirely from the edge cache.
    if (
      cachedBody && state &&
      now - state.revalidatedAt < this.#revalidateIntervalMs
    ) {
      this.#adopt(cachedBody, state.version, state.revalidatedAt);
      logger.info("metadata.cache", {
        status: "warm",
        version: state.version,
        bytes: state.byteLength,
      });
      return this.#snapshot("warm");
    }

    // Back off after a recent upstream failure rather than retrying per request.
    if (
      cachedBody && state && this.#lastFailureAt > 0 &&
      now - this.#lastFailureAt < this.#failureBackoffMs
    ) {
      this.#adopt(cachedBody, state.version, state.revalidatedAt);
      logger.warn("metadata.cache", { status: "stale", version: state.version });
      return this.#snapshot("stale");
    }

    const headers = new Headers({ accept: "application/json" });
    const conditional = Boolean(cachedBody && state);
    if (conditional && state?.etag) headers.set("if-none-match", state.etag);
    if (conditional && state?.lastModified) headers.set("if-modified-since", state.lastModified);

    let response: Response;
    try {
      response = await this.#fetch(this.#url, { headers, redirect: "follow" });
    } catch (error) {
      return this.#handleUpstreamFailure(cachedBody, state, describeError(error));
    }

    if (response.status === 304 && cachedBody && state) {
      await response.body?.cancel().catch(() => {});
      const next: MetadataState = { ...state, revalidatedAt: now };
      await this.#kv.set(STATE_KEY, next);
      this.#adopt(cachedBody, state.version, now);
      logger.info("metadata.cache", { status: "revalidated", version: state.version });
      return this.#snapshot("revalidated");
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return this.#handleUpstreamFailure(cachedBody, state, `status ${response.status}`);
    }

    let body: string;
    try {
      body = await response.text();
    } catch (error) {
      return this.#handleUpstreamFailure(cachedBody, state, describeError(error));
    }

    const etag = response.headers.get("etag");
    const lastModified = response.headers.get("last-modified");
    const version = await computeVersion(etag, lastModified, body);

    try {
      this.#adopt(body, version, now);
    } catch (error) {
      return this.#handleUpstreamFailure(cachedBody, state, describeError(error));
    }

    await this.#bodyStore.set(this.#url, body);
    await this.#kv.set(
      STATE_KEY,
      {
        etag,
        lastModified,
        revalidatedAt: now,
        version,
        byteLength: body.length,
      } satisfies MetadataState,
    );
    this.#lastFailureAt = 0;
    logger.info("metadata.cache", {
      status: "refreshed",
      version,
      bytes: body.length,
      fontCount: this.#hot!.metadata.fonts.length,
    });
    return this.#snapshot("refreshed");
  }

  #handleUpstreamFailure(
    cachedBody: string | null,
    state: MetadataState | null,
    reason: string,
  ): MetadataSnapshot {
    this.#lastFailureAt = this.#now();
    logger.error("metadata.upstream_failure", { reason });
    if (cachedBody && state) {
      this.#adopt(cachedBody, state.version, state.revalidatedAt);
      logger.warn("metadata.cache", { status: "stale", version: state.version });
      return this.#snapshot("stale");
    }
    if (this.#hot) {
      logger.warn("metadata.cache", { status: "stale", version: this.#hot.version });
      return this.#snapshot("stale");
    }
    throw new ApiError(
      503,
      ErrorCode.METADATA_UNAVAILABLE,
      "Font metadata is temporarily unavailable. Please retry shortly.",
    );
  }
}

function describeError(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}`;
  if (error instanceof Error) return error.name;
  return "unknown";
}
