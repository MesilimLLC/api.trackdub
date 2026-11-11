import { filterForScope, isDocScope, SYSTEM_PROMPT, type DocScope } from "@/docs-rag/scopes";
import { SYNC_KEY } from "@/docs-rag/provenance";
import type {
  DocsRagBindings,
  DocsRagChatResult,
  DocsRagSearchChunk,
  DocsRagSearchResult,
} from "@/docs-rag/types";

export interface SearchRequest {
  query: string;
  scope: DocScope;
  limit: number;
}

/** Thrown when AI Search's upstream limiter (code 2003) rejects the call. */
export class RateLimitedError extends Error {
  constructor() {
    super("upstream rate limited");
    this.name = "RateLimitedError";
  }
}

export function parseSearchBody(body: unknown): SearchRequest | { error: string } {
  if (!body || typeof body !== "object") return { error: "expected JSON object" };
  const record = body as Record<string, unknown>;
  const query = record.query;
  if (typeof query !== "string" || query.trim().length === 0) return { error: "query is required" };
  const scopeRaw = record.scope;
  const scope = typeof scopeRaw === "string" ? scopeRaw : "all";
  if (!isDocScope(scope)) return { error: `unknown scope: ${scope}` };
  const limitRaw = record.limit;
  const limit = typeof limitRaw === "number" && Number.isFinite(limitRaw) ? Math.trunc(limitRaw) : 8;
  if (limit < 1 || limit > 20) return { error: "limit must be 1..20" };
  return { query: query.trim(), scope, limit };
}

function chunkKey(chunk: DocsRagSearchChunk): string | null {
  return chunk.item?.key ?? null;
}

function hits(chunks: DocsRagSearchChunk[] | undefined) {
  return (chunks ?? []).filter((chunk) => chunkKey(chunk) !== SYNC_KEY).map((chunk) => ({
    score: chunk.score ?? null,
    key: chunkKey(chunk),
    text: (chunk.text ?? "").slice(0, 4000),
    ...(typeof chunk.item?.timestamp === "number" ? { indexedAt: chunk.item.timestamp } : {}),
  }));
}

/** Rank-interleaves AND and OR per scope: rerank scores are uncorrelated with relevance, so a saturated AND list must not starve OR-only matches. Identical mirrored text is collapsed so duplicates cannot consume the result budget. */
function mergeByRank(scopeGroups: DocsRagSearchChunk[][][]): DocsRagSearchChunk[] {
  const seen = new Set<string>();
  const merged: DocsRagSearchChunk[] = [];
  for (const groups of scopeGroups) {
    const longest = groups.reduce((max, group) => Math.max(max, group.length), 0);
    for (let rank = 0; rank < longest; rank++) {
      for (const group of groups) {
        const chunk = group[rank];
        if (chunk === undefined) continue;
        const text = (chunk.text ?? "").replace(/\s+/g, " ").trim();
        if (text !== "" && seen.has(text)) continue;
        seen.add(text);
        merged.push(chunk);
      }
    }
  }
  return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSearchResult(value: unknown): value is DocsRagSearchResult {
  return isRecord(value) && Array.isArray(value.chunks) && value.chunks.every((chunk: unknown) =>
    isRecord(chunk) &&
    (chunk.text == null || typeof chunk.text === "string") &&
    (chunk.score == null || (typeof chunk.score === "number" && Number.isFinite(chunk.score))) &&
    (chunk.item == null || (isRecord(chunk.item) && (chunk.item.key == null || typeof chunk.item.key === "string")))
  ) && (value.search_query == null || typeof value.search_query === "string");
}

function isChatResult(value: unknown): value is DocsRagChatResult {
  if (!isRecord(value) || !isSearchResult(value) || !Array.isArray(value.choices)) return false;
  const choice: unknown = value.choices[0];
  return isRecord(choice) && isRecord(choice.message) && typeof choice.message.content === "string";
}

/** Check HTTP and API errors before either endpoint can interpret empty results as success. */
async function readAiSearchResponse(response: Response, endpoint: string): Promise<Record<string, unknown>> {
  const detail = await response.text().catch(() => "");
  let payload: unknown;
  try {
    payload = JSON.parse(detail);
  } catch {
    payload = null;
  }
  const errors = isRecord(payload) && Array.isArray(payload.errors) ? payload.errors : [];
  const error = isRecord(payload) ? payload.error : undefined;
  // Parse JSON rather than matching serialized text: whitespace is insignificant.
  if (response.status === 429 || [payload, error, ...errors].some((entry) => isRecord(entry) && entry.code === 2003)) {
    throw new RateLimitedError();
  }
  if (!response.ok) {
    throw new Error(`AI Search ${endpoint} ${response.status}: ${detail.slice(0, 300)}`);
  }
  if (!isRecord(payload)) {
    throw new Error(`AI Search ${endpoint}: invalid JSON response`);
  }
  if ((payload.success !== undefined && payload.success !== true) || payload.error != null ||
    (payload.errors != null && (!Array.isArray(payload.errors) || payload.errors.length > 0))) {
    throw new Error(`AI Search ${endpoint} error: ${detail.slice(0, 300)}`);
  }
  return payload;
}

interface AiSearchRetrievalOptions {
  filters?: ReturnType<typeof filterForScope>;
  max_num_results: number;
  keyword_match_mode: "and" | "or";
  retrieval_type?: "hybrid";
}

/**
 * Call the AI Search REST search endpoint. The legacy `env.AI.autorag()`
 * binding does not accept the Vectorize-style filters this corpus needs
 * (folder range queries), so the Worker talks to the new REST API directly
 * using the instance's service token.
 */
async function aiSearchRest(
  env: DocsRagBindings,
  query: string,
  options: AiSearchRetrievalOptions,
  symbolFallback = false,
): Promise<DocsRagSearchResult> {
  const token = env.AI_SEARCH_API_TOKEN;
  const body = { query, ai_search_options: {
    retrieval: options,
    ...(symbolFallback ? { cache: { enabled: false }, reranking: { enabled: false } } : {}),
  } };
  const url =
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}` +
    `/ai-search/instances/${env.AI_SEARCH_INSTANCE}/search`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  const payload = await readAiSearchResponse(response, "REST");
  if (payload.success !== true || !isSearchResult(payload.result)) {
    throw new Error("AI Search REST: malformed search result");
  }
  console.log(
    `[docs-rag] search instance=${env.AI_SEARCH_INSTANCE} query=${JSON.stringify(query).slice(0, 120)} filters=${JSON.stringify(options.filters ?? null)} chunks=${payload.result.chunks?.length ?? 0} matchMode=${options.keyword_match_mode}`,
  );
  return payload.result;
}

/** Camel-case, dotted, colon-qualified or snake-case token of 4-128 ASCII characters. */
function isCodeIdentifier(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_.:]{3,127}$/.test(token) && /[a-z][A-Z]|[_:.]/.test(token);
}

export async function searchDocs(env: DocsRagBindings, request: SearchRequest, clientKey?: string) {
  const scopes: DocScope[] = request.scope === "all" ? ["first-party", "vendor"] : [request.scope];
  const retrieve = async (keywordMatchMode: "and" | "or", symbolFallback = false) => {
    const results = await Promise.all(scopes.map(scope => aiSearchRest(env, request.query, {
      filters: filterForScope(scope),
      max_num_results: symbolFallback ? 20 : request.limit,
      keyword_match_mode: keywordMatchMode,
      ...(symbolFallback ? { retrieval_type: "hybrid" as const } : {}),
    }, symbolFallback)));
    return results.map(result => result.chunks ?? []);
  };
  // Reranking scores identifier-only queries (e.g. "nv_profile_min_shapes nv_profile_max_shapes")
  // below its cutoff even when a chunk contains them verbatim, so any code-like token in an
  // otherwise empty search earns the unreranked literal fallback, not only a lone identifier.
  const identifiers = [...new Set(request.query.split(/\s+/)
    .map(token => token.replace(/^[^A-Za-z0-9_]+|[^A-Za-z0-9_]+$/g, ""))
    .filter(isCodeIdentifier))];
  const [strict, loose] = await Promise.all([retrieve("and"), retrieve("or")]);
  const union = mergeByRank(scopes.map((_, index) => [strict[index] ?? [], loose[index] ?? []]));
  if (union.length > 0 || identifiers.length === 0) {
    return { scope: request.scope, matchMode: "union" as const, hits: hits(union).slice(0, request.limit) };
  }
  const candidates = await retrieve("or", true);
  const prefixes = identifiers.map(identifier =>
    new RegExp(`(^|[^A-Za-z0-9_])${identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"));
  const scored = hits(mergeByRank(candidates.map(group => [group])))
    .map((hit, rank) => ({ hit, rank, matched: prefixes.filter(prefix => prefix.test(hit.text)).length }))
    .filter(entry => entry.hit.key !== null && entry.matched > 0)
    // More of the requested identifiers first; ties keep retrieval order.
    .sort((a, b) => b.matched - a.matched || a.rank - b.rank);
  return {
    scope: request.scope,
    matchMode: "symbol-fallback" as const,
    hits: scored.map(entry => entry.hit).slice(0, request.limit),
  };
}

export async function askDocs(env: DocsRagBindings, request: SearchRequest, clientKey?: string) {
  // Retrieve and generate in one scoped request so citations belong to this answer.
  const filters = filterForScope(request.scope);
  const chatUrl =
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}` +
    `/ai-search/instances/${env.AI_SEARCH_INSTANCE}/chat/completions`;
  const chatResponse = await fetch(chatUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.AI_SEARCH_API_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: request.query },
      ],
      model: env.AI_SEARCH_MODEL,
      ai_search_options: {
        // Cloudflare uses the first user message as-is, even with rewriting enabled.
        query_rewrite: { enabled: true },
        retrieval: { max_num_results: request.limit, ...(filters ? { filters } : {}) },
      },
    }),
  });
  const chat = await readAiSearchResponse(chatResponse, "chat");
  if (!isChatResult(chat)) {
    throw new Error("AI Search chat: malformed completion (expected chunks and message content)");
  }
  return {
    scope: request.scope,
    searchQuery: chat.search_query ?? null,
    answer: chat.choices[0].message.content,
    hits: hits(chat.chunks),
  };
}
