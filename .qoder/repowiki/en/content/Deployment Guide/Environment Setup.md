# Environment Setup

<cite>
**Referenced Files in This Document**
- [package.json](file://package.json)
- [wrangler.jsonc](file://wrangler.jsonc)
- [src/config/env.ts](file://src/config/env.ts)
- [src/types/env.ts](file://src/types/env.ts)
- [src/db/client.ts](file://src/db/client.ts)
- [src/index.ts](file://src/index.ts)
- [drizzle.config.ts](file://drizzle.config.ts)
</cite>

## Update Summary
**Changes Made**
- Updated package manager from npm to bun@1.4.0 throughout the document
- Replaced wrangler CLI commands with cf CLI for development and deployment
- Updated D1 migration commands to use `cf d1 migrations apply` instead of wrangler equivalents
- Added cf CLI bindings documentation for secrets management
- Updated all command examples to reflect new tooling

## Table of Contents
1. [Introduction](#introduction)
2. [Project Structure](#project-structure)
3. [Core Components](#core-components)
4. [Architecture Overview](#architecture-overview)
5. [Detailed Component Analysis](#detailed-component-analysis)
6. [Dependency Analysis](#dependency-analysis)
7. [Performance Considerations](#performance-considerations)
8. [Troubleshooting Guide](#troubleshooting-guide)
9. [Conclusion](#conclusion)
10. [Appendices](#appendices)

## Introduction
This document explains how to set up the TrackDub API for development, staging, and production using the cf CLI and Cloudflare Workers. The project now uses Bun as the package manager and has migrated from Wrangler to the cf CLI for local development, building, and deployment. It covers environment configuration, required variables, dependency installation with Bun, local server setup using cf dev, and best practices for managing secrets across environments.

## Project Structure
The project is a Cloudflare Worker application built with TypeScript, Drizzle ORM, and the cf CLI for deployment. Key areas relevant to environment setup include:
- Configuration and types for environment variables
- Database client initialization
- cf CLI configuration for Workers
- Package scripts for running and deploying with Bun
- Drizzle configuration for migrations

```mermaid
graph TB
A["Bun Scripts<br/>package.json"] --> B["cf CLI Config<br/>wrangler.jsonc"]
B --> C["Workers Runtime"]
C --> D["Env Loader<br/>src/config/env.ts"]
D --> E["Type Definitions<br/>src/types/env.ts"]
C --> F["DB Client<br/>src/db/client.ts"]
F --> G["Drizzle Config<br/>drizzle.config.ts"]
C --> H["App Entry<br/>src/index.ts"]
```

**Diagram sources**
- [package.json](file://package.json)
- [wrangler.jsonc](file://wrangler.jsonc)
- [src/config/env.ts](file://src/config/env.ts)
- [src/types/env.ts](file://src/types/env.ts)
- [src/db/client.ts](file://src/db/client.ts)
- [drizzle.config.ts](file://drizzle.config.ts)
- [src/index.ts](file://src/index.ts)

**Section sources**
- [package.json](file://package.json)
- [wrangler.jsonc](file://wrangler.jsonc)
- [src/config/env.ts](file://src/config/env.ts)
- [src/types/env.ts](file://src/types/env.ts)
- [src/db/client.ts](file://src/db/client.ts)
- [drizzle.config.ts](file://drizzle.config.ts)
- [src/index.ts](file://src/index.ts)

## Core Components
- Environment loader: Centralizes reading and validating environment variables at runtime.
- Type definitions: Enforces expected variable names and types.
- Database client: Initializes connections based on environment variables.
- cf CLI configuration: Defines Workers metadata, bindings, and deployment targets.
- Bun scripts: Provide commands for local dev, testing, and deployment.

**Section sources**
- [src/config/env.ts](file://src/config/env.ts)
- [src/types/env.ts](file://src/types/env.ts)
- [src/db/client.ts](file://src/db/client.ts)
- [wrangler.jsonc](file://wrangler.jsonc)
- [package.json](file://package.json)

## Architecture Overview
The runtime loads environment variables from cf CLI's secret store or local .dev.vars file, validates them via the env loader, and initializes services such as the database client. The app entry point registers routes and middleware that depend on these configurations.

```mermaid
sequenceDiagram
participant Dev as "Developer"
participant CF as "cf CLI"
participant Cloudflare as "Cloudflare Workers"
participant Env as "Env Loader<br/>src/config/env.ts"
participant DB as "DB Client<br/>src/db/client.ts"
participant App as "App Entry<br/>src/index.ts"
Dev->>CF : cf dev / cf deploy
CF->>Cloudflare : Start/Deploy Worker
Cloudflare->>Env : Read process.env + secrets
Env-->>Cloudflare : Validated config object
Cloudflare->>DB : Initialize connection (if needed)
DB-->>Cloudflare : Ready
Cloudflare->>App : Boot routes/middleware
App-->>Cloudflare : Serve requests
```

**Diagram sources**
- [src/config/env.ts](file://src/config/env.ts)
- [src/db/client.ts](file://src/db/client.ts)
- [src/index.ts](file://src/index.ts)
- [wrangler.jsonc](file://wrangler.jsonc)

## Detailed Component Analysis

### Environment Variables and Secrets
- Source of truth for variables: .dev.vars.example lists all required keys for local development.
- Local secrets: Copy .dev.vars.example to .dev.vars and fill values; this file is ignored by version control.
- Production/staging secrets: Configure via cf CLI secrets or Cloudflare dashboard.
- Validation: The env loader reads and validates variables at startup, failing fast if required keys are missing.

Recommended workflow:
- Create .dev.vars from .dev.vars.example and populate local values.
- For remote environments, add secrets through cf CLI or dashboard.
- Ensure type safety by referencing src/types/env.ts when adding new variables.

**Section sources**
- [.dev.vars.example](file://.dev.vars.example)
- [src/config/env.ts](file://src/config/env.ts)
- [src/types/env.ts](file://src/types/env.ts)

### Database Configuration
- Connection parameters are provided via environment variables consumed by the DB client.
- Migrations are managed through Drizzle; ensure drizzle.config.ts aligns with your target database credentials.
- In local development, use .dev.vars for DB credentials; in remote environments, configure via cf CLI secrets.

Operational notes:
- Validate connectivity during startup to fail fast on misconfiguration.
- Use separate databases or schemas per environment to avoid cross-contamination.

**Section sources**
- [src/db/client.ts](file://src/db/client.ts)
- [drizzle.config.ts](file://drizzle.config.ts)

### cf CLI Configuration
- wrangler.jsonc defines Worker metadata, bindings, and environment-specific settings.
- Use it to specify secrets, KV/D1/R2 bindings, and deployment targets.
- For local development, cf CLI will read .dev.vars automatically.

Best practices:
- Keep wrangler.jsonc minimal and environment-agnostic where possible.
- Store sensitive values as secrets rather than inline config.

**Section sources**
- [wrangler.jsonc](file://wrangler.jsonc)

### Application Entry Point
- src/index.ts boots the Worker, registers routes, and applies middleware.
- It depends on validated environment configuration and any initialized services (e.g., DB).

Development tip:
- Ensure the entry point can start without external dependencies when running locally with mocked services if necessary.

**Section sources**
- [src/index.ts](file://src/index.ts)

### Package Scripts and Tooling
- package.json contains scripts for running the local dev server with Bun, building, testing, and deploying with cf CLI.
- Use the provided scripts to start the local server with hot reload and to run tests against your configured environment.

Common tasks:
- Install dependencies with Bun
- Start local development server with cf dev
- Run tests
- Deploy to Cloudflare with cf deploy

**Section sources**
- [package.json](file://package.json)

## Dependency Analysis
The following diagram shows how environment configuration flows into core modules.

```mermaid
graph LR
Vars[".dev.vars.example"] --> EnvLoader["Env Loader<br/>src/config/env.ts"]
EnvLoader --> Types["Types<br/>src/types/env.ts"]
EnvLoader --> DBClient["DB Client<br/>src/db/client.ts"]
EnvLoader --> AppEntry["App Entry<br/>src/index.ts"]
CFConfig["cf CLI Config<br/>wrangler.jsonc"] --> AppEntry
BunScripts["Bun Scripts<br/>package.json"] --> AppEntry
```

**Diagram sources**
- [.dev.vars.example](file://.dev.vars.example)
- [src/config/env.ts](file://src/config/env.ts)
- [src/types/env.ts](file://src/types/env.ts)
- [src/db/client.ts](file://src/db/client.ts)
- [src/index.ts](file://src/index.ts)
- [wrangler.jsonc](file://wrangler.jsonc)
- [package.json](file://package.json)

**Section sources**
- [src/config/env.ts](file://src/config/env.ts)
- [src/types/env.ts](file://src/types/env.ts)
- [src/db/client.ts](file://src/db/client.ts)
- [src/index.ts](file://src/index.ts)
- [wrangler.jsonc](file://wrangler.jsonc)
- [package.json](file://package.json)

## Performance Considerations
- Avoid heavy initialization in module scope; defer expensive setup until first request if appropriate.
- Reuse database connections and clients across requests.
- Cache immutable configuration after validation to prevent repeated parsing.
- Minimize cold-start impact by keeping dependencies lean and avoiding unnecessary I/O at boot.

## Troubleshooting Guide
Common issues and resolutions:
- Missing environment variables:
  - Ensure .dev.vars exists and contains all required keys from .dev.vars.example.
  - For remote environments, verify secrets are added via cf CLI or dashboard.
- Database connection failures:
  - Confirm DB host, port, user, password, and database name are correct.
  - Check network access rules and firewall settings for the target database.
- cf CLI errors:
  - Verify cf login status and permissions.
  - Ensure wrangler.jsonc syntax is valid and references correct bindings.
- Local dev server not starting:
  - Reinstall dependencies with Bun and clear caches.
  - Validate Bun version matches project requirements (bun@1.4.0).

**Section sources**
- [.dev.vars.example](file://.dev.vars.example)
- [wrangler.jsonc](file://wrangler.jsonc)
- [package.json](file://package.json)

## Conclusion
By following the steps outlined here—setting up .dev.vars, configuring cf CLI secrets, validating environment variables, and initializing the database—you can reliably run the TrackDub API across development, staging, and production using Bun and the cf CLI. Adhering to the recommended patterns ensures secure, maintainable, and predictable deployments.

## Appendices

### Installation and Local Development
- Install dependencies using Bun (bun install).
- Start the local development server with `cf dev` to enable hot reload.
- Run tests with `bun test` to validate environment configuration and functionality.

**Section sources**
- [package.json](file://package.json)

### Environment-Specific Configuration Examples
- Development:
  - Populate .dev.vars with local database credentials and service endpoints.
  - Use `cf dev` to run locally with hot reload.
- Staging:
  - Add staging secrets via cf CLI or dashboard.
  - Deploy with `cf deploy --mode activation-staging`.
- Production:
  - Add production secrets via cf CLI or dashboard.
  - Deploy with `cf deploy --mode activation`.

### Secret Management Best Practices
- Never commit secrets to version control.
- Use .dev.vars only for local development; rely on cf CLI secrets for remote environments.
- Rotate secrets regularly and audit access.
- Separate secrets per environment to reduce blast radius.

### Database Migration Commands
- Apply local migrations: `bun db:migrate:local`
- Apply remote migrations: `bun db:migrate:remote`
- Generate migrations: `bun db:generate`

**Section sources**
- [package.json](file://package.json)

### cf CLI Commands Reference
- Development: `cf dev`
- Build: `cf build`
- Deploy: `cf deploy`
- Type generation: `cf workers types`
- Database migrations: `cf d1 migrations apply <database-id> --dir drizzle`

**Section sources**
- [package.json](file://package.json)