## Approach

The Trackdub API monorepo uses **Bun** as its package manager and lockfile format. There is no `node_modules` vendoring; dependencies are resolved from the public npm registry (no private registry configured).

## Key Files

- `package.json` — single root manifest declaring runtime and dev dependencies, scripts, `allowScripts`, and `overrides`.
- `bun.lock` — Bun lockfile (lockfileVersion 3) pinning every transitive dependency with integrity hashes.
- `.npmrc` — sets `legacy-peer-deps=true` to suppress peer-dependency resolution errors.
- `scripts/gen-docs-rag-pin.mjs` — generates a pinned import map (`src/docs-rag/pin.generated.ts`) used by the docs-rag worker to lock Model Context Protocol server versions at build time.

## Package Layout

Single-package layout (not a workspace): `"workspaces": { "": { ... } }` in the lockfile indicates the root directory is the only package. All source code under `src/`, plus the activation worker configuration, share one dependency graph.

## Versioning Strategy

Most runtime dependencies use caret ranges (e.g. `^4.13.8` for hono, `^0.45.2` for drizzle-orm), while a few critical packages are pinned exactly:
- `@modelcontextprotocol/client`: `2.0.0`
- `@modelcontextprotocol/server`: `2.0.0`
- `better-auth`: `1.6.25`
- `@cloudflare/workerd-linux-64`: `^1.20260731.1`

Dev dependencies similarly mix caret ranges and exact pins (e.g. `wrangler: ^4.152.0`, `vitest: ^4.1.11`).

## Lockfile & Reproducibility

`bun.lock` is committed to the repo and serves as the single source of truth for installed versions. The `packageManager` field (`"bun@1.4.0"`) enforces that developers use this specific Bun version via Corepack-style resolution.

## Script-driven Pinning

The docs-rag worker has a two-step process controlled by `package.json` scripts:
- `predev:docs-rag` / `predeploy:docs-rag` run `scripts/gen-docs-rag-pin.mjs` to regenerate `src/docs-rag/pin.generated.ts`.
- `check:docs-rag-pin` runs the same script in `--check` mode, which CI can invoke to fail if the generated file drifts from the current dependency tree.

This pins the MCP server's own dependency versions independently of the top-level lockfile.

## Overrides and Allowed Scripts

- `overrides.zod` forces `@modelcontextprotocol/sdk` to resolve `zod@3.25.76` regardless of what its declared range asks for, resolving a version conflict in the MCP SDK subtree.
- `allowScripts` explicitly whitelists native/script packages that install platform binaries: `esbuild`, `workerd`, `sharp`, `@cloudflare/workerd-linux-64`, `@cloudflare/workerd-windows-64`, and `es5-ext@0.10.64`. This acts as a local security policy preventing arbitrary postinstall scripts from running without explicit approval.

## Peer Dependencies

Peer dependency resolution is disabled globally via `.npmrc` `legacy-peer-deps=true`, so installing dependencies ignores missing or conflicting peer declarations rather than failing. This is a pragmatic choice for the Cloudflare Workers toolchain (wrangler, cf, vitest-pool-workers) which often declares loose peer ranges.

## No Private Registry

No `.npmrc` entries point to an internal registry, and no `GOPRIVATE`-style variables exist. All packages come from the public npm registry.

## Conventions Observed

- Single `package.json` at the repo root; no per-worker subpackages.
- Runtime vs dev dependencies are clearly separated between `dependencies` and `devDependencies`.
- Sensitive or frequently-changing transitive versions are overridden via the `overrides` field rather than duplicated across the tree.
- Native/script packages require explicit `allowScripts` approval before installation.
- MCP-related versions are re-pinned through the `gen-docs-rag-pin` script, keeping the worker's bundled servers deterministic.