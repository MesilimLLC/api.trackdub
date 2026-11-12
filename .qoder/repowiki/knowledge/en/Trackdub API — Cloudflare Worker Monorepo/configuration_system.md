# Configuration System

## Approach

The Trackdub API monorepo uses Cloudflare Workers as its runtime and layers configuration in three concentric sources:

1. **Build/deploy bindings** — defined in `cloudflare.config.ts` (new `cf/config` schema) and the legacy `wrangler.jsonc` / `wrangler.activation.jsonc` files. These declare which D1 databases, R2 buckets, secrets, and text variables are bound into each Worker.
2. **Runtime environment** — Cloudflare injects the bindings at startup as the `env` object passed to every request handler. Locally, `.dev.vars` (and per-worker variants like `.dev.vars.docs-rag`) supply secrets and vars for `cf dev`.
3. **Application-level validation** — `src/config/env.ts` (portal Worker) and `src/activation/config.ts` (activation Worker) parse and validate the incoming `env` with Zod on first use, memoize the result, and throw a typed error if anything is missing or malformed.

There is no dotenv-style `.env` file read by the application code. All values flow through Cloudflare's binding mechanism, so secrets never touch the source tree.

## Key Files

| File | Role |
|---|---|
| `cloudflare.config.ts` | New `cf/config` entry point; defines four worker profiles (`portalWorker`, `activationWorker`, `activationStagingWorker`, `activationLocalWorker`) and selects one via `--mode`. Centralizes account ID, domains, compatibility flags, observability, and all `bindings.text` / `bindings.secret()` declarations. |
| `wrangler.jsonc` | Legacy Wrangler config for the portal Worker (kept for backward compatibility). Mirrors `cloudflare.config.ts` but only declares `vars`, D1/R2 bindings, and version metadata. |
| `wrangler.activation.jsonc` | Legacy Wrangler config for the activation Worker (production). Defines public vars (`APP_ENV`, `ACTIVATION_ISSUER`, `ACTIVATION_AUDIENCE`, `SIGNING_KEY_ID`) plus D1 bindings. Secrets are supplied separately via `wrangler secret put`. |
| `wrangler.activation.staging.jsonc` | Staging variant of the activation Worker config. |
| `wrangler.docs-rag.jsonc` | Separate deployment for the docs-rag Worker. |
| `src/types/env.ts` | Single source of truth for the `Bindings` TypeScript interface — the contract between `cloudflare.config.ts` and the app code. Includes both runtime bindings and per-request `Variables` set by middleware. |
| `src/config/env.ts` | Portal Worker config loader: Zod schemas for `secrets` (`BETTER_AUTH_SECRET`, `ADMIN_API_TOKEN`) and `public` (`APP_ENV`, `PORTAL_ORIGIN`), presence checks for `DB`/`MEDIA`, memoized `loadConfig()`, and `__resetConfigCache()` for tests. |
| `src/activation/config.ts` | Activation Worker config loader mirroring the same pattern but with activation-specific fields (`SIGNING_KEY`, `ACTIVATION_ISSUER`, `ACTIVATION_AUDIENCE`, `SIGNING_KEY_ID`, `ALLOW_DEV_LICENSES`). Enforces that `ALLOW_DEV_LICENSES=true` cannot leak into production. |
| `src/index.ts` | Entrypoint; calls `loadConfig(c.env)` once per request (memoized) and passes `allowedOrigins` to Hono's CORS middleware. |
| `src/routes/version.ts`, `src/routes/health.ts`, `src/middleware/authorize.ts`, `src/auth/index.ts` | Consumers of `loadConfig`; they import it where needed rather than passing it around, relying on the memoization guarantee. |

## Architecture and Conventions

### Two separate workers, two separate loaders

The portal API and the activation service are deployed as distinct Workers with disjoint bindings. Each has its own loader module (`src/config/env.ts` vs `src/activation/config.ts`) and its own memoized cache. The comment in `src/activation/config.ts` explicitly justifies this split: "sharing the config loader would mean each Worker validating (and holding a reference to) the other's secrets."

### Secret/public/bindings triad

Both loaders group validated configuration into three categories, documented in the module docstring:

- **secrets** — never logged, never sent to clients; validated for presence and minimum length (or PKCS#8 PEM format for `SIGNING_KEY`).
- **public** — safe to expose; includes `APP_ENV` (enum: `development` | `staging` | `production`) and endpoint URLs.
- **bindings** — runtime objects (`D1Database`, `R2Bucket`); only presence-checked, not parsed.

This grouping drives the error aggregation strategy: all issues are collected before throwing a single `ConfigError` / `ActivationConfigError`, giving operators a complete picture of what's wrong.

### Lazy, memoized loading

`loadConfig` caches its result in a module-level `cached` variable and returns immediately on subsequent calls. This is intentional because "Cloudflare Workers have no real 'startup' hook" — validation happens on the first request instead. A test helper (`__resetConfigCache`, `__resetActivationConfigCache`) clears the cache between Vitest cases.

### Fail-fast, fail-closed policy

Invalid configuration throws a typed error rather than returning `undefined` or defaulting silently. The activation loader adds an extra safety check: `ALLOW_DEV_LICENSES === "true"` combined with `APP_ENV === "production"` is rejected outright, with a comment explaining the rationale — "a production deploy that inherits ALLOW_DEV_LICENSES from a local .dev.vars would hand out uncapped licenses. Refuse to boot rather than serve that."

### Origin allowlist construction

Portal config derives `allowedOrigins` from `PORTAL_ORIGIN` plus a hardcoded list of local development origins (`http://localhost:8080`, `http://localhost:5173`, `http://localhost:3000`). This allowlist is fed directly into Hono's CORS middleware.

### Environment-driven behavior

`APP_ENV` drives branching logic (e.g., whether dev licenses are allowed). `DUB_PROCESSOR_ENABLED` is declared in `Bindings` as an optional flag used to gate features when a real dub queue consumer is deployed. `CF_VERSION_METADATA` is injected at build/deploy time and surfaced to the `/version` route.

## Conventions and Constraints

- **No application-side env-file parsing.** Values come exclusively from Cloudflare bindings; `.dev.vars` is consumed only by `cf dev`, not by the app. (Documented in `cloudflare.config.ts` header comment.)
- **One source of truth for binding types.** `src/types/env.ts` declares the `Bindings` interface that both `cloudflare.config.ts` and the Zod schemas target. The file comment states: "Kept in one place so `wrangler.jsonc` and code stay in sync."
- **Secrets are declared with `bindings.secret()` in `cloudflare.config.ts` and managed via `wrangler secret put` / Cloudflare dashboard.** They do not appear in any JSONC or TS config file.
- **Public text vars are declared with `bindings.text(...)` and may include defaults.** Examples: `APP_ENV`, `PORTAL_ORIGIN`, `ACTIVATION_ISSUER`, `ACTIVATION_AUDIENCE`, `SIGNING_KEY_ID`.
- **Each Worker profile lives in `cloudflare.config.ts` and is selected via `--mode`** (`activation`, `activation-staging`, `activation-local`, or default portal). There is no shared base object — duplication is deliberate to avoid cross-worker secret leakage.
- **Configuration validation uses Zod schemas** with explicit `required_error` messages that become the user-facing error text when thrown.
- **Tests reset the memoized cache** via the exported `__reset*ConfigCache()` helpers before each case.
- **`APP_ENV` is constrained to the enum `["development", "staging", "production"]`**; non-matching values cause a validation failure.
- **Legacy Wrangler JSONC configs (`wrangler.jsonc`, `wrangler.activation.jsonc`, etc.) remain alongside the new `cloudflare.config.ts`** but are superseded by the latter for new deployments.