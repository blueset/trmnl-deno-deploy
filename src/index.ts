/**
 * Router for the TRMNL Deno Deploy API.
 *
 * Endpoints:
 *   - `POST /google-fonts` — random Google Font resolution for the TRMNL plugin
 *   - `GET  /healthz`      — liveness probe
 *
 * Unknown paths return 404; known paths with the wrong method return 405.
 */

import googleFonts from "./google-fonts/index.ts";
import { ApiError, ErrorCode, errorResponse, jsonResponse } from "./http.ts";
import { logger } from "./log.ts";
import { clientKey, RateLimiter } from "./rate-limit.ts";

export interface RouteHandlers {
  googleFonts: (request: Request) => Promise<Response>;
}

export interface RouterOptions {
  rateLimiter?: RateLimiter;
}

export type Router = (request: Request, remoteAddr?: string) => Promise<Response>;

function envNumber(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function methodNotAllowed(allow: string): Response {
  return errorResponse(
    new ApiError(
      405,
      ErrorCode.METHOD_NOT_ALLOWED,
      `Method not allowed. Allowed methods: ${allow}.`,
    ),
    { allow },
  );
}

export function createRouter(handlers: RouteHandlers, options: RouterOptions = {}): Router {
  const rateLimiter = options.rateLimiter ??
    new RateLimiter({ limit: envNumber("RATE_LIMIT_PER_MINUTE", 30) });

  return async function route(request: Request, remoteAddr?: string): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (path === "/healthz") {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return methodNotAllowed("GET, HEAD");
        }
        return jsonResponse({ status: "ok" }, { headers: { "cache-control": "no-store" } });
      }

      if (path === "/google-fonts") {
        if (request.method !== "POST") return methodNotAllowed("POST");

        const decision = rateLimiter.check(clientKey(request, remoteAddr));
        if (!decision.allowed) {
          return errorResponse(
            new ApiError(429, ErrorCode.RATE_LIMITED, "Too many requests. Please slow down."),
            { "retry-after": String(decision.retryAfterSeconds) },
          );
        }
        return await handlers.googleFonts(request);
      }

      return errorResponse(
        new ApiError(404, ErrorCode.NOT_FOUND, "The requested endpoint does not exist."),
      );
    } catch (error) {
      if (error instanceof ApiError) return errorResponse(error);
      logger.error("request.unhandled", {
        path,
        method: request.method,
        reason: error instanceof Error ? error.name : "unknown",
      });
      return errorResponse(
        new ApiError(500, ErrorCode.INTERNAL, "An unexpected error occurred."),
      );
    }
  };
}

export const router: Router = createRouter({
  googleFonts: (request) => googleFonts.fetch(request),
});

if (import.meta.main) {
  Deno.serve((request, info) => router(request, info.remoteAddr.hostname));
}
