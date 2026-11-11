## What system/approach is used

The Trackdub API uses a two-layer configuration system for Cloudflare Workers:

1. **Worker definition & binding resolution** — the new `cf/config` package (`cloudflare.config.ts`) declares each Worker's entrypoint, compatibility flags, domains, D1/R2 bindings, environment variables, and secrets using `bindings.text()`, `bindings.d1()`, `bindings.r2()`, `bindings.secret()`, and `bindings.versionMetadata()`. It selects which Worker to run based on `--mode` (`activation`, `activation-staging`, `activation-local`, or default portal).
2. **Runtime validation** — each Worker has its own loader in `src/config/env.ts` (portal) and `src/activation/config.ts` (activation worker), both built on **Zod**. They parse `env` (the Cloudflare `Bindings` interface) into typed `AppConfig` / `ActivationConfig` objects, grouping fields into `secrets`, `public`, and derived values.
3. **Legacy Wrangler fallback** — `wrangler.jsonc` still exists as a schema-backed reference with `vars`, `d1_databases`, `r2_buckets`, and `version_metadata`, but the canonical source of truth is `cloudflare.config.ts`.
4. **Local development** — `.dev.vars` files are loaded by `cf dev` automatically (documented explicitly in the comment at the top of `cloudflare.config.ts`); they are not part of the TypeScript config file.

## Key files and packages

- `cloudflare.config.ts` — single-file multi-worker declaration using `cf/config`; defines portal (`trackdub-api`), activation, activation-staging, and activation-local workers; switches via `defineConfig(({ mode }) => ...)`.
- `src/types/env.ts` — single `Bindings` interface that mirrors what Wrangler injects; kept in one place so `wrangler.jsonc` and code stay in sync.
- `src/config/env.ts` — portal Worker config loader: Zod schemas for `secrets` (`BETTER_AUTH_SECRET`, `ADMIN_API_TOKEN`) and `public` (`APP_ENV`, `PORTAL_ORIGIN`), plus presence checks for `DB`/`MEDIA` bindings; memoizes result in a module-level `cached` variable; exposes `__resetConfigCache()` for tests.
- `src/activation/config.ts` — parallel loader for the activation Worker with its own Zod schemas (`SIGNING_KEY`, `ADMIN_API_TOKEN`, `ACTIVATION_ISSUER`, `ACTIVATION_AUDIENCE`, `SIGNING_KEY_ID`, `APP_ENV`); enforces that `ALLOW_DEV_LICENSES=true` is rejected when `APP_ENV=production` ("fail closed").
- `wrangler.jsonc` — legacy/parallel config referencing the same D1/R2 bindings and vars; acts as a schema-checked mirror.
- `src/index.ts` — the portal entrypoint calls `loadConfig(c.env)` once per request (memoized) to obtain CORS allowed origins.

## Architecture and conventions

### Separation of secrets vs. public vs. bindings

Both loaders split env into three buckets (documented in the JSDoc):

| Bucket | Examples | Handling |
|--------|----------|----------|
| `secrets` | `BETTER_AUTH_SECRET`, `ADMIN_API_TOKEN`, `SIGNING_KEY`, `RESEND_API_KEY` | Never logged, never sent to client; validated with `z.string().min(16)` or custom constraints (e.g. PKCS#8 PEM check). |
| `public` | `APP_ENV`, `PORTAL_ORIGIN`, `ACTIVATION_ISSUER`, `ACTIVATION_AUDIENCE` | Safe to expose; parsed with `z.enum(["development", "staging", "production"])` and URL validators. |
| `bindings` | `DB` (D1), `MEDIA` (R2) | Presence-only checks (`if (!env.DB) issues.push(...)`), not type-parsed. |

### Memoization

Each loader caches its parsed result in a module-scoped `let cached: ... = null` variable and returns it on subsequent calls. This avoids re-validating on every request while keeping the first-request failure path fast.

### One loader per Worker

The activation loader deliberately does not share code with the portal loader because the two Workers have disjoint bindings; sharing would mean each Worker validates and holds references to the other's secrets.

### ConfigError types

Each loader exports a dedicated error class (`ConfigError`, `ActivationConfigError`) so callers can distinguish configuration failures from runtime errors.

### Test helpers

Both loaders export a `__reset*ConfigCache()` function that clears the memoized cache between Vitest cases, ensuring isolation.

### How the portal consumes config

`src/index.ts` imports `loadConfig` and passes it to the Hono CORS middleware to build an allowlist of `allowedOrigins` (configured `PORTAL_ORIGIN` + hardcoded local dev origins `http://localhost:8080`, `http://localhost:5173`, `http://localhost:3000`). The origin check runs per request against this list.

### Environment value sources

- Production/staging values come from `cloudflare.config.ts` via `bindings.text()` / `bindings.secret()`.
- Local development values come from `.dev.vars` (and per-worker variants like `.dev.vars.docs-rag`), loaded by `cf dev`.
- Build-time metadata comes from `CF_VERSION_METADATA` injected via `bindings.versionMetadata()`.

## Conventions and constraints

- **All env is typed through the `Bindings` interface in `src/types/env.ts`**, which documents every Cloudflare binding and injected var in one place. Both `cloudflare.config.ts` and `wrangler.jsonc` should mirror it (comment states the intent).
- **Configuration is validated lazily on first access, not at import time.** Because Cloudflare Workers have no startup hook, validation happens on first request and throws immediately if anything is missing or malformed.
- **Invalid configuration fails fast with an aggregated, secret-free message.** The loader collects all Zod issues and binding-presence issues into a single string and throws `ConfigError` / `ActivationConfigError` with a bulleted list.
- **`APP_ENV` is restricted to the enum `["development", "staging", "production"]`** with a default of `"production"` in both loaders.
- **Secrets are enforced to be ≥ 16 characters** (`BETTER_AUTH_SECRET`, `ADMIN_API_TOKEN`) and `SIGNING_KEY` must contain `BEGIN PRIVATE KEY` (PKCS#8 PEM check).
- **Dev-license bypass is blocked in production:** `ALLOW_DEV_LICENSES === "true"` combined with `APP_ENV === "production"` causes the activation loader to refuse to boot — documented as a "fail closed" safeguard against inheriting local `.dev.vars` into production.
- **CORS is deny-by-default:** only the configured `PORTAL_ORIGIN` plus the three hard-coded localhost origins are accepted; nothing else gets through.
- **Two separate loaders exist per Worker** rather than a shared module, to keep secrets isolated across workers.
- **`.dev.vars` files are excluded from the TypeScript config file** — the top-of-file comment in `cloudflare.config.ts` explicitly lists them as not read by `cf` and not part of the file, even though `cf dev` loads them.