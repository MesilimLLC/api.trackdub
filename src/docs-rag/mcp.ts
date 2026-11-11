import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DOC_SCOPES } from "@/docs-rag/scopes";
import { PIN_SENTENCE } from "@/docs-rag/pin.generated";
import { withProvenance } from "@/docs-rag/provenance";
import { askDocs, searchDocs, RateLimitedError, type SearchRequest } from "@/docs-rag/query";
import { getDocText } from "@/docs-rag/corpus";
import type { DocsRagBindings } from "@/docs-rag/types";

const SCOPE_DESCRIPTION = DOC_SCOPES.join(", ");

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function textResult(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Build a fresh stateless MCP server. MCP SDK >= 1.26 requires a new
 * McpServer per request (no shared instance across transports), so callers
 * invoke this inside the request handler.
 */
export function createDocsRagServer(env: DocsRagBindings, clientKey: string): McpServer {
  const server = new McpServer(
    {
      name: "trackdub-docs-rag",
      version: "0.2.0",
    },
    {
      instructions:
        "Curated Trackdub + vendor documentation search (R2 corpus indexed by Cloudflare AI Search). " +
        "Covers Trackdub, Trackdub-gated, api.trackdub first-party docs and pinned vendor docs " +
        "(NVIDIA TRT-RTX/EP ABI, Windows ML, ONNX Runtime EPs, AMD, Intel, Qualcomm, Qwen, Whisper, speech models). " +
        "First-party text outranks vendor /latest/ pages on disagreement. " + PIN_SENTENCE + " " +
        "Prefer search_trackdub_docs; use ask_trackdub_docs only when you want a synthesized answer, and check version numbers and flags in it against the cited hits. " +
        "First-party hits carry repo, localPath and syncedCommit: when you have that checkout, read the local file instead of trusting the indexed copy. " +
        "Each tool call is stateless: compose every query as self-contained (include symbols, product names, and concrete context — " +
        "never bare follow-ups like 'what about its limitations?'; restate the full question instead).",
    },
  );

  const searchShape = {
    query: z.string().min(1).describe(
      "Self-contained search text. This call is stateless: no prior queries are remembered. " +
      "Include symbols/API names and concrete context (e.g. 'NvTensorRTRTXExecutionProvider session bootstrap download policy', " +
      "not 'its limitations').",
    ),
    scope: z
      .enum(DOC_SCOPES)
      .optional()
      .describe(`Restrict to one corpus section. Values: ${SCOPE_DESCRIPTION}. Omit for all.`),
    limit: z.number().int().min(1).max(20).optional().describe("Max chunks (default 8)."),
  };

  server.registerTool(
    "search_trackdub_docs",
    {
      title: "Search Trackdub docs",
      description:
        "Default choice. Hybrid (vector+keyword) search over Trackdub and pinned vendor docs. Returns ranked chunks with R2 keys and scores; first-party hits also carry repo, localPath and the commit the corpus was synced from. Use for implementation facts: provider registration, EP ABI details, pin versions, pipeline stages.",
      inputSchema: searchShape,
    },
    async (args, _extra): Promise<ToolResult> => {
      const parsed = parseArgs(args as Record<string, unknown>);
      if ("error" in parsed) return errorResult(parsed.error);
      try {
        const result = await withProvenance(env, await searchDocs(env, parsed, clientKey));
        return textResult(result);
      } catch (error) {
        if (error instanceof RateLimitedError) {
          return errorResult("rate limited: too many requests. Retry after ~10s.");
        }
        return errorResult(error instanceof Error ? error.message : "search failed");
      }
    },
  );

  server.registerTool(
    "ask_trackdub_docs",
    {
      title: "Ask Trackdub docs",
      description:
        "Answer a question from the corpus using Workers AI generation with retrieved context. Slower and rate-limited tighter " +
        "than search; prefer search_trackdub_docs when you just need chunks. The answer is generated text: confirm exact versions, flags and symbols against hits[].key before relying on them. Answers state when the corpus lacks the answer. " +
        "Stateless: the rewriter cannot resolve follow-ups — restate the full question with context, never send 'what about X?'.",
      inputSchema: searchShape,
    },
    async (args, _extra): Promise<ToolResult> => {
      const parsed = parseArgs(args as Record<string, unknown>);
      if ("error" in parsed) return errorResult(parsed.error);
      try {
        const result = await withProvenance(env, await askDocs(env, parsed, clientKey));
        return textResult(result);
      } catch (error) {
        if (error instanceof RateLimitedError) {
          return errorResult("rate limited: too many requests. Retry after ~10s.");
        }
        return errorResult(error instanceof Error ? error.message : "ask failed");
      }
    },
  );

  server.registerTool(
    "get_trackdub_doc",
    {
      title: "Get full Trackdub doc",
      description:
        "Fetch the full text of one corpus document by its R2 key (item.key from search hits). Use after a search when chunks are truncated and you need the complete page (max ~4 MB per file).",
      inputSchema: {
        key: z
          .string()
          .min(1)
          .describe('R2 object key, e.g. "first-party/trackdub/docs/reference/tensorrt-rtx-ep-abi-plugin.md".'),
        max_chars: z.number().int().min(500).max(200000).optional().describe("Truncation cap (default 50000)."),
      },
    },
    async (args, _extra): Promise<ToolResult> => {
      const record = args as Record<string, unknown>;
      const key = typeof record.key === "string" ? record.key : "";
      const maxChars = typeof record.max_chars === "number" ? Math.trunc(record.max_chars) : 50000;
      if (!key || key.includes("..")) return errorResult("invalid key");
      try {
        const doc = await getDocText(env, key, maxChars);
        return textResult(doc);
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : "get failed");
      }
    },
  );

  return server;
}

type ParsedArgs = SearchRequest | { error: string };

function parseArgs(args: Record<string, unknown>): ParsedArgs {
  const query = args.query;
  if (typeof query !== "string" || query.trim().length === 0) return { error: "query is required" };
  const scopeRaw = args.scope;
  const scope = typeof scopeRaw === "string" ? scopeRaw : "all";
  if (!(DOC_SCOPES as readonly string[]).includes(scope)) return { error: `unknown scope: ${scope}` };
  const limitRaw = args.limit;
  const limit = typeof limitRaw === "number" && Number.isFinite(limitRaw) ? Math.trunc(limitRaw) : 8;
  if (limit < 1 || limit > 20) return { error: "limit must be 1..20" };
  return { query: query.trim(), scope, limit } as SearchRequest;
}
