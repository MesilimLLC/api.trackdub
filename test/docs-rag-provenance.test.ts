import { beforeEach, describe, expect, it, vi } from "vitest";
import { PIN, PIN_SENTENCE } from "@/docs-rag/pin.generated";
import {
  loadSyncManifest,
  provenanceFor,
  resetSyncManifestCache,
  SYNC_KEY,
  withProvenance,
  type SyncManifest,
} from "@/docs-rag/provenance";
import { SYSTEM_PROMPT } from "@/docs-rag/scopes";

const sync: SyncManifest = {
  syncedAt: "2026-11-11T02:00:00+00:00",
  repos: { trackdub: { commit: "f2bf40a429eb", dirty: false }, api: { commit: "c5a5f9458717", dirty: true } },
};

function corpusWith(body: string | null) {
  const get = vi.fn(async () => (body === null ? null : { text: async () => body }));
  return { env: { CORPUS: { get } as unknown as R2Bucket }, get };
}

beforeEach(() => resetSyncManifestCache());

describe("pin text", () => {
  it("states the generated pin to the answer model", () => {
    expect(SYSTEM_PROMPT).toContain(PIN_SENTENCE.replace(/\.$/, ""));
    expect(PIN_SENTENCE).toContain(PIN.trtRtx);
    expect(PIN_SENTENCE).toContain(PIN.windows);
  });

  it("no longer carries the superseded pin", () => {
    expect(SYSTEM_PROMPT).not.toContain("0.4.2");
    expect(SYSTEM_PROMPT).not.toContain("1.6.1");
  });
});

describe("provenanceFor", () => {
  it("maps a first-party key back to a checkout path and the synced commit", () => {
    expect(provenanceFor("first-party/trackdub/docs/reference/x.md", sync)).toEqual({
      repo: "trackdub",
      localPath: "docs/reference/x.md",
      syncedCommit: "f2bf40a429eb",
      syncedAt: "2026-11-11T02:00:00+00:00",
    });
  });

  it("flags a corpus synced from a dirty tree", () => {
    expect(provenanceFor("first-party/api/docs/y.md", sync)).toMatchObject({ syncedCommit: "c5a5f9458717", syncedDirty: true });
  });

  it("still names repo and path when no sync manifest exists", () => {
    expect(provenanceFor("first-party/trackdub-gated/docs/z.md", null)).toEqual({
      repo: "trackdub-gated",
      localPath: "docs/z.md",
    });
  });

  it("adds nothing to vendor or missing keys", () => {
    expect(provenanceFor("vendor/nvidia/ep-abi-v050.md", sync)).toEqual({});
    expect(provenanceFor(null, sync)).toEqual({});
  });
});

describe("loadSyncManifest", () => {
  it("reads the manifest once within the cache window", async () => {
    const { env, get } = corpusWith(JSON.stringify(sync));
    expect(await loadSyncManifest(env, 1_000)).toEqual(sync);
    expect(await loadSyncManifest(env, 2_000)).toEqual(sync);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(SYNC_KEY);
  });

  it("refetches after the cache window", async () => {
    const { env, get } = corpusWith(JSON.stringify(sync));
    await loadSyncManifest(env, 0);
    await loadSyncManifest(env, 10 * 60_000);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it.each([["missing object", null], ["invalid JSON", "{not json"], ["non-object JSON", "[1,2]"]])(
    "degrades to no stamp for %s",
    async (_name, body) => {
      const { env } = corpusWith(body);
      expect(await loadSyncManifest(env)).toBeNull();
    },
  );

  it("degrades to no stamp when R2 throws", async () => {
    const env = { CORPUS: { get: vi.fn().mockRejectedValue(new Error("r2 down")) } as unknown as R2Bucket };
    expect(await loadSyncManifest(env)).toBeNull();
  });
});

describe("withProvenance", () => {
  it("stamps first-party hits, leaves vendor hits alone and hides the sync manifest", async () => {
    const { env } = corpusWith(JSON.stringify(sync));
    const result = await withProvenance(env, {
      scope: "all",
      hits: [
        { score: 1, key: "first-party/trackdub/docs/a.md", text: "a" },
        { score: 0.9, key: SYNC_KEY, text: "{}" },
        { score: 0.8, key: "vendor/olive/olive-why.md", text: "v" },
        { score: 0.1, key: null, text: "" },
      ],
    });
    expect(result.scope).toBe("all");
    expect(result.hits).toEqual([
      {
        score: 1,
        key: "first-party/trackdub/docs/a.md",
        text: "a",
        repo: "trackdub",
        localPath: "docs/a.md",
        syncedCommit: "f2bf40a429eb",
        syncedAt: sync.syncedAt,
      },
      { score: 0.8, key: "vendor/olive/olive-why.md", text: "v" },
      { score: 0.1, key: null, text: "" },
    ]);
  });
});

describe("provenance field validation", () => {
  it("keeps the dirty flag when the commit is unavailable", () => {
    expect(provenanceFor("first-party/api/docs/y.md", { repos: { api: { commit: null, dirty: true } } })).toEqual({
      repo: "api",
      localPath: "docs/y.md",
      syncedDirty: true,
    });
  });

  it("drops malformed fields instead of exposing them", () => {
    const malformed = { syncedAt: [] as unknown as string, repos: { trackdub: { commit: 123 as unknown as string, dirty: "false" as unknown as boolean } } };
    expect(provenanceFor("first-party/trackdub/docs/a.md", malformed)).toEqual({ repo: "trackdub", localPath: "docs/a.md" });
  });
});
