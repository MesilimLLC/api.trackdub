## System

The Trackdub API uses a single, explicit error model built on Hono's `onError` middleware and a custom `ApiError` class. Errors are never returned inline; every response goes through a central error mapper that converts them into a uniform JSON envelope containing `error.code`, `error.message`, `error.requestId`, and an optional `error.details` field.

## Key files

- `src/lib/errors.ts` — Defines the `ApiErrorBody` interface, the `ApiError` class (with static constructors for 400/401/403/404/409/413/415/500/503), and the `toErrorBody` serializer.
- `src/middleware/error.ts` — Registers the global `onError` handler via `app.onError`, mapping `ApiError` to its status/code and everything else to a generic 500.
- `test/error.test.ts` — Verifies the consistent envelope shape, request-id inclusion, code/status mapping, and that stack traces / internal messages never leak.
- `src/index.ts` — Applies the global error handler and handles the 404 catch-all route using `ApiError.notFound()` + `toErrorBody`.
- `src/middleware/auth.ts`, `src/middleware/authorize.ts`, `src/middleware/validate.ts` — Route-level authorization and validation errors thrown as `ApiError`.
- `src/routes/dubs.ts` — Business-route errors (not found, conflict, unsupported media type, payload too large, service unavailable).
- `src/activation/middleware.ts` — Separate error handling path for the activation Worker, mirroring the same `toErrorBody` contract.

## Architecture and conventions

1. **One error type for the public API.** `ApiError extends Error` carries four fields: `status` (`ContentfulStatusCode`), `code` (uppercase string like `BAD_REQUEST`), `message`, and optional `details`. Static factory methods provide fixed codes so callers do not invent new strings.
2. **Centralized serialization.** `toErrorBody(err, requestId)` produces `{ error: { code, message, requestId, details? } }`. The `details` property is omitted from the object when undefined, keeping the envelope minimal.
3. **Global error boundary in Hono.** `src/middleware/error.ts` installs `onError` once. It branches on:
   - `err instanceof ApiError` → log at `warn` (no stack) and return `c.json(toErrorBody(err, requestId), err.status)`.
   - `err instanceof ConfigError` (from `@/config/env`) → log at `error` with full detail and return a generic 500 `INTERNAL` body so configuration specifics never reach clients.
   - anything else → log at `error` including `stack` and return 500 `INTERNAL`.
4. **Stack traces and internal messages are server-side only.** The comment in `src/lib/errors.ts` states the invariant explicitly: "Stack traces and internal messages never reach the client." Tests assert both that the text body does not contain secrets and does not contain the word `stack`.
5. **Routes throw; they do not call `res.json` directly.** All business logic throws typed `ApiError` instances. Validation middleware also throws `ApiError.badRequest(...)` rather than returning responses.
6. **Activation Worker mirrors the pattern.** Its own `middleware.ts` imports `ApiError` and `toErrorBody` and returns `c.json(toErrorBody(err, requestId), err.status)` for known errors, keeping the external envelope identical across workers.
7. **Not-found is handled in two places:** the Hono catch-all route in `src/index.ts` returns `ApiError.notFound()`, and any other uncaught exception also becomes `INTERNAL` 500 — ensuring no raw `NotFoundError` leaks.

## Conventions and constraints

- Every API error has the shape `{ error: { code, message, requestId, details? } }` — documented in `src/lib/errors.ts` and asserted by `test/error.test.ts`.
- Public-facing error codes are uppercase, machine-readable constants produced by `ApiError.*` static factories; routes must not construct arbitrary code strings.
- Client errors (4xx) are logged at `warn` without a stack; unexpected errors (non-`ApiError`, non-`ConfigError`) are logged at `error` with the full stack.
- `ConfigError` is treated as fatal operator information: it is logged fully but surfaced to the client as a generic 500 `INTERNAL`.
- A thrown value that is not an `ApiError` or `ConfigError` is always mapped to 500 `INTERNAL`; there is no fallback that returns the original error body.
- The test suite enforces three concrete invariants: (a) 404 responses carry code `NOT_FOUND` and a truthy `requestId`, (b) `ApiError.badRequest` maps to status 400 with code `BAD_REQUEST` and forwards `details`, (c) unknown exceptions return 500 with code `INTERNAL` and do not leak the original message or the word `stack`.