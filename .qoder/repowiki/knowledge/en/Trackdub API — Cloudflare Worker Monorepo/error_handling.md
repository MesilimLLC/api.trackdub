# Error Handling in Trackdub API

## Approach

The codebase uses a **typed exception + centralized middleware** model built on Hono. Errors are represented by a single `ApiError` class (and one startup-time `ConfigError`) that carry a stable machine-readable `code`, a human-readable `message`, an HTTP status, and optional structured `details`. A single global `onError` handler maps these to a uniform JSON envelope; everything else is collapsed into a generic 500.

There is no `try/catch` / `catch`-block propagation pattern in routes — routes and middleware **throw** typed errors, and the Hono error pipeline handles them.

## Key Files

- `src/lib/errors.ts` — `ApiError` class, static constructors (`badRequest`, `unauthorized`, `forbidden`, `notFound`, `conflict`, `payloadTooLarge`, `unsupportedMediaType`, `internal`, `serviceUnavailable`), and `toErrorBody` serializer.
- `src/middleware/error.ts` — `onError(err, c)` registered via `app.onError`; centralizes logging and response mapping.
- `src/config/env.ts` — `ConfigError` thrown when environment bindings or secrets fail validation at first request.
- `src/index.ts` — mounts `app.notFound` and `app.onError`; defines the catch-all 404 response using `ApiError.notFound()`.
- `test/error.test.ts` — enforces the three invariants documented below.

## Architecture and Conventions

### Error types

| Type | When used | Status | Code |
|---|---|---:|---|
| `ApiError.badRequest` | Validation failures, malformed input | 400 | `BAD_REQUEST` |
| `ApiError.unauthorized` | Missing/invalid auth | 401 | `UNAUTHORIZED` |
| `ApiError.forbidden` | Insufficient permissions | 403 | `FORBIDDEN` |
| `ApiError.notFound` | Resource missing, unmatched route | 404 | `NOT_FOUND` |
| `ApiError.conflict` | Duplicate resource / invalid state transition | 409 | `CONFLICT` |
| `ApiError.payloadTooLarge` | Oversized body | 413 | `PAYLOAD_TOO_LARGE` |
| `ApiError.unsupportedMediaType` | Wrong content type | 415 | `UNSUPPORTED_MEDIA_TYPE` |
| `ApiError.serviceUnavailable` | Temporarily unavailable | 503 | `SERVICE_UNAVAILABLE` |
| `ApiError.internal` | Catch-all for unknown server errors | 500 | `INTERNAL` |
| `ConfigError` | Startup configuration missing/invalid | handled as 500 | — |

All of these are constructed through the static helpers on `ApiError`; the raw constructor is not used in application code. The `details` field carries structured data (e.g. Zod's `flatten()` output) but is omitted from the envelope when undefined.

### Response envelope

Every client-visible error has this shape:

```json
{
  "error": {
    "code": "...",
    "message": "...",
    "requestId": "...",
    "details": { ... }   // optional
  }
}
```

The envelope is produced by `toErrorBody(err, requestId)`. Stack traces and internal messages never reach the client.

### Centralized handler

`onError` in `src/middleware/error.ts` branches on the error type:

1. `ApiError` → log at `warn` level (no stack), return `c.json(toErrorBody(...), err.status)`.
2. `ConfigError` → log at `error` level (operator-facing), return a generic 500 with `INTERNAL` code so config specifics do not leak.
3. Any other `Error` → log at `error` level with full stack, return 500 `INTERNAL`.

### Where errors are thrown

- Routes (`src/routes/dubs.ts`, `src/routes/admin.ts`) throw `ApiError.*` for business-rule violations.
- Middleware throws before reaching handlers:
  - `src/middleware/auth.ts` → `ApiError.unauthorized()`
  - `src/middleware/authorize.ts` → `ApiError.forbidden()`
  - `src/middleware/validate.ts` → `ApiError.badRequest("Request body must be valid JSON")` and `ApiError.badRequest("Validation failed", parsed.error.flatten())`
- `src/index.ts` returns `ApiError.notFound()` for unmatched routes.
- `src/activation/lib/authorize.ts` also throws `ApiError.forbidden()` (parallel activation worker).

### Request correlation

The `request-id` middleware injects a `requestId` into the Hono context; `onError` reads it via `c.get("requestId")` and embeds it in every error envelope. This lets clients correlate logs with responses.

## Conventions and Constraints

1. **Routes and middleware throw; they do not call `res.json` directly.** Observed across all routes and middleware files — they propagate typed errors upward to the Hono error pipeline.
2. **Client-visible errors go through `ApiError` only.** The comment in `src/lib/errors.ts` states: "Anything that is NOT an ApiError is treated as an unexpected 500 with a generic message." Unknown exceptions are collapsed to `INTERNAL` 500.
3. **Stack traces and internal messages never reach the client.** Enforced by `onError`: only `ApiError.message` is sent; raw `Error.stack` is logged server-side only.
4. **Configuration errors are fatal and operator-facing.** `ConfigError` is caught separately in `onError`, logged at `error` level, and mapped to a non-leaky 500.
5. **Every error response includes a `requestId`.** The test suite asserts this for 404 responses.
6. **Validation errors include structured details.** Zod validation failures pass `parsed.error.flatten()` as `details` so clients can surface per-field errors.
7. **Test-enforced invariants** (`test/error.test.ts`):
   - 404 responses carry `error.code === "NOT_FOUND"` and a truthy `requestId`.
   - `ApiError.badRequest` maps to status 400, code `BAD_REQUEST`, and forwards `details`.
   - Unknown exceptions return 500 with code `INTERNAL` and do not leak the original message or the word `stack` in the response body.