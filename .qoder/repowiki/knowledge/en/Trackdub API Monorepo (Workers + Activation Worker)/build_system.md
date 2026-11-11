## What system/approach is used

The Trackdub API is a Bun-based Cloudflare Workers monorepo. Build, packaging, and deployment are handled entirely by the `cf` CLI (Cloudflare's replacement for Wrangler), with Bun as the package manager and Node toolchain runtime. Tests run inside the real `workerd` runtime via `@cloudflare/vitest-pool-workers`, so there is no separate compilation step — source TypeScript files are bundled directly by the Cloudflare toolchain.

Key tools:
- **Package manager**: Bun 1.4.0 (`packageManager: "bun@1.4.0"` in `package.json`).
- **Build / deploy**: `cf build`, `cf dev`, `cf deploy` (scripts in `package.json`); Wrangler is retained only for legacy docs-rag worker commands.
- **Runtime type generation**: `cf workers types` (`cf-typegen` script).
- **Database migrations**: Drizzle Kit (`drizzle-kit generate`) plus `cf d1 migrations apply` against two D1 databases identified by UUIDs.
- **Testing**: Vitest 4 with the `@cloudflare/vitest-pool-workers` plugin; two parallel test suites — one for the main API, one for the activation worker.
- **CI**: GitHub Actions on `push`/`pull_request` to `main` — installs Bun 1.4.0, runs `bun install --frozen-lockfile`, then `bun run typecheck` and `bun run test:all`.

## Key files and packages

- `package.json` — project entrypoint defining all scripts (`dev`, `build`, `deploy`, `test`, `db:*`, `cf-typegen`, per-worker variants like `dev:activation`, `deploy:activation:staging`). Also pins `@cloudflare/workerd-linux-64` for local workerd execution and grants `allowScripts` for esbuild, workerd, sharp.
- `.github/workflows/ci.yml` — single job `Typecheck & Test` on `ubuntu-latest`, enforces frozen lockfile and runs both test suites.
- `wrangler.jsonc` — main Worker config: name `trackdub-api`, entry `src/index.ts`, D1 binding `DB` → database `trackdub_api` (id `073c0238-...`), R2 bucket `MEDIA`, custom domain `api.trackdub.com`.
- `wrangler.activation.jsonc` — standalone activation Worker: name `trackdub-activation`, entry `src/activation/index.ts`, its own D1 DB `trackdub_activation` (id `f95337b1-...`), custom domain `activate.trackdub.com`, trust-ring signing key id.
- `wrangler.docs-rag.jsonc` — legacy docs-rag worker (still referenced from `package.json` scripts but distinct from the `cf`-based flow).
- `vitest.config.ts` — main test harness using `cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })`, reads migrations from `./drizzle` at config time via `readD1Migrations`, injects them through `__TEST_MIGRATIONS__`, sets miniflare bindings.
- `vitest.activation.config.ts` — parallel harness for the activation worker, reads migrations from `./drizzle-activation`, passes `SIGNING_KEY`, `ALLOW_DEV_LICENSES`, and `TEST_MIGRATIONS` into the workerd sandbox.
- `drizzle.config.ts` / `drizzle-activation.config.ts` — separate Drizzle Kit configs for each D1 database.
- `bunfig.toml` — Bun configuration (referenced by the package manager).

## Architecture and conventions

- **Two independent Workers in one repo**: The main API (`src/index.ts`) and the Activation Worker (`src/activation/index.ts`) are deployed as separate Cloudflare Workers, each with its own Wrangler config, D1 database, migration directory, and test suite. They share code under `src/` (auth, db, lib, middleware) but have disjoint runtime bindings.
- **No explicit bundler invocation**: `cf build` / `cf dev` / `cf deploy` are the only build/deploy entry points. There is no Makefile, Dockerfile, or custom shell script.
- **Environment-driven deployment modes**: Activation deployments use `--mode activation` (production) and `--mode activation-staging` (staging), selected via `package.json` scripts rather than separate Wrangler env files.
- **Migration strategy**: Migrations live in version-controlled directories (`drizzle/` for the main DB, `drizzle-activation/` for the activation DB). Generation goes through `drizzle-kit generate`; application uses `cf d1 migrations apply <uuid> [--local] --dir <path>` against pinned database IDs. Local development applies to an in-memory SQLite instance.
- **Test isolation**: Each test suite gets its own isolated D1 instance populated by the injected migrations. The main suite excludes `test/activation/**` (commented out explicitly in `vitest.config.ts`), and the activation suite excludes non-activation tests.
- **Dependency pinning**: `bun.lock` is committed; CI uses `bun install --frozen-lockfile`. Bun 1.4.0 is pinned in both `package.json` and the GitHub Action.

## Conventions and constraints

- **Package manager**: All dependency resolution must go through Bun 1.4.0 (enforced by `packageManager` field and CI's `oven-sh/setup-bun@v2` with `bun-version: 1.4.0`).
- **Lockfile integrity**: CI requires `bun install --frozen-lockfile`, preventing uncommitted lockfile drift from being accepted in PRs.
- **Type checking before testing**: The CI job runs `bun run typecheck` (`tsc --noEmit`) before `bun run test:all`; a failing type check blocks the pipeline.
- **Both test suites must pass**: `test:all` is defined as `bun run test && bun run test:activation`, so adding a new Worker without a corresponding test suite will cause CI failure when `test:all` is invoked.
- **Worker entry points**: New Workers follow the convention of a dedicated Wrangler `<name>.jsonc` file plus a `src/<worker>/index.ts` entry, paired with a matching `vitest.<worker>.config.ts` and `drizzle-<worker>.config.ts`.
- **D1 database identity**: Database migrations are applied against hard-coded database UUIDs (e.g. `073c0238-db61-40d3-b1ee-3e7555493a72` for the main DB, `f95337b1-aff5-455d-a0f9-3293211b1727` for activation). Scripts embed these IDs, tying the codebase to specific D1 instances.
- **Custom domains over workers.dev**: Both Workers set `workers_dev: false` and declare custom routes (`api.trackdub.com`, `activate.trackdub.com`), indicating production deploys bypass the default subdomain.
- **Observability enabled**: Both Wrangler configs enable `observability.enabled: true`.
- **Compatibility flags**: Both Workers opt into `nodejs_compat` with different compatibility dates (2025-08-01 for main, 2026-07-01 for activation).
- **Secret management**: Secrets such as signing keys and admin tokens are not checked in; they are expected to be provisioned via `wrangler secret put` (documented in `wrangler.activation.jsonc` comments around `SIGNING_KEY_ID`).

There is no Dockerfile, no cross-compile step, and no release artifact produced beyond the Cloudflare Worker bundle emitted by `cf build`. Versioning is tied to Git commits (the `package.json` version `0.1.0` is private and not published to npm).