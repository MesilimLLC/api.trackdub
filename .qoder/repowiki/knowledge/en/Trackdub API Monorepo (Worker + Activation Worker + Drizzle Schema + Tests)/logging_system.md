## What system/approach is used

The application uses a minimal, self-contained structured-JSON logger built on the Cloudflare Workers `console.*` family. There is no third-party logging framework (e.g. pino, winston, bunyan). The Workers runtime routes `console.log`, `console.warn`, and `console.error` to its observability pipeline, so each log line is emitted as one JSON object — one per line — which lets Workers Logs / Logpush index fields directly.

## Key files and packages

- `src/lib/logger.ts` — the only logger implementation; exports a singleton `logger` with `debug`, `info`, `warn`, `error` methods.
- `src/middleware/logging.ts` — request access-log middleware that records method, path, status, duration, and requestId.
- `src/activation/middleware.ts` — equivalent request/error logging for the standalone activation worker.
- `src/middleware/error.ts` — central error handler that logs handled errors, configuration errors, and unhandled exceptions.
- Route files (`src/routes/admin.ts`, `src/routes/health.ts`) and `src/lib/mail.ts` call `logger.info/warn/error` at business boundaries.

## Architecture and conventions

**Logger API.** `logger` exposes four level-specific functions: `debug(message, fields?)`, `info(message, fields?)`, `warn(message, fields?)`, `error(message, fields?)`. Each call serializes `{ level, message, time, ...fields }` via `JSON.stringify` and emits it through the matching `console.*` method. There is no global log-level filter — all levels are always emitted.

**Structured fields.** The typed `LogFields` interface defines the standard set of request-scoped fields: `requestId`, `method`, `path`, `status`, `durationMs`, plus an open `[key: string]: unknown` index for domain-specific attributes. All logged objects conform to this shape; the comment explicitly documents the field convention.

**Request correlation.** A unique `requestId` is attached to every log line produced by the request middleware and the activation middleware. Callers obtain it from `c.get("requestId")` (set by the separate request-id middleware) and pass it in the fields object.

**Access logging pattern.** The request middleware wraps every route: it timestamps before calling `next()`, then logs after the handler returns so `c.res.status` and elapsed milliseconds are known. This is mirrored in `src/activation/middleware.ts`.

**Error handling pattern.** Errors are split into three categories:
1. *Handled errors* (business errors caught by route/middleware handlers) — logged at `warn` with `code`, `status`, and a sanitized `message`.
2. *Configuration errors* — logged at `error` when required environment/config values are missing.
3. *Unhandled errors* — logged at `error` inside the top-level error handler when an exception escapes all layers.

**Security constraint.** The module header states a rule: "Never logs secrets or request bodies." Call sites follow this by passing only explicit, whitelisted fields rather than dumping the full request/response.

## Conventions and constraints

- **One JSON object per line.** Every log entry is a single-line JSON string produced by `JSON.stringify`; consumers (Workers Logs / Logpush) parse it as structured records.
- **Levels map 1:1 to `console.*`.** `debug`/`info` → `console.log`, `warn` → `console.warn`, `error` → `console.error`. No additional filtering or redaction layer exists beyond the documented prohibition on secrets/request bodies.
- **Standard fields are supplied by middleware, not per-call.** Request-scoped fields (`requestId`, `method`, `path`, `status`, `durationMs`) come from the access-log middleware; business code adds domain fields on top.
- **No log-level configuration.** The logger has no option to raise/lower the minimum level; all four levels are always written to stdout.
- **Structured schema enforced by TypeScript.** `LogFields` types the second argument of every logger method, so callers cannot accidentally pass non-object payloads.
- **Error messages avoid raw stack traces.** Error middleware extracts `err.code`, `err.status`, and `err.message` but does not stringify the whole exception object, keeping output structured and secret-free.