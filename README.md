# Eana's TRMNL Deno Deploy API

A [Deno Deploy](https://deno.com/deploy) service that backs
[my TRMNL recipes](https://github.com/blueset/trmnl-recipes). It is the Deno sibling of
[`trmnl-workers`](https://github.com/blueset/trmnl-workers): a root `src/index.ts` router with each
endpoint implemented in its own feature directory.

Deployed at <https://trmnl-deno-deploy.1a23.deno.net>.

## Endpoints

| Endpoint                                        | Method | Description                                                      |
| ----------------------------------------------- | ------ | ---------------------------------------------------------------- |
| [`/google-fonts`](./src/google-fonts/README.md) | POST   | Random Google Font resolution for the Random Google Fonts plugin |
| `/healthz`                                      | GET    | Liveness and readiness probe                                     |

Each endpoint documents its own contract, caching and operational limits in a README next to its
source.

---

## Repository structure

```text
trmnl-deno-deploy/
├─ .github/workflows/ci.yml  # fmt --check · lint · check · unit tests
├─ scripts/
│  └─ sandbox-doctor.ts      # opt-in Deno Sandbox diagnostic
├─ src/
│  ├─ index.ts               # router + Deno.serve entrypoint
│  ├─ http.ts                # JSON envelopes, ApiError, weak ETag
│  ├─ log.ts                 # structured, redaction-aware logging
│  ├─ rate-limit.ts          # fixed-window limiter + concurrency gate
│  └─ google-fonts/          # one directory per endpoint, with its own README
├─ tests/                    # unit tests + opt-in integration tests
├─ deno.json                 # tasks, imports, fmt/lint/compiler options
├─ .env.example
├─ LICENSE.md                # MIT (same as trmnl-workers)
└─ README.md
```

### Adding an endpoint

1. Create `src/<endpoint>/index.ts` exporting `{ fetch(request): Promise<Response> }`.
2. Register the path and its allowed method in `src/index.ts`.
3. Throw `ApiError` for anything a client should see; the router renders the envelope.
4. Add tests under `tests/<endpoint>/` that do not require network access.
5. Document the contract in `src/<endpoint>/README.md` and link it from the table above.

---

## Service conventions

### Routing

`src/index.ts` matches on path and method, ignoring trailing slashes.

- Unknown path → `404 not_found`
- Known path, wrong method → `405 method_not_allowed` with an `Allow` header

### Error envelope

Every 4xx/5xx response uses one shape. No stack traces, filesystem paths, sandbox IDs or other
internal details are ever exposed.

```json
{ "error": { "code": "invalid_filter", "message": "filter expression failed: TypeError: …" } }
```

Service-wide codes:

| Status | Code                              | Cause                                     |
| ------ | --------------------------------- | ----------------------------------------- |
| 400    | `invalid_json`, `invalid_request` | Malformed or unknown fields               |
| 404    | `not_found`                       | Unknown route                             |
| 405    | `method_not_allowed`              | Known route, wrong method                 |
| 413    | `payload_too_large`               | Body over the endpoint's limit            |
| 415    | `unsupported_media_type`          | Missing or incorrect `Content-Type`       |
| 429    | `rate_limited`                    | Per-IP limit exceeded (`Retry-After` set) |
| 500    | `internal_error`                  | Unexpected failure                        |

Endpoint-specific codes are documented in that endpoint's README.

### `GET /healthz`

```json
{ "status": "ok", "checks": { "sandboxToken": false, "sandboxOrgRequired": false } }
```

`checks` is a deployment readiness probe. It reports **booleans only** — never token values, lengths
or prefixes:

- `sandboxToken: false` → `DENO_DEPLOY_TOKEN` is not set, so endpoints that need a sandbox will
  return `503 evaluation_failed`.
- `sandboxOrgRequired: true` → a personal `ddp_…` token is configured but `DENO_DEPLOY_ORG` is
  missing. Use an organization `ddo_…` token instead, or set the org slug.

### Abuse control

A fixed-window per-IP rate limiter (`RATE_LIMIT_PER_MINUTE`) guards non-trivial endpoints, and
expensive work sits behind a bounded concurrency gate that returns `503 service_busy` rather than
queueing.

Both are **per isolate**. Deno Deploy runs many isolates, so these are abuse dampeners, not global
quotas. Put a WAF or an API gateway in front if you need hard global limits.

### Logging

Logs are single-line JSON with a `level`, `event` and `time`, emitted through `src/log.ts`. Raw user
expressions, full metadata, sample text, secrets and sandbox file contents are never logged — only
hashes and bounded diagnostic values. String fields are truncated at 200 characters.

### Trust boundaries

The Deno Deploy app is the trusted layer: it routes, validates, caches, and assembles responses. It
contains no `eval` and no `new Function` — `tests/no_eval_test.ts` enforces this by scanning `src/`.

Any untrusted JavaScript runs only inside an ephemeral
[Deno Sandbox](https://docs.deno.com/sandbox/) microVM, and everything it returns is re-validated
before use. See the [`/google-fonts` README](./src/google-fonts/README.md#sandbox-security-model)
for the full model.

---

## Local development

Requires Deno 2.x.

```bash
deno task dev     # watch mode on http://localhost:8000
deno task fmt     # format
deno task lint    # lint
deno task check   # type check
deno task test    # unit tests (no network, no sandbox)
deno task ci      # everything CI runs
```

```bash
curl -sS localhost:8000/healthz
```

Locally, Deno KV runs in memory and the Web Cache API falls back to an in-process map, so caching
semantics are preserved without external services. Without `DENO_DEPLOY_TOKEN`, everything except
sandbox evaluation works normally.

## Testing

```bash
deno task test              # unit tests; no network, no sandbox
deno task test:integration  # opt-in; provisions a real sandbox
```

Unit tests never require a live sandbox or external network — external dependencies are behind
interfaces so they can be mocked. Integration tests are skipped unless their environment variables
are set, and are deliberately kept out of CI because they consume sandbox quota.

CI runs formatting checks, linting, type checking and unit tests on every push and pull request.

---

## Deployment

### 1. Deno Deploy app

1. Sign in at <https://console.deno.com> and create an organization.
2. Create an app from this GitHub repository.
3. Set the entrypoint to `src/index.ts`. There is no build step.
4. Deploy. `Deno.serve` binds automatically.

The CLI works too, and `deno.json` already records the org and app:

```bash
deno deploy --prod
deno deploy logs --once --json --non-interactive
```

### 2. Deno Sandbox token

1. In the Deno Deploy console, open **Settings → Organization Tokens**.
2. Create an **organization** token (it starts with `ddo_`).
3. Add it to the app's environment as `DENO_DEPLOY_TOKEN`, then redeploy.

A personal token (`ddp_`) also works, but then `DENO_DEPLOY_ORG` must be set to your organization
slug as well.

Verify with `curl https://<your-app>.deno.net/healthz` — `checks.sandboxToken` must be `true` and
`checks.sandboxOrgRequired` must be `false`.

This token lets the app provision sandboxes. It is the only required secret and must never be
committed — use `.env.example` as the template.

### 3. Deno KV

1. **Databases → Provision Database → Deno KV**, give it a name.
2. **Assign** it to the app.

`Deno.openKv()` then connects automatically per timeline (production and each branch get isolated
databases). If KV is unavailable the service degrades to an in-memory store: still correct, just
less shared caching.

Note that a single KV value is capped at **64 KiB**, so large documents must live in the edge cache
instead.

### 4. Edge cache

Nothing to configure — `caches.open()` is available on Deno Deploy and is used automatically.

### 5. Environment variables

All optional except the token; see `.env.example`. Per-endpoint variables are documented in that
endpoint's README.

| Variable                | Default | Purpose                                   |
| ----------------------- | ------- | ----------------------------------------- |
| `DENO_DEPLOY_TOKEN`     | —       | **Required** for sandbox-backed endpoints |
| `DENO_DEPLOY_ORG`       | —       | Only with a `ddp_` token                  |
| `RATE_LIMIT_PER_MINUTE` | `30`    | Per-IP limit, per instance                |

---

## License

MIT — see [LICENSE.md](./LICENSE.md).
