import { DOC_SCOPES } from "@/docs-rag/scopes";
import { askDocs, parseSearchBody, searchDocs, RateLimitedError } from "@/docs-rag/query";
import { requireToken, checkRateLimits, rateLimitedResponse, limiterKeyFromToken } from "@/docs-rag/auth";
import { createDocsRagServer } from "@/docs-rag/mcp";
import { withProvenance } from "@/docs-rag/provenance";
import { createMcpHandler } from "agents/mcp";
import { Hono } from "hono";
import type { DocsRagEnv } from "@/docs-rag/types";

const app = new Hono<DocsRagEnv>();

app.get("/health", (c) =>
  c.json({
    ok: true,
    instance: c.env.AI_SEARCH_INSTANCE,
    model: c.env.AI_SEARCH_MODEL,
    scopes: DOC_SCOPES,
  }),
);

app.post("/mcp", async (c) => {
  const denied = requireToken(c.req.raw, c.env);
  if (denied) return denied;
  const clientKey = limiterKeyFromToken(c.env.DOCS_RAG_TOKEN);
  const check = await checkRateLimits(
    { burst: c.env.RL_BURST, steady: c.env.RL_STEADY },
    clientKey,
  );
  if (!check.ok) return rateLimitedResponse(check);
  // MCP SDK >= 1.26: fresh McpServer per request (shared instances leak
  // cross-client transport state).
  const server = createDocsRagServer(c.env, clientKey);
  const handler = createMcpHandler(server, { route: "/mcp" });
  // Hono's executionCtx type lacks the newer `tracing` property required by
  // the agents SDK ExecutionContext type; the MCP handler only reads the
  // waitUntil/passThroughOnException fields on stateless routes.
  return handler(c.req.raw, c.env, c.executionCtx as unknown as ExecutionContext);
});

app.post("/v1/search", async (c) => {
  const denied = requireToken(c.req.raw, c.env);
  if (denied) return denied;
  const clientKey = limiterKeyFromToken(c.env.DOCS_RAG_TOKEN);
  const check = await checkRateLimits({ burst: c.env.RL_BURST, steady: c.env.RL_STEADY }, clientKey);
  if (!check.ok) return rateLimitedResponse(check);
  const parsed = parseSearchBody(await c.req.json().catch(() => null));
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);
  try {
    return c.json(await withProvenance(c.env, await searchDocs(c.env, parsed, clientKey)));
  } catch (error) {
    if (error instanceof RateLimitedError) {
      return c.json({ error: "rate_limited", limiter: "upstream", retry_after_seconds: 10 }, {
        status: 429,
        headers: { "Retry-After": "10" },
      });
    }
    const message = error instanceof Error ? error.message : "search failed";
    return c.json({ error: "search_failed", message }, 503);
  }
});

app.post("/v1/ask", async (c) => {
  const denied = requireToken(c.req.raw, c.env);
  if (denied) return denied;
  const clientKey = limiterKeyFromToken(c.env.DOCS_RAG_TOKEN);
  const check = await checkRateLimits(
    { burst: c.env.RL_BURST, steady: c.env.RL_STEADY, ask: c.env.RL_ASK },
    clientKey,
    { expensive: true },
  );
  if (!check.ok) return rateLimitedResponse(check);
  const parsed = parseSearchBody(await c.req.json().catch(() => null));
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);
  try {
    return c.json(await withProvenance(c.env, await askDocs(c.env, parsed, clientKey)));
  } catch (error) {
    if (error instanceof RateLimitedError) {
      return c.json({ error: "rate_limited", limiter: "upstream", retry_after_seconds: 10 }, {
        status: 429,
        headers: { "Retry-After": "10" },
      });
    }
    const message = error instanceof Error ? error.message : "ask failed";
    return c.json({ error: "ask_failed", message }, 503);
  }
});

app.notFound((c) => c.json({ error: "not_found" }, 404));

export default app;
