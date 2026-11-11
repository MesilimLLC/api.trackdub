## Approach

The application is a Cloudflare Workers monorepo (portal API + activation Worker) that loads runtime configuration through three layers:

1. **Deployment manifests** — `cloudflare.config.ts` (the canonical config for the new `cf` CLI, replacing Wrangler JSONC files) defines both workers and binds D1/R2 resources, secrets, and text variables via `bindings.text()`, `bindings.secret()`, `bindings.d1()`, `bindings.r2()`, and `bindings.versionMetadata()`.
2. **Legacy Wrangler configs** — `wrangler.jsonc`, `wrangler.activation.jsonc`, `wrangler.activation.staging.jsonc`, and `wrangler.docs-rag.jsonc` are kept as legacy / dev fallbacks; the comment in `cloudflare.config.ts` explicitly states that one file defines one worker per evaluation and that mode selects which worker to deploy (`--mode activation`, `--mode activation-staging`, default = portal API).
3. **Runtime validation** — Each Worker validates its own `env` object on first request using **Zod schemas**, grouping values into `secrets`, `public`, and derived fields. Results are memoized per process via module-level `let cached` variables.

## Key Files

- `src/config/env.ts` — Portal API config loader: validates `BETTER_AUTH_SECRET`, `ADMIN_API_TOKEN`, `APP_ENV`, `PORTAL_ORIGIN`; checks presence of `DB`/`MEDIA` bindings; derives `allowedOrigins` by appending `LOCAL_DEV_ORIGINS` (`http://localhost:8080`, `:5173`, `:3000`) to `PORTAL_ORIGIN`.
- `src/activation/config.ts` — Activation Worker config loader: mirrors the portal pattern with its own separate cache so the two Workers never hold each other's secrets; additionally enforces `ALLOW_DEV_LICENSES !== "true" when APP_ENV=production` (fail-closed safety rule).
- `src/types/env.ts` — Single source of truth for the `Bindings` interface describing all Cloudflare bindings + injected vars (`DB`, `MEDIA`, `APP_ENV`, `PORTAL_ORIGIN`, `DUB_PROCESSOR_ENABLED`, `BETTER_AUTH_SECRET`, `ADMIN_API_TOKEN`, `RESEND_API_KEY`, `CF_VERSION_METADATA`). The comment says it is "kept in one place so `wrangler.jsonc` and code stay in sync."
- `cloudflare.config.ts` — Canonical deployment manifest defining `portalWorker`, `activationWorker`, `activationStagingWorker`, `activationLocalWorker` with their domains, observability, env, and binding declarations.
- `wrangler.jsonc`, `wrangler.activation.jsonc` — Legacy Wrangler JSONC configs mirroring vars/D1/R2 declarations.
- `.dev.vars` / `.dev.vars.example` — Local-only secrets loaded by `cf dev` (documented as not part of `cloudflare.config.ts`).

## Architecture & Conventions

- **Per-worker isolation**: The activation Worker has its own `loadActivationConfig` with its own memoization cache and its own `ActivationConfigError`. The comment explains this is deliberate: sharing would mean each Worker validating and holding references to the other's secrets.
- **Three-tier secret/public/binding classification** is enforced by schema groups:
  - `secretsSchema`: values never logged or sent to clients (`BETTER_AUTH_SECRET`, `ADMIN_API_TOKEN`, `SIGNING_KEY`).
  - `publicSchema`: values safe to expose (`APP_ENV`, `PORTAL_ORIGIN`, `ACTIVATION_ISSUER`, `ACTIVATION_AUDIENCE`, `SIGNING_KEY_ID`).
  - Binding presence checks (`env.DB`, `env.MEDIA`) run before parsing and produce aggregate error messages.
- **Fail-fast validation**: Invalid configuration throws `ConfigError` / `ActivationConfigError` with an aggregated, secret-free message listing every missing/malformed field. There is no graceful degradation path at startup.
- **Memoization**: Both loaders use a module-level `cached` variable returning the same object on subsequent calls. Test helpers `__resetConfigCache()` and `__resetActivationConfigCache()` clear the caches between Vitest cases.
- **Environment name gating**: `APP_ENV` is restricted to the enum `["development", "staging", "production"]` with a default of `"production"`; the activation loader additionally rejects `ALLOW_DEV_LICENSES=true` when `APP_ENV=production`.
- **Binding type contract**: `src/types/env.ts` is the single definition of `Bindings`; `cloudflare.config.ts` declares the same names via `bindings.*()` calls, keeping them in sync by hand (no codegen).
- **Secrets storage**: Secrets go through `bindings.secret()` in `cloudflare.config.ts` and are set via `wrangler secret put` in production; locally they come from `.dev.vars`.
- **Version metadata**: `CF_VERSION_METADATA` is injected via `bindings.versionMetadata()` and typed as `{ id: string; tag?: string }`.

## Conventions & Enforced Rules

- All runtime configuration is validated with Zod at first request; there is no environment variable loading library — values are read directly from the Cloudflare `env` bindings passed into `loadConfig` / `loadActivationConfig`.
- `APP_ENV` must be one of `development`, `staging`, `production`; any other value causes a `ConfigError`.
- `PORTAL_ORIGIN` must be a valid URL (Zod `.url()`).
- `BETTER_AUTH_SECRET` and `ADMIN_API_TOKEN` must be present and at least 16 characters.
- The activation Worker requires `SIGNING_KEY` to contain the substring `BEGIN PRIVATE KEY` (enforcing PKCS#8 PEM format).
- `ALLOW_DEV_LICENSES=true` is rejected when `APP_ENV=production` (explicit fail-closed safety check in `src/activation/config.ts`).
- Missing D1/R2 bindings surface as explicit issues: `D1 binding 'DB' is not bound` / `R2 binding 'MEDIA' is not bound`.
- Errors thrown by the config loaders aggregate all individual validation failures into a single multi-line message with secret values excluded.
- Per-worker config caches are resettable only through the exported `__reset*ConfigCache()` test helpers, not via a public API.
- The `cf` CLI is the authoritative deployment tool (`cloudflare.config.ts`); legacy `wrangler.jsonc` files are retained but the comment documents that secret-like files (`.dev.vars*`) are not read by `cf` and are not part of the TypeScript config.