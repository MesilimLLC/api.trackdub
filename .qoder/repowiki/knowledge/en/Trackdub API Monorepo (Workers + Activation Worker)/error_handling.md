## Approach

The codebase uses a single, explicit error-handling system built around three pieces:

1. A typed `ApiError` class in `src/lib/errors.ts` that carries HTTP status, a machine-readable `code`, and optional structured `details`.
2. A central Hono `onError` middleware in `src/middleware/error.ts` that is the sole place where errors are turned into HTTP responses.
3. A consistent JSON envelope shape (`ApiErrorBody`) returned for every client-visible response, including a stable `requestId`.

There is no use of `throw new Response(...)` from routes, no ad-hoc error objects, and no `try/catch` blocks swallowing errors — the convention is to throw `ApiError` (or any other `Error`) and let `onError` handle it.

## Key Files

- `src/lib/errors.ts` — defines `ApiErrorBody` interface, `ApiError` class with static factory constructors (`badRequest`, `unauthorized`, `forbidden`, `notFound`, `conflict`, `payloadTooLarge`, `unsupportedMediaType`, `internal`, `serviceUnavailable`), and `toErrorBody` helper.
- `src/middleware/error.ts` — registers via Hono's `app.onError`; maps `ApiError` → its status/code, `ConfigError` → generic 500, everything else → generic 500 with stack logged server-side only.
- `test/error.test.ts` — integration tests asserting the envelope shape, status mapping, `requestId` presence, and that stack traces / internal messages never leak to clients.
- `src/config/env.ts` — provides `ConfigError`, which `onError` treats specially as a fatal operator-facing misconfiguration.

## Architecture and Conventions

### Error types

`ApiError` extends `Error` and adds:
- `status: ContentfulStatusCode` — the HTTP status code.
- `code: string` — an uppercase, machine-readable token such as `BAD_REQUEST`, `UNAUTHORIZED`, `NOT_FOUND`, `CONFLICT`, `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`, `INTERNAL`, `SERVICE_UNAVAILABLE`.
- `details?: unknown` — arbitrary structured data (e.g. `{ field: "x" }`) that is forwarded verbatim into the response body.

Static constructors on `ApiError` exist for the most common statuses; route code is expected to call these rather than constructing `new ApiError(...)` directly, keeping codes and defaults centralized.

### Response envelope

Every API response has this shape:

```json
{
  "error": {
    "code": "...",
    "message": "...",
    "requestId": "...",
    "details": { ... }
  }
}
```

`toErrorBody(err, requestId)` builds it; `requestId` comes from the request-scoped context set by the `request-id` middleware. The envelope is documented in a file-level comment as the contract: "Every error the API returns has the shape … Stack traces and internal messages never reach the client."

### Centralized mapping

`onError` in `src/middleware/error.ts` is the single source of truth for how errors become responses:

| Error type | Log level | Client response |
|---|---|---|
| `ApiError` | `logger.warn` (no stack) | Status + code + message + details |
| `ConfigError` | `logger.error` | Generic 500 with `INTERNAL` code |
| Any other `Error` | `logger.error` (with stack) | Generic 500 with `INTERNAL` code |

This means throwing a bare `Error` (e.g. from a database driver or third-party library) is safe: it will be surfaced to the client as a generic `INTERNAL` error while still being fully logged server-side with stack traces. Known business errors must be thrown as `ApiError` subclasses so they get a meaningful status and code.

### Separation of concerns

- `lib/errors.ts` owns the error model and serialization.
- `middleware/error.ts` owns routing of errors to logs + responses.
- Routes and business logic own the semantic decision of *which* `ApiError` to throw.
- Tests assert both the happy-path envelope and the security property that unexpected errors do not leak internals.

## Conventions and Constraints

**Observed conventions:**

- Route handlers throw `ApiError.badRequest(...)`, `.notFound(...)`, etc. rather than returning error objects or calling `c.json(...)` directly for error cases.
- Error codes are uppercase strings defined as static constructors on `ApiError` (e.g. `BAD_REQUEST`, `NOT_FOUND`); callers should not invent ad-hoc codes.
- The `details` field is used for structured per-request diagnostics (e.g. which input field failed validation) but is omitted when undefined.
- `ConfigError` is reserved for startup-time environment/configuration problems and is intentionally mapped to a generic 500 so config specifics never leak.

**Enforced behavior (verified by code and tests):**

- The `onError` handler in `src/middleware/error.ts` is registered via Hono's `app.onError`, making it the only path from thrown errors to HTTP responses.
- `test/error.test.ts` asserts that:
  - A missing route returns status 404 with code `NOT_FOUND` and a truthy `requestId`.
  - Throwing `ApiError.badRequest("nope", { field: "x" })` returns status 400, code `BAD_REQUEST`, and `details` equal to `{ field: "x" }`.
  - Throwing a plain `Error` returns status 500 with code `INTERNAL`, and the response text contains neither the secret message nor the word `stack` — proving stack traces and internal messages never reach the client.
- The `ApiErrorBody` interface in `src/lib/errors.ts` enforces at compile time that every client-visible error envelope contains `code`, `message`, `requestId`, and an optional `details`.

**Not observed:**

- No `panic`/`recover` pattern (this is JavaScript/TypeScript).
- No global `process.on('unhandledRejection')` handler visible in the inspected files; unhandled rejections are left to the Workers runtime.
- No custom error classes beyond `ApiError` and `ConfigError` in the inspected scope.