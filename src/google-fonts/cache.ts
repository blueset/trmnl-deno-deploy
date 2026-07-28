/**
 * Caching primitives: a small key/value abstraction (Deno KV in production, an
 * in-memory map in tests and local development), a raw-body store backed by the
 * Deno Deploy Web Cache API, and the filter-result cache.
 *
 * Deno KV caps a single value at 64 KiB, so the ~9.7 MB metadata document is
 * never stored there. KV holds only small revalidation metadata and compact
 * bitset-encoded filter results; the raw body lives in the edge cache.
 */

import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import type { EvaluatedFilterResult, EvaluationFailure, EvaluationOutcome } from "./types.ts";

/** Minimal key/value contract used by the service. */
export interface KvLike {
  get<T>(key: string[]): Promise<T | null>;
  set<T>(key: string[], value: T, options?: { expireInMs?: number }): Promise<void>;
  delete(key: string[]): Promise<void>;
}

/** In-memory implementation with expiry; used for tests and local dev. */
export class MemoryKv implements KvLike {
  readonly #map = new Map<string, { value: unknown; expiresAt: number }>();

  #encode(key: string[]): string {
    return JSON.stringify(key);
  }

  get<T>(key: string[]): Promise<T | null> {
    const entry = this.#map.get(this.#encode(key));
    if (!entry) return Promise.resolve(null);
    if (entry.expiresAt !== Infinity && entry.expiresAt <= Date.now()) {
      this.#map.delete(this.#encode(key));
      return Promise.resolve(null);
    }
    return Promise.resolve(entry.value as T);
  }

  set<T>(key: string[], value: T, options?: { expireInMs?: number }): Promise<void> {
    this.#map.set(this.#encode(key), {
      value,
      expiresAt: options?.expireInMs ? Date.now() + options.expireInMs : Infinity,
    });
    return Promise.resolve();
  }

  delete(key: string[]): Promise<void> {
    this.#map.delete(this.#encode(key));
    return Promise.resolve();
  }
}

/** Deno KV backed implementation. */
export class DenoKvStore implements KvLike {
  readonly #kv: Deno.Kv;

  constructor(kv: Deno.Kv) {
    this.#kv = kv;
  }

  async get<T>(key: string[]): Promise<T | null> {
    const entry = await this.#kv.get<T>(key);
    return entry.value ?? null;
  }

  async set<T>(key: string[], value: T, options?: { expireInMs?: number }): Promise<void> {
    await this.#kv.set(
      key,
      value,
      options?.expireInMs ? { expireIn: options.expireInMs } : undefined,
    );
  }

  async delete(key: string[]): Promise<void> {
    await this.#kv.delete(key);
  }
}

/** Opens Deno KV when available, otherwise falls back to an in-memory store. */
export async function openKvStore(): Promise<{ kv: KvLike; durable: boolean }> {
  try {
    if (typeof Deno.openKv !== "function") return { kv: new MemoryKv(), durable: false };
    const kv = await Deno.openKv();
    return { kv: new DenoKvStore(kv), durable: true };
  } catch {
    return { kv: new MemoryKv(), durable: false };
  }
}

/** Storage for the large raw metadata body. */
export interface RawBodyStore {
  get(key: string): Promise<string | null>;
  set(key: string, body: string): Promise<void>;
}

/** Uses the Deno Deploy Web Cache API when present. */
export class WebCacheBodyStore implements RawBodyStore {
  readonly #cacheName: string;
  #cache: Cache | null = null;

  constructor(cacheName = "trmnl-google-fonts-metadata") {
    this.#cacheName = cacheName;
  }

  async #open(): Promise<Cache> {
    if (!this.#cache) this.#cache = await caches.open(this.#cacheName);
    return this.#cache;
  }

  static available(): boolean {
    return typeof globalThis.caches?.open === "function";
  }

  #url(key: string): string {
    return `https://cache.invalid/${encodeURIComponent(key)}`;
  }

  async get(key: string): Promise<string | null> {
    const cache = await this.#open();
    const hit = await cache.match(this.#url(key));
    if (!hit) return null;
    return await hit.text();
  }

  async set(key: string, body: string): Promise<void> {
    const cache = await this.#open();
    await cache.put(
      this.#url(key),
      new Response(body, {
        headers: {
          "content-type": "application/json; charset=utf-8",
          // Retained at the edge well past the 24 h revalidation window so a
          // 304 can always reuse it.
          "cache-control": "max-age=2592000",
        },
      }),
    );
  }
}

/** Process-local fallback body store. */
export class MemoryBodyStore implements RawBodyStore {
  readonly #map = new Map<string, string>();

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.#map.get(key) ?? null);
  }

  set(key: string, body: string): Promise<void> {
    this.#map.set(key, body);
    return Promise.resolve();
  }
}

export function createBodyStore(): RawBodyStore {
  return WebCacheBodyStore.available() ? new WebCacheBodyStore() : new MemoryBodyStore();
}

// ---------------------------------------------------------------------------
// Hashing and compact index encoding
// ---------------------------------------------------------------------------

/** SHA-256 hex digest. Used so raw expressions never appear in storage keys. */
export async function sha256Hex(material: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Packs sorted indices into a base64 bitset (≈253 bytes for 2,020 fonts). */
export function encodeIndexSet(indices: number[], size: number): string {
  const bytes = new Uint8Array(Math.ceil(size / 8));
  for (const index of indices) {
    if (!Number.isInteger(index) || index < 0 || index >= size) {
      throw new RangeError("index out of range");
    }
    bytes[index >> 3]! |= 1 << (index & 7);
  }
  return encodeBase64(bytes);
}

/** Inverse of {@linkcode encodeIndexSet}. Returns ascending indices. */
export function decodeIndexSet(encoded: string, size: number): number[] {
  const bytes = decodeBase64(encoded);
  const expected = Math.ceil(size / 8);
  if (bytes.byteLength !== expected) {
    throw new RangeError("bitset length does not match the font count");
  }
  const out: number[] = [];
  for (let i = 0; i < size; i++) {
    if ((bytes[i >> 3]! >> (i & 7)) & 1) out.push(i);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Filter-result cache
// ---------------------------------------------------------------------------

interface StoredSuccess {
  v: 1;
  mv: string;
  n: number;
  c: string;
  lg: string[];
  sm: string[];
}

interface StoredFailure {
  v: 1;
  mv: string;
  err: EvaluationFailure;
}

type StoredEntry = StoredSuccess | StoredFailure;

export type CacheStatus = "hit" | "miss";

export interface FilterCacheOptions {
  successTtlMs?: number;
  failureTtlMs?: number;
  memoryEntries?: number;
}

/**
 * Two-tier cache for evaluated filter results.
 *
 * Keys embed the metadata version, so a metadata change invalidates every
 * entry automatically without an explicit purge.
 */
export class FilterResultCache {
  readonly #kv: KvLike;
  readonly #successTtlMs: number;
  readonly #failureTtlMs: number;
  readonly #memoryEntries: number;
  readonly #memory = new Map<string, { entry: StoredEntry; expiresAt: number }>();

  constructor(kv: KvLike, options: FilterCacheOptions = {}) {
    this.#kv = kv;
    this.#successTtlMs = options.successTtlMs ?? 6 * 60 * 60 * 1000;
    this.#failureTtlMs = options.failureTtlMs ?? 60 * 1000;
    this.#memoryEntries = options.memoryEntries ?? 256;
  }

  /** Builds the storage key from hashed material. */
  static async keyFor(metadataVersion: string, canonicalRequest: string): Promise<string> {
    return await sha256Hex(`v1|${metadataVersion}|${canonicalRequest}`);
  }

  async get(
    key: string,
    metadataVersion: string,
    fontCount: number,
  ): Promise<{ status: CacheStatus; outcome?: EvaluationOutcome }> {
    const local = this.#memory.get(key);
    if (local && local.expiresAt > Date.now()) {
      const outcome = this.#decode(local.entry, metadataVersion, fontCount);
      if (outcome) return { status: "hit", outcome };
      this.#memory.delete(key);
    }

    const stored = await this.#kv.get<StoredEntry>(["gf", "filter", key]);
    if (!stored) return { status: "miss" };
    const outcome = this.#decode(stored, metadataVersion, fontCount);
    if (!outcome) {
      await this.#kv.delete(["gf", "filter", key]);
      return { status: "miss" };
    }
    this.#remember(key, stored, "err" in stored ? this.#failureTtlMs : this.#successTtlMs);
    return { status: "hit", outcome };
  }

  async set(
    key: string,
    metadataVersion: string,
    fontCount: number,
    outcome: EvaluationOutcome,
  ): Promise<void> {
    const entry: StoredEntry = outcome.ok
      ? {
        v: 1,
        mv: metadataVersion,
        n: fontCount,
        c: encodeIndexSet(outcome.result.candidateIndices, fontCount),
        lg: outcome.result.largeOverrideMatches.map((m) => encodeIndexSet(m, fontCount)),
        sm: outcome.result.smallOverrideMatches.map((m) => encodeIndexSet(m, fontCount)),
      }
      : { v: 1, mv: metadataVersion, err: outcome.failure };
    const ttl = outcome.ok ? this.#successTtlMs : this.#failureTtlMs;
    this.#remember(key, entry, ttl);
    await this.#kv.set(["gf", "filter", key], entry, { expireInMs: ttl });
  }

  #remember(key: string, entry: StoredEntry, ttlMs: number): void {
    if (this.#memory.size >= this.#memoryEntries) {
      const oldest = this.#memory.keys().next();
      if (!oldest.done) this.#memory.delete(oldest.value);
    }
    this.#memory.set(key, { entry, expiresAt: Date.now() + ttlMs });
  }

  #decode(
    entry: StoredEntry,
    metadataVersion: string,
    fontCount: number,
  ): EvaluationOutcome | null {
    if (entry.v !== 1 || entry.mv !== metadataVersion) return null;
    if ("err" in entry) return { ok: false, failure: entry.err };
    if (entry.n !== fontCount) return null;
    try {
      return {
        ok: true,
        result: {
          candidateIndices: decodeIndexSet(entry.c, fontCount),
          largeOverrideMatches: entry.lg.map((m) => decodeIndexSet(m, fontCount)),
          smallOverrideMatches: entry.sm.map((m) => decodeIndexSet(m, fontCount)),
        } satisfies EvaluatedFilterResult,
      };
    } catch {
      return null;
    }
  }
}
