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

const UPLOADED_MS = 1_700_000_050_000;
const FRESH_SECONDS = 1_700_000_100;
const STALE_SECONDS = 1_700_000_000;

const sync: SyncManifest = {
  syncedAt: "2026-11-11T02:00:00+00:00",
  uploadedAt: UPLOADED_MS,
  repos: { trackdub: { commit: "f2bf40a429eb", dirty: false }, api: { commit: "c5a5f9458717", dirty: true } },
};

function corpusWith(body: string | null, uploaded?: Date) {
  const get = vi.fn(async () => (body === null ? null : { text: async () => body, uploaded }));
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
  it("stamps the commit when the item was indexed after the upload", () => {
    expect(provenanceFor("first-party/trackdub/docs/reference/x.md", sync, FRESH_SECONDS)).toEqual({
      repo: "trackdub",
      localPath: "docs/reference/x.md",
      syncedCommit: "f2bf40a429eb",
      syncedAt: "2026-11-11T02:00:00+00:00",
    });
  });

  it("flags a corpus synced from a dirty tree", () => {
    expect(provenanceFor("first-party/api/docs/y.md", sync, FRESH_SECONDS)).toMatchObject({
      syncedCommit: "c5a5f9458717",
      syncedDirty: true,
    });
  });

  it("omits the commit and dirty flag for items indexed before the upload", () => {
    expect(provenanceFor("first-party/trackdub/docs/a.md", sync, STALE_SECONDS)).toEqual({
      repo: "trackdub",
      localPath: "docs/a.md",
      syncedAt: "2026-11-11T02:00:00+00:00",
    });
  });

  it("omits the commit when the index timestamp or the upload time is unknown", () => {
    expect(provenanceFor("first-party/trackdub/docs/a.md", sync)).not.toHaveProperty("syncedCommit");
    expect(provenanceFor("first-party/trackdub/docs/a.md", { ...sync, uploadedAt: undefined }, FRESH_SECONDS)).not.toHaveProperty("syncedCommit");
  });

  it("accepts millisecond index timestamps as well as seconds", () => {
    expect(provenanceFor("first-party/trackdub/docs/a.md", sync, FRESH_SECONDS * 1000)).toHaveProperty("syncedCommit");
    expect(provenanceFor("first-party/trackdub/docs/a.md", sync, STALE_SECONDS * 1000)).not.toHaveProperty("syncedCommit");
  });

  it("still names repo and path when no sync manifest exists", () => {
    expect(provenanceFor("first-party/trackdub-gated/docs/z.md", null, FRESH_SECONDS)).toEqual({
      repo: "trackdub-gated",
      localPath: "docs/z.md",
    });
  });

  it("adds nothing to vendor or missing keys", () => {
    expect(provenanceFor("vendor/nvidia/ep-abi-v050.md", sync, FRESH_SECONDS)).toEqual({});
    expect(provenanceFor(null, sync, FRESH_SECONDS)).toEqual({});
  });

  it("keeps the dirty flag when the commit is unavailable", () => {
    const manifest: SyncManifest = { ...sync, repos: { api: { commit: null, dirty: true } } };
    expect(provenanceFor("first-party/api/docs/y.md", manifest, FRESH_SECONDS)).toEqual({
      repo: "api",
      localPath: "docs/y.md",
      syncedAt: sync.syncedAt,
      syncedDirty: true,
    });
  });

  it("drops malformed fields instead of exposing them", () => {
    const malformed = {
      uploadedAt: UPLOADED_MS,
      syncedAt: [] as unknown as string,
      repos: { trackdub: { commit: 123 as unknown as string, dirty: "false" as unknown as boolean } },
    };
    expect(provenanceFor("first-party/trackdub/docs/a.md", malformed, FRESH_SECONDS)).toEqual({
      repo: "trackdub",
      localPath: "docs/a.md",
    });
  });
});

describe("loadSyncManifest", () => {
  const body = JSON.stringify({ syncedAt: sync.syncedAt, repos: sync.repos });

  it("takes the upload time from the R2 object", async () => {
    const { env } = corpusWith(body, new Date(UPLOADED_MS));
    expect((await loadSyncManifest(env, 1_000))?.uploadedAt).toBe(UPLOADED_MS);
  });

  it("reads the manifest once within the cache window", async () => {
    const { env, get } = corpusWith(body, new Date(UPLOADED_MS));
    expect(await loadSyncManifest(env, 1_000)).toMatchObject({ syncedAt: sync.syncedAt });
    await loadSyncManifest(env, 2_000);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(SYNC_KEY);
  });

  it("refetches after the cache window", async () => {
    const { env, get } = corpusWith(body, new Date(UPLOADED_MS));
    await loadSyncManifest(env, 0);
    await loadSyncManifest(env, 10 * 60_000);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it.each([["missing object", null], ["invalid JSON", "{not json"], ["non-object JSON", "[1,2]"]])(
    "degrades to no stamp for %s",
    async (_name, text) => {
      const { env } = corpusWith(text);
      expect(await loadSyncManifest(env)).toBeNull();
    },
  );

  it("degrades to no stamp when R2 throws", async () => {
    const env = { CORPUS: { get: vi.fn().mockRejectedValue(new Error("r2 down")) } as unknown as R2Bucket };
    expect(await loadSyncManifest(env)).toBeNull();
  });
});

describe("withProvenance", () => {
  it("stamps only fresh first-party hits, leaves vendor hits alone and hides the sync manifest", async () => {
    const { env } = corpusWith(JSON.stringify({ syncedAt: sync.syncedAt, repos: sync.repos }), new Date(UPLOADED_MS));
    const result = await withProvenance(env, {
      scope: "all",
      hits: [
        { score: 1, key: "first-party/trackdub/docs/a.md", text: "a", indexedAt: FRESH_SECONDS },
        { score: 0.95, key: "first-party/trackdub/docs/old.md", text: "o", indexedAt: STALE_SECONDS },
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
      {
        score: 0.95,
        key: "first-party/trackdub/docs/old.md",
        text: "o",
        repo: "trackdub",
        localPath: "docs/old.md",
        syncedAt: sync.syncedAt,
      },
      { score: 0.8, key: "vendor/olive/olive-why.md", text: "v" },
      { score: 0.1, key: null, text: "" },
    ]);
  });
});
