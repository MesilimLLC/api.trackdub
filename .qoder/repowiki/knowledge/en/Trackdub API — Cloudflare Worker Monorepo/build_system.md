# Build & Artifact Management

## Approach

The project is a **Cloudflare Workers monorepo** (one `package.json`, two worker entry points) built and deployed exclusively through the Cloudflare ecosystem, with Bun as the package manager and runtime. There are no Makefiles, Dockerfiles, or custom build scripts — all orchestration lives in `package.json` scripts backed by `wrangler`, `cf`, `drizzle-kit`, and `vitest`.

## Key Files

- `package.json` — single source of truth for scripts (`dev`, `build`, `deploy`, `test:all`, `db:migrate:*`, `deploy:activation`, `predeploy:docs-rag`, …), dependencies, and Bun-specific `allowScripts` / `overrides`.
- `bunfig.toml` — enforces `saveTextLockfile = true` and `minimumReleaseAge = 86400` (24-hour supply-chain guard that skips packages published less than a day ago).
- `.github/workflows/ci.yml` — GitHub Actions job on push/PR to `main`: checks out code, sets up Bun 1.4.0 via `oven-sh/setup-bun@v2`, runs `bun install --frozen-lockfile`, then `bun run typecheck` and `bun run test:all`.
- `wrangler.jsonc` — main worker config (`src/index.ts`, D1 `trackdub_api`, R2 `MEDIA`, custom domain `api.trackdub.com`).
- `wrangler.activation.jsonc` — standalone activation worker (`src/activation/index.ts`, D1 `trackdub_activation`, custom domain `activate.trackdub.com`, separate `compatibility_date`).
- `wrangler.docs-rag.jsonc` — docs-rag worker configuration.
- `drizzle.config.ts` / `drizzle-activation.config.ts` — Drizzle Kit configs generating SQL into `drizzle/` and `drizzle-activation/` from their respective schema files.
- `vitest.config.ts` / `vitest.activation.config.ts` — two Vitest harnesses using `@cloudflare/vitest-pool-workers` to run tests inside the real `workerd` runtime against per-run isolated D1 databases.
- `tsconfig.json` — strict TS settings, `noEmit: true`, `moduleResolution: "Bundler"`, path alias `@/* → ./src/*`.
- `scripts/gen-docs-rag-pin.mjs` — generates `pin.generated.ts` consumed by the docs-rag worker; invoked via `gen:docs-rag-pin` and as a `pre*` hook.

## Architecture and Conventions

### Multi-worker layout behind one script surface

Each Cloudflare Worker has its own Wrangler config file (`wrangler.jsonc`, `wrangler.activation.jsonc`, `wrangler.docs-rag.jsonc`) and its own migration directory (`drizzle/`, `drizzle-activation/`). The root `package.json` exposes parallel script families:

| Area | Scripts |
|---|---|
| Main worker | `dev`, `build`, `deploy`, `db:generate`, `db:migrate:local`, `db:migrate:remote` |
| Activation worker | `dev:activation`, `dev:activation:local`, `deploy:activation`, `deploy:activation:staging`, `test:activation`, `db:generate:activation`, `db:migrate:activation:{local,staging,remote}` |
| Docs-rag worker | `dev:docs-rag`, `deploy:docs-rag` (with `predeploy:docs-rag` pin generation) |
| Shared | `test:all` (runs both suites), `typecheck`, `cf-typegen` |

The activation worker is distinguished at deploy time by `--mode activation` / `--mode activation-staging` passed through to `cf dev` / `cf deploy`.

### Database migrations

Drizzle Kit is the single source of truth for schema changes. Migrations are generated into `drizzle/` (or `drizzle-activation/`) and applied either locally against an in-memory D1 instance (`--local`) or remotely against the production/staging D1 database identified by its UUID in each Wrangler config. The D1 database IDs are hard-coded in the Wrangler JSONC files, so migration targets are environment-bound at config time.

### Testing model

Two independent Vitest configurations target the two workers:

- `vitest.config.ts` includes only `test/*.test.ts` and reads migrations from `./drizzle` at config time, injecting them into the worker via `__TEST_MIGRATIONS__` and `setupFiles: ["./test/apply-migrations.ts"]`.
- `vitest.activation.config.ts` includes only `test/activation/**/*.test.ts`, reads `./drizzle-activation`, and injects a test signing keypair from `test/activation/test-keys.ts` (a plain module chosen specifically so it can be imported from workerd without pulling Node-only tooling into the bundle).

Both use `@cloudflare/vitest-pool-workers`'s `cloudflareTest` plugin to spin up a real `workerd` process per test run, bound to the corresponding Wrangler config's bindings.

### CI contract

`.github/workflows/ci.yml` is intentionally minimal: it pins Bun to exactly `1.4.0` (matching `packageManager` in `package.json`), installs with `--frozen-lockfile` (enforcing lockfile fidelity), then runs typechecking and the full test suite. There is no deploy step in CI — deployments are manual.

### Supply-chain constraints

`bunfig.toml` sets `minimumReleaseAge = 86400`, which causes `bun install` to reject any package version published less than 24 hours ago. This is enforced at install time by Bun itself, not by CI.

## Rules and Constraints

1. **Package manager is pinned**: `packageManager: "bun@1.4.0"` plus CI's `oven-sh/setup-bun@v2` with `bun-version: 1.4.0` enforce that development and CI use the same Bun release.
2. **Lockfile is immutable in CI**: `bun install --frozen-lockfile` fails if `bun.lock` is out of sync with `package.json`.
3. **No emitted JS**: `tsconfig.json` has `noEmit: true`; the Cloudflare toolchain compiles TypeScript in memory during `cf build` / `cf dev`.
4. **Strict TypeScript**: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`, `isolatedModules` are all enabled.
5. **Worker entrypoints are fixed per config**: each `wrangler.*.jsonc` declares exactly one `main` field (`src/index.ts`, `src/activation/index.ts`, etc.); there is no dynamic entrypoint resolution.
6. **D1 database identity is config-bound**: each Wrangler config hard-codes the D1 database name and UUID; migration scripts reference those same IDs (`cf d1 migrations apply <uuid> ...`).
7. **Activation worker is a separate deployment surface**: it has its own Wrangler config, Drizzle config, migration directory, test config, and `package.json` scripts (`deploy:activation`, `deploy:activation:staging`, `test:activation`, …); it cannot be accidentally mixed with the main worker.
8. **Docs-rag pin is regenerated before deploy**: `predeploy:docs-rag` runs `node scripts/gen-docs-rag-pin.mjs`, and `check:docs-rag-pin` verifies the generated file is up to date.
9. **Supply-chain age gate**: `bunfig.toml`'s `minimumReleaseAge = 86400` rejects freshly published packages at install time.
10. **CI does not deploy**: the workflow only typechecks and tests; `deploy` / `deploy:activation` / `deploy:docs-rag` are developer-invoked commands.