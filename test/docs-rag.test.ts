import { afterEach, describe, expect, it, vi } from "vitest";
import { bearerAuthorized, checkRateLimits, limiterKeyFromToken } from "@/docs-rag/auth";
import { askDocs, parseSearchBody, RateLimitedError, searchDocs } from "@/docs-rag/query";
import { filterForScope, SYSTEM_PROMPT } from "@/docs-rag/scopes";
import type { DocsRagBindings } from "@/docs-rag/types";

function stubLimiter(success: boolean, calls: string[] = []): any {
  return {
    limit: async (opts: { key: string }) => {
      calls.push(opts.key);
      return { success };
    },
  };
}

describe("docs-rag scopes", () => {
  it("leaves all unfiltered", () => {
    expect(filterForScope("all")).toBeUndefined();
  });

  it("builds ASCII range filters for first-party and vendor folders", () => {
    expect(filterForScope("trackdub")).toEqual({
      folder: { $gte: "first-party/trackdub/", $lt: "first-party/trackdub0" },
    });
    expect(filterForScope("nvidia")).toEqual({
      folder: { $gte: "vendor/nvidia/", $lt: "vendor/nvidia0" },
    });
  });
});

describe("docs-rag request parsing", () => {
  it("rejects an empty query", () => {
    expect(parseSearchBody({ query: "  " })).toEqual({ error: "query is required" });
  });

  it("defaults scope and limit", () => {
    expect(parseSearchBody({ query: "TRT RTX plugin" })).toEqual({
      query: "TRT RTX plugin",
      scope: "all",
      limit: 8,
    });
  });

  it("rejects unknown scopes", () => {
    expect(parseSearchBody({ query: "x", scope: "cuda" })).toEqual({ error: "unknown scope: cuda" });
  });
});

describe("docs-rag auth", () => {
  it("rejects a short configured token", () => {
    expect(bearerAuthorized("Bearer short-token", "short-token")).toBe(false);
  });

  it("accepts a matching bearer token", () => {
    const token = "docs-rag-token-16";
    expect(bearerAuthorized(`Bearer ${token}`, token)).toBe(true);
    expect(bearerAuthorized("Bearer other-token-16ch", token)).toBe(false);
  });

  it("derives a stable limiter key without exposing the raw token", () => {
    const key1 = limiterKeyFromToken("aaaaaaaaaaaaaaaaaaaa");
    const key2 = limiterKeyFromToken("aaaaaaaaaaaaaaaaaaaa");
    const other = limiterKeyFromToken("bbbbbbbbbbbbbbbbbbbb");
    expect(key1).toBe(key2);
    expect(key1).not.toBe(other);
    expect(key1).not.toContain("aaaaaaaaaaaaaaaaaaaa");
  });
});

describe("docs-rag rate limits", () => {
  it("passes when all limiters succeed", async () => {
    const result = await checkRateLimits(
      { burst: stubLimiter(true), steady: stubLimiter(true) },
      "client",
    );
    expect(result.ok).toBe(true);
  });

  it("returns burst retry window on burst failure", async () => {
    const result = await checkRateLimits(
      { burst: stubLimiter(false), steady: stubLimiter(true) },
      "client",
    );
    expect(result.ok).toBe(false);
    expect(result.binding).toBe("burst");
    expect(result.retryAfterSeconds).toBe(10);
  });

  it("returns steady retry window on steady failure", async () => {
    const burstCalls: string[] = [];
    const result = await checkRateLimits(
      { burst: stubLimiter(true, burstCalls), steady: stubLimiter(false) },
      "client",
    );
    expect(result.ok).toBe(false);
    expect(result.binding).toBe("steady");
    expect(result.retryAfterSeconds).toBe(60);
    expect(burstCalls[0]).toBe("burst:client");
  });

  it("enforces the ask limiter only for expensive routes", async () => {
    const askCalls: string[] = [];
    const cheap = await checkRateLimits(
      { burst: stubLimiter(true), steady: stubLimiter(true) },
      "client",
    );
    expect(cheap.ok).toBe(true);

    const expensiveOk = await checkRateLimits(
      { burst: stubLimiter(true), steady: stubLimiter(true), ask: stubLimiter(true, askCalls) },
      "client",
      { expensive: true },
    );
    expect(expensiveOk.ok).toBe(true);
    expect(askCalls[0]).toBe("ask:client");

    const expensiveBlocked = await checkRateLimits(
      { burst: stubLimiter(true), steady: stubLimiter(true), ask: stubLimiter(false) },
      "client",
      { expensive: true },
    );
    expect(expensiveBlocked.ok).toBe(false);
    expect(expensiveBlocked.binding).toBe("ask");
    expect(expensiveBlocked.retryAfterSeconds).toBe(10);
  });
});

// Only fetch is stubbed: request construction, response validation and hit mapping stay real.
const queryEnv = {
  CF_ACCOUNT_ID: "test-account",
  AI_SEARCH_INSTANCE: "test-instance",
  AI_SEARCH_API_TOKEN: "test-service-token",
  AI_SEARCH_MODEL: "test-configured-model",
} as DocsRagBindings;
const apiUrl = "https://api.cloudflare.com/client/v4/accounts/test-account/ai-search/instances/test-instance";
const sourceChunk = {
  id: "chunk-1",
  type: "text",
  score: 0.87,
  text: "Use the standalone EP plugin.",
  item: { key: "vendor/nvidia/plugin.md", timestamp: 1, metadata: {} },
};
const sourceHit = { score: 0.87, key: "vendor/nvidia/plugin.md", text: "Use the standalone EP plugin.", indexedAt: 1 };
const scopedRequest = { query: "TRT RTX plugin", scope: "nvidia", limit: 3 } as const;

function searchResponse(chunks: unknown[]) {
  return Response.json({ success: true, result: { chunks }, errors: [], messages: [] });
}

function chatPayload(content: unknown = "Use the plugin.") {
  return {
    id: "chat-1",
    object: "chat.completion",
    model: "test-configured-model",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
    chunks: [sourceChunk],
  };
}

function stubFetch(...responses: Array<Response | Error>) {
  const pending = [...responses];
  const fetchStub = vi.fn<typeof fetch>(async () => {
    const next = pending.shift();
    if (!next) throw new Error("Unexpected extra AI Search request");
    if (next instanceof Error) throw next;
    return next;
  });
  vi.stubGlobal("fetch", fetchStub);
  return fetchStub;
}

function requestBodies(fetchStub: ReturnType<typeof stubFetch>) {
  return fetchStub.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
}

afterEach(() => vi.unstubAllGlobals());

describe("docs-rag REST search", () => {
  it("keeps the sync manifest from using a caller's limit slot", async () => {
    const manifestChunk = { score: 0.99, text: "{\"repos\":{}}", item: { key: "first-party/_sync.json" } };
    stubFetch(searchResponse([manifestChunk, sourceChunk]), searchResponse([]));

    const result = await searchDocs(queryEnv, { ...scopedRequest, limit: 1 });
    expect(result.hits.map((hit) => hit.key)).toEqual([sourceHit.key]);
  });

  it("sends AND and OR scoped retrieval together and maps nonempty chunks without retry", async () => {
    const fetchStub = stubFetch(
      searchResponse([sourceChunk, { score: 0, text: "x".repeat(4001) }, {}]),
      searchResponse([]),
    );

    expect(await searchDocs(queryEnv, { ...scopedRequest, limit: 20 })).toEqual({
      scope: "nvidia",
      matchMode: "union",
      hits: [sourceHit, { score: 0, key: null, text: "x".repeat(4000) }, { score: null, key: null, text: "" }],
    });
    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(fetchStub.mock.calls[0]).toEqual([
      `${apiUrl}/search`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer test-service-token",
          "Content-Type": "application/json; charset=utf-8",
        },
        body: expect.any(String),
      },
    ]);
    expect(requestBodies(fetchStub)).toEqual([{
      query: "TRT RTX plugin",
      ai_search_options: { retrieval: {
        max_num_results: 21,
        keyword_match_mode: "and",
        filters: { folder: { $gte: "vendor/nvidia/", $lt: "vendor/nvidia0" } },
      } },
    }, {
      query: "TRT RTX plugin",
      ai_search_options: { retrieval: {
        max_num_results: 21,
        keyword_match_mode: "or",
        filters: { folder: { $gte: "vendor/nvidia/", $lt: "vendor/nvidia0" } },
      } },
    }]);
  });

  it("keeps query, scope and limit when AND is empty and OR supplies the results", async () => {
    const fetchStub = stubFetch(searchResponse([]), searchResponse([sourceChunk]));

    expect(await searchDocs(queryEnv, scopedRequest)).toEqual({
      scope: "nvidia", matchMode: "union", hits: [sourceHit],
    });
    expect(fetchStub.mock.calls.map(([url]) => url)).toEqual([`${apiUrl}/search`, `${apiUrl}/search`]);
    expect(requestBodies(fetchStub)).toEqual([
      {
        query: "TRT RTX plugin",
        ai_search_options: { retrieval: {
          max_num_results: 4, keyword_match_mode: "and",
          filters: { folder: { $gte: "vendor/nvidia/", $lt: "vendor/nvidia0" } },
        } },
      },
      {
        query: "TRT RTX plugin",
        ai_search_options: { retrieval: {
          max_num_results: 4, keyword_match_mode: "or",
          filters: { folder: { $gte: "vendor/nvidia/", $lt: "vendor/nvidia0" } },
        } },
      },
    ]);
  });

  it("keeps OR-only results when AND already fills the limit with weaker matches", async () => {
    const and = ["one", "two", "three", "four"].map((name) => ({
      ...sourceChunk, id: `and-${name}`, text: `AND-only passage ${name}.`,
    }));
    const or = [
      { ...sourceChunk, id: "or-one", text: "AND-only passage one." },
      { ...sourceChunk, id: "or-two", text: "AND-only passage two." },
      { ...sourceChunk, id: "or-five", text: "OR-only high rank passage." },
      { ...sourceChunk, id: "or-three", text: "AND-only passage three." },
    ];
    const fetchStub = stubFetch(searchResponse(and), searchResponse(or));

    const result = await searchDocs(queryEnv, { ...scopedRequest, limit: 4 });
    expect(result.matchMode).toBe("union");
    expect(result.hits.map(hit => hit.text)).toEqual([
      "AND-only passage one.", "AND-only passage two.", "AND-only passage three.", "OR-only high rank passage.",
    ]);
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it("collapses mirrored chunks with identical text so they cannot consume the result budget", async () => {
    const mirrored = [
      { ...sourceChunk, id: "own", text: "Download policy install versus session.", item: { key: "first-party/trackdub/docs/reference/x.md" } },
      { ...sourceChunk, id: "mirror", text: "Download  policy\ninstall versus session.", item: { key: "first-party/trackdub/docs/reference/reference.md" } },
      { ...sourceChunk, id: "uniq", text: "Unique operations guidance.", item: { key: "first-party/trackdub/docs/operations/y.md" } },
    ];
    const fetchStub = stubFetch(searchResponse(mirrored), searchResponse([]));

    const result = await searchDocs(queryEnv, { query: "download policy", scope: "first-party", limit: 2 });
    expect(result.hits.map(hit => hit.key)).toEqual([
      "first-party/trackdub/docs/reference/x.md", "first-party/trackdub/docs/operations/y.md",
    ]);
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it("keeps distinct passages that share a document key, and blank passages that share nothing", async () => {
    const chunks = [
      { ...sourceChunk, id: "c1", text: "First passage." },
      { ...sourceChunk, id: "c2", text: "Second passage." },
      { ...sourceChunk, id: "c3", text: "  " },
      { ...sourceChunk, id: "c4", text: "" },
    ];
    stubFetch(searchResponse(chunks), searchResponse([]));

    const result = await searchDocs(queryEnv, { ...scopedRequest, limit: 4 });
    expect(result.hits.map(hit => hit.text)).toEqual(["First passage.", "Second passage.", "  ", ""]);
  });

  it("stops after both source groups are empty under AND and OR at limit 1", async () => {
    const fetchStub = stubFetch(searchResponse([]), searchResponse([]), searchResponse([]), searchResponse([]));

    expect(await searchDocs(queryEnv, { query: "rare term", scope: "all", limit: 1 })).toEqual({
      scope: "all", matchMode: "union", hits: [],
    });
    expect(requestBodies(fetchStub)).toEqual([
      { query: "rare term", ai_search_options: { retrieval: { max_num_results: 2, keyword_match_mode: "and",
        filters: { folder: { $gte: "first-party/", $lt: "first-party0" } } } } },
      { query: "rare term", ai_search_options: { retrieval: { max_num_results: 2, keyword_match_mode: "and",
        filters: { folder: { $gte: "vendor/", $lt: "vendor0" } } } } },
      { query: "rare term", ai_search_options: { retrieval: { max_num_results: 2, keyword_match_mode: "or",
        filters: { folder: { $gte: "first-party/", $lt: "first-party0" } } } } },
      { query: "rare term", ai_search_options: { retrieval: { max_num_results: 2, keyword_match_mode: "or",
        filters: { folder: { $gte: "vendor/", $lt: "vendor0" } } } } },
    ]);
  });

  it("recovers literal symbol prefixes with one uncached unreranked candidate search", async () => {
    const fetchStub = stubFetch(searchResponse([]), searchResponse([]), searchResponse([
      { ...sourceChunk, text: "Register a plugin. No matching identifier here." },
      { ...sourceChunk, text: "Call OrtEnv.RegisterExecutionProviderLibrary() to load the EP." },
      { ...sourceChunk, text: "RegisterExecutionProviderLibrary also works here." },
    ]));
    expect(await searchDocs(queryEnv, { query: "RegisterExec", scope: "nvidia", limit: 1 })).toEqual({
      scope: "nvidia", matchMode: "symbol-fallback",
      hits: [{ ...sourceHit, text: "Call OrtEnv.RegisterExecutionProviderLibrary() to load the EP." }],
    });
    expect(fetchStub).toHaveBeenCalledTimes(3);
    expect(requestBodies(fetchStub)[2]).toEqual({
      query: "RegisterExec",
      ai_search_options: {
        cache: { enabled: false }, reranking: { enabled: false },
        retrieval: { max_num_results: 20, keyword_match_mode: "or", retrieval_type: "hybrid",
          filters: { folder: { $gte: "vendor/nvidia/", $lt: "vendor/nvidia0" } } },
      },
    });
  });

  it("does not return semantic-only candidates or substrings inside other identifiers", async () => {
    const fetchStub = stubFetch(
      searchResponse([]), searchResponse([]), searchResponse([]), searchResponse([]), searchResponse([]),
      searchResponse([
        { ...sourceChunk, text: "Register a library." },
        { ...sourceChunk, text: "DeregisterExecutionProviderLibrary" },
        { ...sourceChunk, text: "x".repeat(4001) + " RegisterExecutionProviderLibrary" },
      ]),
    );
    expect(await searchDocs(queryEnv, { query: "RegisterExec", scope: "all", limit: 3 })).toEqual({
      scope: "all", matchMode: "symbol-fallback", hits: [],
    });
    expect(fetchStub).toHaveBeenCalledTimes(6);
  });

  it.each(["ordinary", "why does this fail", "abc", "X".repeat(129), "foo.*"])(
    "does not use symbol fallback for non-symbol query %s", async (query) => {
      const fetchStub = stubFetch(searchResponse([]), searchResponse([]));
      expect((await searchDocs(queryEnv, { ...scopedRequest, query })).hits).toEqual([]);
      expect(fetchStub).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    ["OrtEnv.Reg", "Call OrtEnv.RegisterExecutionProviderLibrary()."],
    ["register_exec", "register_execution_provider"],
  ])("supports literal dotted and snake-case prefixes: %s", async (query, text) => {
    const fetchStub = stubFetch(searchResponse([]), searchResponse([]), searchResponse([{ ...sourceChunk, text }]));
    expect((await searchDocs(queryEnv, { ...scopedRequest, query })).hits).toEqual([{ ...sourceHit, text }]);
    expect(fetchStub).toHaveBeenCalledTimes(3);
  });

  it("recovers queries made of several identifiers and ranks chunks matching more of them first", async () => {
    const fetchStub = stubFetch(searchResponse([]), searchResponse([]), searchResponse([
      { ...sourceChunk, text: "Semantic neighbour with no identifiers." },
      { ...sourceChunk, text: "nv_profile_min_shapes only." },
      { ...sourceChunk, text: "Options: nv_profile_min_shapes, nv_profile_max_shapes, nv_profile_opt_shapes." },
    ]));
    const result = await searchDocs(queryEnv, {
      query: "nv_profile_min_shapes nv_profile_max_shapes nv_profile_opt_shapes provider options",
      scope: "onnxruntime",
      limit: 5,
    });
    expect(result.matchMode).toBe("symbol-fallback");
    expect(result.hits.map(hit => hit.text)).toEqual([
      "Options: nv_profile_min_shapes, nv_profile_max_shapes, nv_profile_opt_shapes.",
      "nv_profile_min_shapes only.",
    ]);
    expect(requestBodies(fetchStub)[2].query).toBe(
      "nv_profile_min_shapes nv_profile_max_shapes nv_profile_opt_shapes provider options");
  });

  it("strips surrounding punctuation from identifier tokens", async () => {
    const fetchStub = stubFetch(searchResponse([]), searchResponse([]), searchResponse([
      { ...sourceChunk, text: "Call OrtEnv.RegisterExecutionProviderLibrary() first." },
    ]));
    const result = await searchDocs(queryEnv, { ...scopedRequest, query: "why does (OrtEnv.RegisterExec), fail?" });
    expect(result.matchMode).toBe("symbol-fallback");
    expect(result.hits).toHaveLength(1);
    expect(fetchStub).toHaveBeenCalledTimes(3);
  });

  it("does not bypass reranking when the AND/OR union already returned symbol results", async () => {
    const fetchStub = stubFetch(searchResponse([]), searchResponse([sourceChunk]));
    expect((await searchDocs(queryEnv, { ...scopedRequest, query: "RegisterExec" })).matchMode).toBe("union");
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it("propagates symbol fallback errors instead of hiding them as empty success", async () => {
    const fetchStub = stubFetch(searchResponse([]), searchResponse([]), new Response("unavailable", { status: 503 }));
    await expect(searchDocs(queryEnv, { ...scopedRequest, query: "RegisterExec" })).rejects.toThrow("503");
    expect(fetchStub).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["missing chunks", { success: true, result: {} }],
    ["null chunks", { success: true, result: { chunks: null } }],
    ["non-array chunks", { success: true, result: { chunks: {} } }],
    ["null chunk", { success: true, result: { chunks: [null] } }],
    ["non-string chunk text", { success: true, result: { chunks: [{ text: 7 }] } }],
    ["missing success", { result: { chunks: [] } }],
    ["truthy non-boolean success", { success: "true", result: { chunks: [] } }],
  ])("rejects %s without treating it as an empty result", async (_name, payload) => {
    const fetchStub = stubFetch(Response.json(payload), searchResponse([]));
    await expect(searchDocs(queryEnv, scopedRequest)).rejects.toThrow();
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });
});

describe("docs-rag first-party ordering", () => {
  const firstParty = [
    { ...sourceChunk, id: "first-1", score: 0.51, text: "First-party core plugin guidance.", item: { key: "first-party/trackdub/a.md" } },
    { ...sourceChunk, id: "first-2", score: 0.79, text: "First-party API plugin guidance.", item: { key: "first-party/api/b.md" } },
  ];
  const vendors = [
    { ...sourceChunk, id: "vendor-1", score: 0.95, text: "NVIDIA plugin guidance." },
    { ...sourceChunk, id: "vendor-2", score: 0.99, text: "Microsoft plugin guidance.", item: { key: "vendor/microsoft/c.md" } },
  ];

  it.each([
    { limit: 1, keys: ["first-party/trackdub/a.md"], scores: [0.51] },
    { limit: 3, keys: ["first-party/trackdub/a.md", "first-party/api/b.md", "vendor/nvidia/plugin.md"], scores: [0.51, 0.79, 0.95] },
    { limit: 20, keys: ["first-party/trackdub/a.md", "first-party/api/b.md", "vendor/nvidia/plugin.md", "vendor/microsoft/c.md"], scores: [0.51, 0.79, 0.95, 0.99] },
  ])("puts first-party before higher-scoring vendors without reordering either group at limit $limit", async ({ limit, keys, scores }) => {
    const fetchStub = vi.fn<typeof fetch>(async (_url, init) => {
      const { ai_search_options: { retrieval } } = JSON.parse(String(init?.body));
      const chunks = retrieval.filters?.folder.$gte === "first-party/" ? firstParty : vendors;
      return searchResponse(chunks.slice(0, retrieval.max_num_results));
    });
    vi.stubGlobal("fetch", fetchStub);

    const result = await searchDocs(queryEnv, { query: "runtime cache", scope: "all", limit });
    expect(result.scope).toBe("all");
    expect(result.matchMode).toBe("union");
    expect(result.hits.map(hit => hit.key)).toEqual(keys);
    expect(result.hits.map(hit => hit.score)).toEqual(scores);
    expect(requestBodies(fetchStub)).toEqual([
      { query: "runtime cache", ai_search_options: { retrieval: { max_num_results: limit + 1, keyword_match_mode: "and",
        filters: { folder: { $gte: "first-party/", $lt: "first-party0" } } } } },
      { query: "runtime cache", ai_search_options: { retrieval: { max_num_results: limit + 1, keyword_match_mode: "and",
        filters: { folder: { $gte: "vendor/", $lt: "vendor0" } } } } },
      { query: "runtime cache", ai_search_options: { retrieval: { max_num_results: limit + 1, keyword_match_mode: "or",
        filters: { folder: { $gte: "first-party/", $lt: "first-party0" } } } } },
      { query: "runtime cache", ai_search_options: { retrieval: { max_num_results: limit + 1, keyword_match_mode: "or",
        filters: { folder: { $gte: "vendor/", $lt: "vendor0" } } } } },
    ]);
  });

  it("keeps first-party ahead of vendors when only the OR requests return results", async () => {
    const fetchStub = stubFetch(searchResponse([]), searchResponse([]), searchResponse(firstParty), searchResponse(vendors));
    const result = await searchDocs(queryEnv, { query: "runtime cache", scope: "all", limit: 3 });
    expect(result.matchMode).toBe("union");
    expect(result.hits.map(hit => hit.key)).toEqual([
      "first-party/trackdub/a.md", "first-party/api/b.md", "vendor/nvidia/plugin.md",
    ]);
    expect(requestBodies(fetchStub).map(body => body.ai_search_options.retrieval.keyword_match_mode)).toEqual(["and", "and", "or", "or"]);
  });

  it("keeps one-sided first-party matches without adding empty vendor noise", async () => {
    const fetchStub = stubFetch(searchResponse(firstParty), searchResponse([]), searchResponse([]), searchResponse([]));
    const result = await searchDocs(queryEnv, { query: "runtime cache", scope: "all", limit: 3 });
    expect(result.matchMode).toBe("union");
    expect(result.hits.map(hit => hit.key)).toEqual(["first-party/trackdub/a.md", "first-party/api/b.md"]);
    expect(fetchStub).toHaveBeenCalledTimes(4);
  });

  it.each([1, 3])("filters symbol candidates before applying first-party ordering and limit %s", async (limit) => {
    const fetchStub = stubFetch(
      searchResponse([]), searchResponse([]), searchResponse([]), searchResponse([]),
      searchResponse([
        { ...firstParty[0], text: "Register a plugin." },
        { ...firstParty[0], text: "RegisterExecutionProviderLibrary in core." },
        { ...firstParty[1], text: "Call OrtEnv.RegisterExecutionProviderLibrary()." },
      ]),
      searchResponse([{ ...vendors[0], text: "RegisterExecutionProviderLibrary in vendor docs." }]),
    );
    const result = await searchDocs(queryEnv, { query: "RegisterExec", scope: "all", limit });
    expect(result.matchMode).toBe("symbol-fallback");
    expect(result.hits.map(hit => hit.text)).toEqual(limit === 1
      ? ["RegisterExecutionProviderLibrary in core."]
      : ["RegisterExecutionProviderLibrary in core.", "Call OrtEnv.RegisterExecutionProviderLibrary().", "RegisterExecutionProviderLibrary in vendor docs."]);
    expect(requestBodies(fetchStub).slice(4)).toEqual([
      { query: "RegisterExec", ai_search_options: { cache: { enabled: false }, reranking: { enabled: false },
        retrieval: { max_num_results: 20, keyword_match_mode: "or", retrieval_type: "hybrid",
          filters: { folder: { $gte: "first-party/", $lt: "first-party0" } } } } },
      { query: "RegisterExec", ai_search_options: { cache: { enabled: false }, reranking: { enabled: false },
        retrieval: { max_num_results: 20, keyword_match_mode: "or", retrieval_type: "hybrid",
          filters: { folder: { $gte: "vendor/", $lt: "vendor0" } } } } },
    ]);
  });

  it("leaves explicit first-party scope restricted and preserves upstream order", async () => {
    const fetchStub = stubFetch(searchResponse(firstParty), searchResponse([]));
    const result = await searchDocs(queryEnv, { query: "runtime cache", scope: "first-party", limit: 3 });
    expect(result.hits.map(hit => hit.key)).toEqual(["first-party/trackdub/a.md", "first-party/api/b.md"]);
    expect(requestBodies(fetchStub)).toEqual([
      { query: "runtime cache", ai_search_options: { retrieval: { max_num_results: 4, keyword_match_mode: "and",
        filters: { folder: { $gte: "first-party/", $lt: "first-party0" } } } } },
      { query: "runtime cache", ai_search_options: { retrieval: { max_num_results: 4, keyword_match_mode: "or",
        filters: { folder: { $gte: "first-party/", $lt: "first-party0" } } } } },
    ]);
  });

  it.each(["first-party/", "vendor/"])("does not hide %s failures behind results from the other group", async (failingPrefix) => {
    const fetchStub = vi.fn<typeof fetch>(async (_url, init) => {
      const prefix = JSON.parse(String(init?.body)).ai_search_options.retrieval.filters?.folder.$gte;
      return prefix === failingPrefix ? new Response("unavailable", { status: 503 }) : searchResponse([sourceChunk]);
    });
    vi.stubGlobal("fetch", fetchStub);
    await expect(searchDocs(queryEnv, { query: "runtime cache", scope: "all", limit: 3 })).rejects.toThrow("503");
    expect(fetchStub).toHaveBeenCalledTimes(4);
  });

  it("preserves all-scope answer text and citation order from the single chat response", async () => {
    const fetchStub = stubFetch(Response.json({ ...chatPayload(), chunks: [...vendors, ...firstParty] }));
    const result = await askDocs(queryEnv, { query: "runtime cache", scope: "all", limit: 20 });
    expect(result.answer).toBe("Use the plugin.");
    expect(result.hits.map(hit => hit.key)).toEqual([
      "vendor/nvidia/plugin.md", "vendor/microsoft/c.md", "first-party/trackdub/a.md", "first-party/api/b.md",
    ]);
    expect(fetchStub.mock.calls.map(([url]) => url)).toEqual([`${apiUrl}/chat/completions`]);
  });
});

describe("docs-rag REST chat", () => {
  it("uses one scoped chat request and returns that completion's chunks, not separate search results", async () => {
    const fetchStub = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith("/search")) {
        return searchResponse([{ ...sourceChunk, text: "Unrelated retrieval", item: { key: "wrong.md" } }]);
      }
      return Response.json({ ...chatPayload(), search_query: "provider-reported query" });
    });
    vi.stubGlobal("fetch", fetchStub);

    expect(await askDocs(queryEnv, scopedRequest)).toEqual({
      scope: "nvidia", searchQuery: "provider-reported query", answer: "Use the plugin.", hits: [sourceHit],
    });
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(fetchStub.mock.calls[0]).toEqual([
      `${apiUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer test-service-token",
          "Content-Type": "application/json; charset=utf-8",
        },
        body: expect.any(String),
      },
    ]);
    expect(requestBodies(fetchStub)).toEqual([{
      messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: "TRT RTX plugin" }],
      model: "test-configured-model",
      ai_search_options: {
        query_rewrite: { enabled: true },
        retrieval: {
          max_num_results: 4,
          filters: { folder: { $gte: "vendor/nvidia/", $lt: "vendor/nvidia0" } },
        },
      },
    }]);
  });

  it("keeps all unfiltered and does not invent a rewritten query or retry empty chat chunks", async () => {
    const fetchStub = stubFetch(Response.json({ ...chatPayload(), chunks: [] }));
    expect(await askDocs(queryEnv, { query: "first question", scope: "all", limit: 20 })).toEqual({
      scope: "all", searchQuery: null, answer: "Use the plugin.", hits: [],
    });
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(requestBodies(fetchStub)).toEqual([{
      messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: "first question" }],
      model: "test-configured-model",
      ai_search_options: { query_rewrite: { enabled: true }, retrieval: { max_num_results: 21 } },
    }]);
  });

  it("preserves a valid empty answer and an explicitly supplied empty search query", async () => {
    const fetchStub = stubFetch(Response.json({ ...chatPayload(""), search_query: "" }));
    expect(await askDocs(queryEnv, scopedRequest)).toEqual({
      scope: "nvidia", searchQuery: "", answer: "", hits: [sourceHit],
    });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing choices", { chunks: [] }],
    ["empty choices", { ...chatPayload(), choices: [] }],
    ["missing message", { ...chatPayload(), choices: [{}] }],
    ["missing content", { ...chatPayload(), choices: [{ message: {} }] }],
    ["null content", chatPayload(null)],
    ["numeric content", chatPayload(123)],
    ["missing chunks", { choices: [{ message: { content: "Answer" } }] }],
    ["null chunks", { ...chatPayload(), chunks: null }],
    ["non-array chunks", { ...chatPayload(), chunks: {} }],
    ["null chunk", { ...chatPayload(), chunks: [null] }],
    ["invalid chunk text", { ...chatPayload(), chunks: [{ text: 1 }] }],
    ["invalid search query", { ...chatPayload(), search_query: 123 }],
  ])("rejects %s instead of returning a successful empty answer", async (_name, payload) => {
    const fetchStub = stubFetch(Response.json(payload));
    await expect(askDocs(queryEnv, scopedRequest)).rejects.toThrow();
    expect(fetchStub.mock.calls.map(([url]) => url)).toEqual([`${apiUrl}/chat/completions`]);
  });
});

const upstreamFailures = [
  { name: "HTTP failure", status: 503, body: "unavailable", rateLimited: false },
  { name: "HTTP 429", status: 429, body: "slow down", rateLimited: true },
  { name: "compact code 2003", status: 503, body: '{"errors":[{"code":2003}]}', rateLimited: true },
  { name: "whitespace code 2003", status: 503, body: '{ "errors": [ { "code" : 2003 } ] }', rateLimited: true },
  { name: "successful HTTP with rate-limit envelope", status: 200, body: '{"success":false,"errors":[{"code": 2003}]}', rateLimited: true },
  { name: "chat rate-limit error", status: 200, body: '{"error":{"code":2003,"message":"limited"}}', rateLimited: true },
  { name: "API failure envelope", status: 200, body: '{"success":false,"errors":[{"code":1000,"message":"denied"}]}', rateLimited: false },
  { name: "API errors despite success", status: 200, body: JSON.stringify({
    ...chatPayload(), success: true, result: { chunks: [] }, errors: [{ code: 1000, message: "denied" }],
  }), rateLimited: false },
  { name: "chat error despite choices", status: 200, body: JSON.stringify({
    ...chatPayload(), error: { message: "denied" },
  }), rateLimited: false },
  { name: "invalid JSON", status: 200, body: "not JSON", rateLimited: false },
  { name: "null JSON", status: 200, body: "null", rateLimited: false },
  { name: "empty JSON", status: 200, body: "{}", rateLimited: false },
];

describe.each([
  { name: "search", run: searchDocs, path: "search", requests: 2 },
  { name: "chat", run: askDocs, path: "chat/completions", requests: 1 },
])("docs-rag $name errors", ({ run, path, requests }) => {
  it.each(upstreamFailures)("propagates $name without fallback", async ({ status, body, rateLimited }) => {
    const fetchStub = stubFetch(...Array.from({ length: requests }, () => new Response(body, { status })));
    const result = run(queryEnv, scopedRequest);
    await expect(result).rejects.toThrow(rateLimited ? RateLimitedError : Error);
    if (!rateLimited) await expect(result).rejects.not.toBeInstanceOf(RateLimitedError);
    expect(fetchStub.mock.calls.map(([url]) => url)).toEqual(Array(requests).fill(`${apiUrl}/${path}`));
  });

  it("propagates transport failure without fallback", async () => {
    const failure = new Error("connection failed");
    const fetchStub = stubFetch(...Array.from({ length: requests }, () => failure));
    await expect(run(queryEnv, scopedRequest)).rejects.toBe(failure);
    expect(fetchStub.mock.calls.map(([url]) => url)).toEqual(Array(requests).fill(`${apiUrl}/${path}`));
  });
});

describe("docs-rag OR request errors", () => {
  it.each(upstreamFailures)("propagates $name from the OR request without a third request", async ({ status, body, rateLimited }) => {
    const fetchStub = stubFetch(searchResponse([]), new Response(body, { status }));
    const result = searchDocs(queryEnv, scopedRequest);
    await expect(result).rejects.toThrow(rateLimited ? RateLimitedError : Error);
    if (!rateLimited) await expect(result).rejects.not.toBeInstanceOf(RateLimitedError);
    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(requestBodies(fetchStub)[1].ai_search_options.retrieval.keyword_match_mode).toBe("or");
  });

  it("propagates transport failure from the OR request", async () => {
    const failure = new Error("fallback connection failed");
    const fetchStub = stubFetch(searchResponse([]), failure);
    await expect(searchDocs(queryEnv, scopedRequest)).rejects.toBe(failure);
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });
});
