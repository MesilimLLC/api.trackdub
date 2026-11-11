Two independent Cloudflare Workers share this repository as sibling projects:
- Main API (`src/index.ts`, `wrangler.jsonc`): Hono app with Better Auth, D1-backed DB, R2 media, and routes/middleware/lib/ types under `src/`. Migrations live in `drizzle/`.
- Activation Worker (`activation/`): Separate Wrangler config targeting a different D1 database (`f95333b1-aff5...`) with its own migration directory `drizzle-activation/`.

Cross-child wiring is via shared npm scripts in `package.json`: `db:migrate:local|remote` target the main D1 binding `DB`, while `db:migrate:activation:*` target the activation D1 binding. Both workers use the same dev/test toolchain — `cf dev` / `cf deploy` for runtime, `vitest` with `@cloudflare/vitest-pool-workers` for execution, and `drizzle-kit` for schema generation. The activation worker is invoked through dedicated scripts (`dev:activation`, `test:activation`) that pass `--mode activation` to cf CLI or point at `vitest.activation.config.ts`.

Environment isolation is enforced by per-worker `.dev.vars` files and separate D1 database IDs; there is no shared runtime code between the two workers — they communicate only over HTTP.