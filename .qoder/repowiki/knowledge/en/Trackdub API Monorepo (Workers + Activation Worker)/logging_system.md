# Logging System

## Approach
The application uses a minimal, self-contained structured logging layer built on top of Cloudflare Workers' native `console.*` output. There is no third-party logger library; the entire system lives in `src/lib/logger.ts` and is consumed throughout the app.

## Key Files
- `src/lib/logger.ts` — single-file logger module (the only place that emits log lines).
- `src/middleware/logging.ts` — request access-log middleware that logs method, path, status, duration, and requestId per request.
- `src/activation/middleware.ts` — parallel logging middleware for the standalone activation worker (mirrors the main app's pattern).
- `src/middleware/error.ts` — error handler that logs handled vs. unhandled errors at warn/error level.
- Route files (`routes/admin.ts`, `routes/health.ts`) and `lib/mail.ts` use the logger for domain events.

## Architecture

### Logger API
`logger` exports four methods matching the standard levels: `debug`, `info`, `warn`, `error`. Each takes `(message: string, fields?: LogFields)` and emits one JSON object per line:

```json
{"level":"info","message":"request","time":"2026-11-09T...","requestId":...,"method":...,"path":...,"status":...,"durationMs":...}
```

The `LogFields` type defines the canonical set of cross-cutting fields: `requestId`, `method`, `path`, `status`, `durationMs`, plus an open index signature `[key: string]: unknown` for arbitrary domain fields.

### Sink / Routing
Emission goes through `console.log` / `console.warn` / `console.error` depending on level. The file comment states this is intentional because "Workers routes console.* to the observability pipeline." There is no additional sink, rotation, or remote transport in code.

### Structured Fields Convention
- Every request is logged by `requestLogging` middleware with `requestId`, `method`, `path`, `status`, `durationMs`.
- Error paths consistently include `requestId` and a short `code` (e.g., `err.code`), plus `message` and `status` when available.
- Domain events attach contextual key-value pairs as extra fields (e.g., `to` on email-sent, `d1 health probe failed`).
- Secrets and request bodies are explicitly excluded — stated as a design rule in the logger module's JSDoc.

### Log Levels Used
- `debug` — exported but not observed in the searched source; used only if callers add it.
- `info` — normal flow milestones (request received, email sent, configuration notes like mail disabled).
- `warn` — recoverable failures (invite failed, D1/probe failure, handled error).
- `error` — non-recoverable failures (unhandled error, email send threw, activation config error).

### Middleware Integration
Both the main app (`src/middleware/logging.ts`) and the activation worker (`src/activation/middleware.ts`) wrap handlers with a timing middleware that records `Date.now()` before `await next()` and computes `durationMs` after, ensuring status/duration are known. The main app integrates it via Hono's middleware pipeline; the activation worker follows the same shape.

## Conventions and Constraints

**Observed conventions:**
- All log lines are single-line JSON objects — never multi-line strings — so Workers Logs / Logpush can index fields.
- Message text is kept short and constant-ish (e.g., `"request"`, `"handled error"`, `"unhandled error"`, `"password reset email sent"`); structured data goes into the `fields` object.
- Cross-cutting correlation is done via `requestId`, injected elsewhere and read from `c.get("requestId")`.
- Errors are split between `warn` (handled, expected) and `error` (unhandled, unexpected) in both the main and activation middleware stacks.
- Mail-related logging distinguishes disabled mode (`RESEND_API_KEY` absent) as an informational note rather than a warning.

**Enforced rules (from source):**
- The logger module's JSDoc declares: "Never logs secrets or request bodies" — callers rely on the typed `LogFields` interface and do not pass raw request payloads.
- Only the four levels defined in the local `LogLevel` union are emitted; there is no way to emit arbitrary-level logs outside this API.
- Each call to `logger.*` produces exactly one `JSON.stringify(...)` line — no batching, no buffering.

## Notes
- No log-level filtering is implemented at runtime; all levels are emitted regardless of environment.
- No file/HTTP/remote sinks beyond Workers' default console routing.
- Tests under `test/` do not appear to assert on log output (grep found no `logger` usage in test files), so logging behavior is not covered by the existing test suite.