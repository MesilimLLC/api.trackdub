import type { DocsRagBindings } from "@/docs-rag/types";

/** Written by Trackdub's tools/docs-rag/sync_corpus.py: which commit of each repo the corpus came from. */
export const SYNC_KEY = "first-party/_sync.json";
const CACHE_TTL_MS = 5 * 60_000;

export interface SyncManifest {
  syncedAt?: string;
  repos?: Record<string, { commit?: string | null; dirty?: boolean | null }>;
  /** R2 upload time of the manifest (ms). Index items stamped at or after it were indexed from this sync or later. */
  uploadedAt?: number;
}

let cache: { at: number; value: SyncManifest | null } | null = null;

export function resetSyncManifestCache(): void {
  cache = null;
}

function isSyncManifest(value: unknown): value is SyncManifest {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Missing or unreadable manifests degrade to "no stamp", never to a failed search. */
export async function loadSyncManifest(env: Pick<DocsRagBindings, "CORPUS">, now = Date.now()): Promise<SyncManifest | null> {
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.value;
  let value: SyncManifest | null = null;
  try {
    const object = await env.CORPUS.get(SYNC_KEY);
    if (object) {
      const parsed: unknown = JSON.parse(await object.text());
      const uploadedAt = object.uploaded instanceof Date ? object.uploaded.getTime() : undefined;
      value = isSyncManifest(parsed) ? { ...parsed, uploadedAt } : null;
    }
  } catch {
    value = null;
  }
  cache = { at: now, value };
  return value;
}

/** `first-party/<repo>/<path>` keys map back to a path in the sibling checkout; vendor keys carry nothing extra. */
/** AI Search timestamps are seconds for some indexes and milliseconds for others; treat anything before 2001 in ms as seconds. */
function toMillis(indexedAt: number): number {
  return indexedAt < 1e12 ? indexedAt * 1000 : indexedAt;
}

/** True only when the item was indexed at or after this sync's upload, so its content is at least that sync's. */
function indexedFromSync(sync: SyncManifest | null, indexedAt: number | undefined): boolean {
  return sync?.uploadedAt !== undefined && indexedAt !== undefined && toMillis(indexedAt) >= sync.uploadedAt;
}

function commitStamp(state: { commit?: unknown; dirty?: unknown } | undefined) {
  const commit = typeof state?.commit === "string" && state.commit !== "" ? state.commit : undefined;
  return {
    ...(commit ? { syncedCommit: commit } : {}),
    ...(state?.dirty === true ? { syncedDirty: true } : {}),
  };
}

function syncedAtStamp(sync: SyncManifest | null) {
  return typeof sync?.syncedAt === "string" && sync.syncedAt !== "" ? { syncedAt: sync.syncedAt } : {};
}

/** `first-party/<repo>/<path>` keys map back to a path in the sibling checkout; vendor keys carry nothing extra. */
export function provenanceFor(key: string | null, sync: SyncManifest | null, indexedAt?: number) {
  const match = key?.match(/^first-party\/([^/]+)\/(.+)$/);
  const repo = match?.[1];
  const localPath = match?.[2];
  if (!repo || !localPath) return {};
  const current = indexedFromSync(sync, indexedAt);
  return {
    repo,
    localPath,
    ...(current ? commitStamp(sync?.repos?.[repo]) : {}),
    ...syncedAtStamp(sync),
  };
}

export async function withProvenance<T extends { hits: Array<{ key: string | null; indexedAt?: number }> }>(
  env: Pick<DocsRagBindings, "CORPUS">,
  result: T,
) {
  const sync = await loadSyncManifest(env);
  return {
    ...result,
    hits: result.hits
      .filter((hit) => hit.key !== SYNC_KEY)
      .map(({ indexedAt, ...hit }) => ({ ...hit, ...provenanceFor(hit.key, sync, indexedAt) })),
  };
}
