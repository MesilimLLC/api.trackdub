## Build & Deployment Overview

The Trackdub API monorepo is a Cloudflare Workers project built with **Bun** (package manager and runtime), **Wrangler v4** (`cf` CLI) for worker packaging/deployment, **Drizzle Kit** for D1 migrations, and **Vitest** with the `@cloudflare/vitest-pool-workers` plugin for integration tests running inside a real `workerd` instance.

There are no Makefiles, Dockerfiles, or custom shell build scripts — the entire pipeline is driven by npm/Bun scripts in `package.json` and CI configuration.

## Toolchain

- **Package manager**: Bun `1.4.0` (enforced by `.npmrc`/`bun.lock`; pinned via `packageManager` field).
- **Runtime / compiler**: TypeScript compiled on-demand by Wrangler's esbuild-based bundler; `tsconfig.json` provides shared config.
- **Worker tooling**: `wrangler` v4 (`cf` alias from `@cloudflare/cli`).
- **Database migrations**: `drizzle-kit` v0.31 targeting SQLite over D1 HTTP driver.
- **Testing**: Vitest v4 with `@cloudflare/vitest-pool-workers` so test code runs against real `workerd` bindings (D1, R2, KV, AI).

## Three Workers, One Repo

Three distinct Cloudflare Workers live in one package, each with its own Wrangler config:

| Worker | Config | Entry point | D1 DB |
|---|---|---|---|
| Portal API | `wrangler.jsonc` | `src/index.ts` | `trackdub_api` (DB id `073c...`) |
| Activation | `wrangler.activation.jsonc` | `src/activation/index.ts` | `trackdub_activation` (DB id `f95...`) |
| Docs-RAG | `wrangler.docs-rag.jsonc` | `src/docs-rag/index.ts` | No D1; uses R2 `CORPUS`, AI binding, rate limits |

Each worker has its own compatibility date and flags (e.g., `2025-08-01`, `2026-07-01`, `2026-09-01`) and its own set of secrets/vars injected through Wrangler `vars` blocks.

## Scripts (`package.json`)

Core commands:

- `dev` → `cf dev` (portal worker); `dev:activation` → `cf dev --mode activation` (activation worker);
- `build` → `cf build`;
- `deploy` → `cf deploy` (portal); `deploy:activation` / `deploy:activation:staging` / `deploy:docs-rag` target other workers;
- `test` → `vitest run` (portal suite); `test:activation` → separate Vitest config; `test:all` runs both sequentially;
- `db:generate` / `db:generate:activation` → `drizzle-kit generate` per worker schema;
- `db:migrate:local` / `db:migrate:remote` / `db:migrate:activation:*` → `cf d1 migrations apply` against the concrete D1 database IDs baked into the Wrangler configs.

The docs-rag worker adds a pre-build hook: `predev:docs-rag` and `predeploy:docs-rag` both run `scripts/gen-docs-rag-pin.mjs` to regenerate `src/docs-rag/pin.generated.ts` before the worker starts or deploys.

## Test Harness

Two parallel Vitest configurations share the same pattern:

1. Read D1 migrations at config time via `readD1Migrations()` from `@cloudflare/vitest-pool-workers`.
2. Configure `cloudflareTest({ wrangler: { configPath }, miniflare: { bindings } })` so tests execute inside a real workerd process.
3. A setup file (`test/apply-migrations.ts` for portal, `test/activation/apply-migrations.ts` for activation) applies the read migrations to the isolated per-run D1 instance.

The portal suite excludes `test/activation/**` (see the `include` glob in `vitest.config.ts`); the activation suite is isolated under `vitest.activation.config.ts` with its own signing keypair from `test/activation/test-keys.ts`. Both suites inject mock secrets (`APP_ENV=development`, fake tokens, etc.) directly in `miniflare.bindings` rather than reading env files.

## CI Pipeline

`.github/workflows/ci.yml` runs on push/PR to `main`:

1. Checkout.
2. `oven-sh/setup-bun@v2` with `bun-version: 1.4.0`.
3. `bun install --frozen-lockfile` (lockfile must stay in sync).
4. `bun run typecheck` (`tsc --noEmit`).
5. `bun run test:all` (runs both portal and activation suites).

There is no automated deployment step in CI — only typecheck + tests.

## Migrations

Two independent Drizzle schemas, each with its own migration directory and Drizzle Kit config:

- `drizzle/` generated from `src/db/schema.ts` (via `drizzle.config.ts`) → applied to D1 DB `073c0238-db61-40d3-b1ee-3e7555493a72`.
- `drizzle-activation/` generated from `src/activation/schema.ts` (via `drizzle-activation.config.ts`) → applied to D1 DB `f95337b1-aff5-455d-a0f9-3293211b1727` (or `d64b5d9...` for staging).

Migrations are committed as SQL files alongside their `_journal.json` snapshots; `drizzle-kit generate` rewrites them when the TS schema changes.

## Versioning

The package declares `version: "0.1.0"` but it is marked `private: true` and published as a Cloudflare Worker artifact, not an npm package. There is no semantic-release or manual version bump script in the repo — versioning is external to this repository.

## Key Files

- `package.json` — all scripts, dependencies, Bun pin, dependency overrides.
- `wrangler.jsonc` — portal worker definition (routes, D1, R2, version metadata).
- `wrangler.activation.jsonc` — activation worker (separate domain, DB, trust-ring signing key ID).
- `wrangler.docs-rag.jsonc` — docs-RAG worker (AI binding, R2 corpus, rate limits, CF account id).
- `vitest.config.ts` — portal test harness using workerd pool.
- `vitest.activation.config.ts` — activation test harness with isolated signing keypair.
- `drizzle.config.ts` / `drizzle-activation.config.ts` — Drizzle Kit configs per worker.
- `.github/workflows/ci.yml` — GitHub Actions CI (typecheck + test only).
- `scripts/gen-docs-rag-pin.mjs` — generates `src/docs-rag/pin.generated.ts` (run via `gen:docs-rag-pin` / `check:docs-rag-pin`).
- `bun.lock` — frozen lockfile consumed by CI.