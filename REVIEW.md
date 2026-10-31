# Review Guide

Use this file when reviewing pull requests in the Trackdub API Worker
(`MesilimLLC/api.trackdub`).

This is a reviewer checklist, not an authoring guide. For stack and local
commands, see `README.md`. For auth topology and request lifecycle, see
`docs/ARCHITECTURE.md`. For agent Linear sync, see `AGENTS.md`.

This repo owns authentication, authorization, and API routing on Cloudflare
Workers (Hono + Better Auth + D1 + Drizzle). The portal
(`portal.trackdub.com`) is a browser-only SPA. Backend logic does not belong
in the portal.

## Automated review (Bugbot)

If Cursor Bugbot (or similar) is configured for this repository, it should follow
this checklist. Human reviewers still own the final merge bar.

Bugbot should surface the same blocking issues as
[Automatic review stops](#automatic-review-stops) below (auth boundary leaks,
secret leakage, CORS/credentials mistakes, fake readiness).

## Review priorities

Review in this order:

1. Correctness
2. Scope control
3. Auth, CORS, and authorization boundaries
4. Config and secret handling
5. Data / migration safety
6. Test evidence
7. Docs and contract alignment

## Approval standard

Do not approve a PR if any of these are unclear:

- What changed
- What did not change
- What was tested
- What was not tested
- Whether auth, session, CORS, or authorization behavior changed
- Whether secrets or env validation still fail closed
- Whether portal-only UI work was incorrectly landed here

## Checklist

### 1. Scope

- [ ] The PR solves one clear problem or one bounded slice.
- [ ] The PR description explicitly states non-goals.
- [ ] Unrelated cleanup is absent or clearly separated.
- [ ] Changes stay in this Worker's owned surface (routes, middleware, auth,
      db/schema, wrangler config, tests, docs). Portal UI belongs in
      `portal-trackdub`.

### 2. Hard architectural constraints

Treat these as request-changes items, not suggestions.

- [ ] The Worker remains the only authorization boundary. Portal route guards
      are never trusted as security.
- [ ] Session cookies stay host-only to the API origin (`Secure; HttpOnly;
      SameSite=Lax; Path=/`, no `Domain`). Do not enable
      `crossSubDomainCookies` casually.
- [ ] CORS never uses `Access-Control-Allow-Origin: *` with credentials.
      Allowed origin stays exact (`PORTAL_ORIGIN` + documented localhost).
- [ ] Protected endpoints authorize independently. Do not rely on "the portal
      already checked session."
- [ ] Secrets are not logged, returned in error bodies, or committed
      (`.dev.vars` stays local). Fail-fast config validation remains secret-free
      in user-visible errors.
- [ ] Invite-only signup policy stays enforced by the Worker, not the SPA.

### 3. Auth and session behavior

- [ ] Better Auth routes and session semantics remain consistent with
      `docs/ARCHITECTURE.md`.
- [ ] CSRF / Origin expectations for credentialed cross-origin portal calls
      are preserved (see `docs/CONTRACT-MISMATCHES.md` when relevant).
- [ ] Admin / operator token gates stay bearer-token based and fail closed.
- [ ] New session-gated routes mount `requireAuth` (or equivalent) explicitly;
      public routes are intentional and documented.

### 4. Data and migrations

- [ ] Drizzle schema changes ship with generated migrations under `drizzle/`.
- [ ] Migration impact on local and remote D1 is called out.
- [ ] Destructive schema changes are explicit and justified.

### 5. Runtime and config

- [ ] New env vars are documented in `README.md` and validated in
      `src/config/env.ts`.
- [ ] `wrangler.jsonc` binding changes (D1, R2, vars) are intentional and
      called out.
- [ ] Error responses keep the shared `{ error: { code, message, requestId } }`
      shape; stacks stay in logs only.

### 6. Tests

- [ ] Tests were added or updated under `test/` (Vitest / workerd pool).
- [ ] The commands run are listed exactly in the PR (`npm test`,
      `npm run typecheck`, etc.).
- [ ] Skipped tests are named and justified.
- [ ] Auth, CORS, middleware, and error-path changes include covering tests
      where practical.
- [ ] The PR does not claim broader verification than was actually run.

### 7. Docs and contract alignment

- [ ] `README.md` / `docs/ARCHITECTURE.md` updated when topology or auth
      behavior changed.
- [ ] Contract mismatches with the portal are documented rather than silently
      assumed fixed.

## Automatic review stops

Request changes immediately if a PR does any of the following:

- Treats portal route guards as the authorization boundary.
- Widens CORS to `*` while sending credentials, or drops exact-origin checks.
- Logs or returns secrets / session tokens.
- Disables fail-closed env validation without an explicit, tested escape hatch.
- Commits `.dev.vars` or other secret material.
- Adds portal UI or Lovable SPA code here.
- Claims validation that the PR body does not support with exact commands.

## Review comment style

Prefer comments that are concrete and falsifiable:

- Point to the exact file or behavior.
- State the risk.
- State what evidence is missing.
- Suggest the narrowest acceptable correction.

Good review comments usually sound like:

- "This trusts portal session state for authorization. The Worker must enforce."
- "CORS allow-origin became `*` with credentials, which browsers will reject or
  which is unsafe."
- "Config validation no longer fails closed on missing `BETTER_AUTH_SECRET`."
- "The tests listed do not exercise the changed auth middleware path."

## Minimum merge bar

A PR is ready to merge when:

- The scope is still bounded to this Worker.
- Auth, CORS, and secret-handling rules still hold.
- Validation is honest and adequate.
- Docs match the shipped behavior.
