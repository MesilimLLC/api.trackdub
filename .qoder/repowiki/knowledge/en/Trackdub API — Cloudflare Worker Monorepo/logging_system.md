## What system/approach is used

The application implements a minimal, framework-free structured logging layer on top of Cloudflare Workers' built-in `console.*` sinks. There is no external logging library (no Winston, Pino, pino-worker, etc.). Each log line is a single JSON object so that Workers Logs / Logpush can index fields.

## Key files and packages

- `src/lib/logger.ts` — the only logger implementation. Exports a `logger` object with `debug`, `info`, `warn`, `error` methods and defines the `LogFields` shape (`requestId`, `method`, `path`, `status`, `durationMs`, plus arbitrary extras).
- `src/middleware/logging.ts` — Hono middleware `requestLogging` that wraps every request handler to emit one access-log entry after the handler completes.
- `src/activation/middleware.ts` — the activation worker's equivalent request/error middleware, using the same `logger` API.
- Call sites across routes and utilities: `src/routes/admin.ts`, `src/routes/health.ts`, `src/lib/mail.ts`, `src/middleware/error.ts`.

## Architecture and conventions

1. **Single logger singleton.** All modules import `{ logger } from "@/lib/logger"`; there are no per-module logger instances and no configuration surface beyond what the file itself provides.
2. **Structured JSON per line.** `emit()` serializes `{ level, message, time, ...fields }` via `JSON.stringify`. The file header explicitly states the intent: "One object per line so Workers Logs / Logpush can index fields."
3. **Four explicit levels** — `debug | info | warn | error` — mapped onto Workers' native `console.log`, `console.warn`, `console.error` respectively. `debug` goes through `console.log` (same sink as `info`).
4. **Access logging via middleware.** `requestLogging` records `requestId` (from context), HTTP method, pathname, response status, and `durationMs` in milliseconds. It runs after `next()` so those values are available.
5. **Error handling separates handled vs. unhandled errors.** In both the main app (`src/middleware/error.ts`) and the activation worker (`src/activation/middleware.ts`), expected/recoverable failures are logged at `warn` while unexpected/uncaught exceptions use `error`.
6. **No secrets or bodies in logs.** The logger file header documents this rule; call sites consistently pass only identifiers, status codes, durations, and user-facing messages.
7. **Request correlation.** `requestId` is propagated from context (`c.get("requestId")`) into every access/error log line, enabling cross-line tracing within a single request.

## Conventions and constraints

- **Conventional pattern:** Log entries follow the shape `{ level, message, time, [...LogFields] }`. Additional domain-specific fields are spread into the same object via the `...fields` rest parameter of `LogFields`.
- **Conventional pattern:** Access logs always include `requestId`, `method`, `path`, `status`, `durationMs`.
- **Conventional pattern:** Error logs include `requestId` and a human-readable `message`; optional domain fields such as `code` or `status` are added when available.
- **Constraint (documented):** Never log secrets or request bodies — stated in the module docstring of `src/lib/logger.ts`.
- **Constraint (enforced by structure):** Log levels are the fixed union `"debug" | "info" | "warn" | "error"` typed at the source of `emit()`, so callers cannot invent ad-hoc severity names.
- **Sink behavior:** All four levels ultimately go through `console.*`; `error` uses `console.error`, `warn` uses `console.warn`, and `debug`/`info` use `console.log`. The comment asserts that Workers routes these to the observability pipeline.
- **Time format:** Timestamps are emitted as ISO strings via `new Date().toISOString()`.

## Notes on scope

This logging system is shared between the main Hono worker (`src/`) and the parallel activation worker (`src/activation/`), which imports the same `logger` package path. No separate log formatter, rotation, sampling, or remote sink configuration exists in the codebase.