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
const fresh = { indexedAt: FRESH_SECONDS, uploadedAt: UPLOADED_MS };
const stale = { indexedAt: STALE_SECONDS, uploadedAt: UPLOADED_MS };

const FILES = [
  "first-party/trackdub/docs/reference/x.md",
  "first-party/trackdub/docs/a.md",
  "first-party/trackdub/docs/old.md",
  "first-party/api/docs/y.md",
];
const sync: SyncManifest = {
  files: FILES,
  syncedAt: "2026-11-11T02:00:00+00:00",
  repos: { trackdub: { commit: "f2bf40a429eb", dirty: false }, api: { commit: "c5a5f9458717", dirty: true } },
};

/** uploads maps an R2 key to its upload time; a key absent from it behaves like a missing object. */
function corpusWith(body: string | null, uploads: Record<string, Date> = {}) {
  const get = vi.fn(async () => (body === null ? null : { text: async () => body }));
  const head = vi.fn(async (key: string) => (uploads[key] ? { uploaded: uploads[key] } : null));
  return { env: { CORPUS: { get, head } as unknown as R2Bucket }, get, head };
}

beforeEach(() => resetSyncManifestCache());

describe("pin text", () => {
  it("states the generated pin to the answer model", () => {
    expect(SYSTEM_PROMPT).toContain(PIN_SENTENCE.replace(/\.$/, "") + ", as a standalone ONNX Runtime plugin");
    expect(PIN_SENTENCE).toContain(PIN.trtRtx);
    expect(PIN_SENTENCE).toContain(PIN.windows);
    expect(PIN_SENTENCE).toContain(PIN.linux);
    expect(PIN_SENTENCE).toContain(PIN.cuda);
    expect(PIN_SENTENCE).toContain("Windows");
    expect(PIN_SENTENCE).toContain("Linux");
  });

  it("no longer carries the superseded pin", () => {
    expect(SYSTEM_PROMPT).not.toContain("0.4.2");
    expect(SYSTEM_PROMPT).not.toContain("1.6.1");
  });
});

describe("provenanceFor", () => {
  it("stamps the commit when the item was indexed after its object was uploaded", () => {
    expect(provenanceFor("first-party/trackdub/docs/reference/x.md", sync, fresh)).toEqual({
      repo: "trackdub",
      localPath: "docs/reference/x.md",
      syncedCommit: "f2bf40a429eb",
      syncedAt: "2026-11-11T02:00:00+00:00",
    });
  });

  it("flags a corpus synced from a dirty tree", () => {
    expect(provenanceFor("first-party/api/docs/y.md", sync, fresh)).toMatchObject({
      syncedCommit: "c5a5f9458717",
      syncedDirty: true,
    });
  });

  it("reports the generated pin doc as generated, with no checkout path", () => {
    expect(provenanceFor("first-party/trackdub/docs/reference/docs-rag-pin.md", sync, fresh)).toEqual({
      repo: "trackdub",
      generated: true,
      source: "runtime/trt-rtx-ep.manifest.json",
      syncedAt: sync.syncedAt,
    });
  });

  it("treats a non-array files value as no membership instead of throwing", () => {
    const malformed = { ...sync, files: {} as unknown as string[] };
    expect(() => provenanceFor("first-party/trackdub/docs/a.md", malformed, fresh)).not.toThrow();
    expect(provenanceFor("first-party/trackdub/docs/a.md", malformed, fresh)).not.toHaveProperty("syncedCommit");
  });

  it("gives no membership to a string files value", () => {
    const malformed = { ...sync, files: "first-party/trackdub/docs/a.md" as unknown as string[] };
    expect(provenanceFor("first-party/trackdub/docs/a.md", malformed, fresh)).not.toHaveProperty("syncedCommit");
  });

  it("gives no commit to a fresh key when the manifest has no files array", () => {
    const noFiles: SyncManifest = { syncedAt: sync.syncedAt, repos: sync.repos };
    expect(provenanceFor("first-party/trackdub/docs/a.md", noFiles, fresh)).not.toHaveProperty("syncedCommit");
  });

  it("omits the commit for a retained object that is not in the manifest file list", () => {
    expect(provenanceFor("first-party/trackdub/docs/deleted.md", sync, fresh)).not.toHaveProperty("syncedCommit");
  });

  it("omits the commit and dirty flag for items indexed before their object was uploaded", () => {
    expect(provenanceFor("first-party/trackdub/docs/a.md", sync, stale)).toEqual({
      repo: "trackdub",
      localPath: "docs/a.md",
      syncedAt: "2026-11-11T02:00:00+00:00",
    });
  });

  it("omits the commit when the index timestamp or the upload time is unknown", () => {
    expect(provenanceFor("first-party/trackdub/docs/a.md", sync)).not.toHaveProperty("syncedCommit");
    expect(provenanceFor("first-party/trackdub/docs/a.md", sync, { indexedAt: FRESH_SECONDS })).not.toHaveProperty("syncedCommit");
  });

  it("accepts millisecond index timestamps as well as seconds", () => {
    expect(provenanceFor("first-party/trackdub/docs/a.md", sync, { ...fresh, indexedAt: FRESH_SECONDS * 1000 })).toHaveProperty("syncedCommit");
    expect(provenanceFor("first-party/trackdub/docs/a.md", sync, { ...stale, indexedAt: STALE_SECONDS * 1000 })).not.toHaveProperty("syncedCommit");
  });

  it("still names repo and path when no sync manifest exists", () => {
    expect(provenanceFor("first-party/trackdub-gated/docs/z.md", null, fresh)).toEqual({
      repo: "trackdub-gated",
      localPath: "docs/z.md",
    });
  });

  it("adds nothing to vendor or missing keys", () => {
    expect(provenanceFor("vendor/nvidia/ep-abi-v050.md", sync, fresh)).toEqual({});
    expect(provenanceFor(null, sync, fresh)).toEqual({});
  });

  it("keeps the dirty flag when the commit is unavailable", () => {
    const manifest: SyncManifest = { ...sync, repos: { api: { commit: null, dirty: true } } };
    expect(provenanceFor("first-party/api/docs/y.md", manifest, fresh)).toEqual({
      repo: "api",
      localPath: "docs/y.md",
      syncedAt: sync.syncedAt,
      syncedDirty: true,
    });
  });

  it("drops malformed fields instead of exposing them", () => {
    const malformed = {
      syncedAt: [] as unknown as string,
      repos: { trackdub: { commit: 123 as unknown as string, dirty: "false" as unknown as boolean } },
    };
    expect(provenanceFor("first-party/trackdub/docs/a.md", malformed, fresh)).toEqual({
      repo: "trackdub",
      localPath: "docs/a.md",
    });
  });
});

describe("loadSyncManifest", () => {
  const body = JSON.stringify({ files: FILES, syncedAt: sync.syncedAt, repos: sync.repos });

  it("reads the manifest once within the cache window", async () => {
    const { env, get } = corpusWith(body);
    expect(await loadSyncManifest(env, 1_000)).toMatchObject({ syncedAt: sync.syncedAt });
    await loadSyncManifest(env, 2_000);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(SYNC_KEY);
  });

  it("refetches after the cache window", async () => {
    const { env, get } = corpusWith(body);
    await loadSyncManifest(env, 0);
    await loadSyncManifest(env, 10 * 60_000);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["missing object", null],
    ["invalid JSON", "{not json"],
    ["non-object JSON", "[1,2]"],
  ])("degrades to no stamp for %s", async (_name, text) => {
    const { env } = corpusWith(text);
    expect(await loadSyncManifest(env)).toBeNull();
  });

  it("degrades to no stamp when R2 throws", async () => {
    const env = { CORPUS: { get: vi.fn().mockRejectedValue(new Error("r2 down")) } as unknown as R2Bucket };
    expect(await loadSyncManifest(env)).toBeNull();
  });
});

describe("withProvenance", () => {
  const uploaded = new Date(UPLOADED_MS);
  const manifestBody = JSON.stringify({ files: FILES, syncedAt: sync.syncedAt, repos: sync.repos });

  it("stamps hits whose own object is current, leaves vendor hits alone and hides the sync manifest", async () => {
    const { env, head } = corpusWith(manifestBody, {
      "first-party/trackdub/docs/a.md": uploaded,
      "first-party/trackdub/docs/old.md": uploaded,
    });
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
    expect(head).not.toHaveBeenCalledWith("vendor/olive/olive-why.md");
  });

  it("checks each object once even when several chunks come from it", async () => {
    const { env, head } = corpusWith(manifestBody, { "first-party/trackdub/docs/a.md": uploaded });
    await withProvenance(env, {
      hits: [
        { key: "first-party/trackdub/docs/a.md", text: "1", indexedAt: FRESH_SECONDS },
        { key: "first-party/trackdub/docs/a.md", text: "2", indexedAt: FRESH_SECONDS },
      ],
    });
    expect(head).toHaveBeenCalledTimes(1);
  });

  it("still returns the hit with no commit when R2 head fails", async () => {
    const { env } = corpusWith(manifestBody);
    env.CORPUS.head = vi.fn().mockRejectedValue(new Error("r2 down")) as unknown as R2Bucket["head"];
    const result = await withProvenance(env, {
      hits: [{ key: "first-party/trackdub/docs/a.md", text: "a", indexedAt: FRESH_SECONDS }],
    });
    expect(result.hits[0]).toMatchObject({ repo: "trackdub", localPath: "docs/a.md", syncedAt: sync.syncedAt });
    expect(result.hits[0]).not.toHaveProperty("syncedCommit");
  });

  it("omits the commit when the object is missing from R2", async () => {
    const { env } = corpusWith(manifestBody);
    const result = await withProvenance(env, {
      hits: [{ key: "first-party/trackdub/docs/gone.md", text: "g", indexedAt: FRESH_SECONDS }],
    });
    expect(result.hits[0]).not.toHaveProperty("syncedCommit");
  });
});
