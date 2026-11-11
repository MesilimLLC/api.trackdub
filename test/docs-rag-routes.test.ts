import { afterEach, describe, expect, it, vi } from "vitest";
import app from "@/docs-rag/index";

const SYNC = "first-party/_sync.json";
const manifest = JSON.stringify({
  files: ["first-party/trackdub/docs/a.md"],
  syncedAt: "2026-11-11T02:00:00+00:00",
  repos: { trackdub: { commit: "f2bf40a429eb", dirty: false } },
});

function bindings(uploads: Record<string, Date>) {
  const limiter = { limit: async () => ({ success: true }) };
  return {
    DOCS_RAG_TOKEN: "test-token-0123456789abcdef",
    AI_SEARCH_API_TOKEN: "ai-token",
    AI_SEARCH_INSTANCE: "trackdub-docs",
    AI_SEARCH_MODEL: "model",
    CF_ACCOUNT_ID: "account",
    RL_BURST: limiter,
    RL_STEADY: limiter,
    RL_ASK: limiter,
    CORPUS: {
      get: async (key: string) => (key === SYNC ? { text: async () => manifest } : null),
      head: async (key: string) => (uploads[key] ? { uploaded: uploads[key] } : null),
    },
  };
}

function searchStub() {
  return vi.fn(async () =>
    Response.json({
      success: true,
      result: {
        chunks: [
          { id: "doc", score: 0.9, text: "doc body", item: { key: "first-party/trackdub/docs/a.md", timestamp: 1_700_000_100 } },
          { id: "manifest", score: 0.8, text: manifest, item: { key: SYNC, timestamp: 1_700_000_100 } },
        ],
      },
      errors: [],
      messages: [],
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("POST /v1/search provenance wiring", () => {
  it("stamps first-party hits and never returns the sync manifest", async () => {
    vi.stubGlobal("fetch", searchStub());
    const env = bindings({ "first-party/trackdub/docs/a.md": new Date(1_700_000_050_000) });
    const res = await app.request(
      "/v1/search",
      {
        method: "POST",
        headers: { authorization: "Bearer test-token-0123456789abcdef", "content-type": "application/json" },
        body: JSON.stringify({ query: "pin", scope: "first-party", limit: 8 }),
      },
      env as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: Array<Record<string, unknown>> };
    expect(body.hits.map((hit) => hit.key)).toEqual(["first-party/trackdub/docs/a.md"]);
    expect(body.hits[0]).toMatchObject({ repo: "trackdub", localPath: "docs/a.md", syncedCommit: "f2bf40a429eb" });
  });

  it("rejects requests without the bearer token before any search runs", async () => {
    const fetchStub = searchStub();
    vi.stubGlobal("fetch", fetchStub);
    const res = await app.request(
      "/v1/search",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "pin" }) },
      bindings({}) as never,
    );
    expect(res.status).toBe(401);
    expect(fetchStub).not.toHaveBeenCalled();
  });
});
