# Dependency Management in Trackdub API

## System / Approach

The repository uses **Bun** as its package manager for a single-package (monorepo) project. The lockfile is `bun.lock` (lockfile version 3), which records the exact resolved dependency tree alongside the loose semver ranges declared in `package.json`. There is no workspace configuration — the root `package.json` is the only manifest.

Cloudflare Workers tooling (`cf`, `wrangler`) and the runtime worker binaries are installed as dependencies, so the build/deploy pipeline is entirely driven by Bun + the Cloudflare CLI rather than Node/npm or Yarn.

## Key Files

- `package.json` — sole dependency manifest; declares `packageManager: "bun@1.4.0"`, runtime deps, dev deps, scripts, `allowScripts`, and an `overrides` block.
- `bun.lock` — Bun's deterministic lockfile (v3). It pins every transitive dependency to a specific sha512 digest, including `@cloudflare/workerd-linux-64` and other native binaries.
- `.npmrc` — contains a single line: `legacy-peer-deps=true`, which tells the resolver to ignore peer-dependency mismatches during install.
- `drizzle.config.ts` / `drizzle-activation.config.ts` — Drizzle Kit configs reference local node_modules; they rely on the Bun-installed `drizzle-kit` binary.
- `vitest.config.ts` / `vitest.activation.config.ts` — test harnesses depend on `@cloudflare/vitest-pool-workers` from the same lockfile.

## Architecture and Conventions

### Version ranges
Runtime dependencies use caret ranges (e.g. `hono ^4.13.8`, `drizzle-orm ^0.45.2`, `zod ^3.25.0`). Some packages are pinned exactly (e.g. `@modelcontextprotocol/client 2.0.0`, `better-auth 1.6.25`, `@modelcontextprotocol/sdk 1.30.0`, `@workers-types 5.20260922.1`). Dev dependencies also lean toward caret ranges except where Cloudflare pin versions tightly (e.g. `wrangler ^4.152.0`).

### Overrides
An explicit `overrides` block forces `@modelcontextprotocol/sdk` to resolve its nested `zod` at `3.25.76`, overriding any higher semver that upstream might pull in. This override is mirrored in `bun.lock` under `overrides.packages`, ensuring deterministic installs across environments.

### Native / unsafe script allowlist
Because the project bundles Cloudflare Worker runtimes and tooling that ship platform-specific binaries, `package.json` includes an `allowScripts` section whitelisting:
- `esbuild`
- `workerd`
- `sharp`
- `@cloudflare/workerd-linux-64`
- `@cloudflare/workerd-windows-64`
- `es5-ext@0.10.64`

This is required because Bun blocks arbitrary postinstall scripts by default; without this list, installing these packages would fail.

### Peer dependencies
Peer dependency resolution is relaxed via `.npmrc` setting `legacy-peer-deps=true`. This avoids install failures when multiple packages declare conflicting peer requirements (a common situation with Hono-based apps, Vitest pools, and MCP SDKs).

### No vendoring
There is no vendored `node_modules/` committed to the repo, nor any private registry URL in `.npmrc`. All packages come from the public npm registry. The `bun.lock` file serves as the canonical source of truth for reproducible builds.

### Scripts double as dependency consumers
All dependency-driven tooling is invoked through npm/Bun scripts rather than global commands:
- `cf dev` / `cf build` / `cf deploy` (the `cf` package)
- `drizzle-kit generate` / `drizzle-kit migrate`
- `vitest run` / `vitest`
- `tsc --noEmit`
- `cf workers types` (`cf-typegen`)

## Rules Enforced by Evidence

1. **Bun is the required package manager.** `package.json` declares `"packageManager": "bun@1.4.0"`, which makes the version check mandatory for anyone running `bun install` (enforced by Bun itself).
2. **Dependency trees must be kept in sync with `bun.lock`.** The lockfile is committed; CI will compare it against `package.json` whenever dependencies change (enforced by the presence of the lockfile and the absence of a `node_modules/` directory in `.gitignore`).
3. **Any new package that ships native binaries or a postinstall script must be added to `allowScripts` in `package.json`.** Without an entry, Bun will refuse to run the script (enforced by Bun's security policy; the existing list shows the pattern used for `workerd`, `sharp`, etc.).
4. **Peer dependency conflicts are tolerated, not fixed.** `.npmrc` sets `legacy-peer-deps=true`, so installers will not fail on mismatched peers (enforced by npm/Bun reading `.npmrc`).
5. **Transitive `zod` versions consumed by `@modelcontextprotocol/sdk` are pinned to `3.25.76` via the `overrides` block.** This is enforced by both `package.json` and the corresponding entry in `bun.lock`.