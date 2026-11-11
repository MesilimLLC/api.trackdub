import type { DocsRagBindings } from "@/docs-rag/types";

/** Written by Trackdub's tools/docs-rag/sync_corpus.py: which commit of each repo the corpus came from. */
export const SYNC_KEY = "first-party/_sync.json";
const CACHE_TTL_MS = 5 * 60_000;

export interface SyncManifest {
  syncedAt?: string;
  repos?: Record<string, { commit?: string | null; dirty?: boolean | null }>;
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
      value = isSyncManifest(parsed) ? parsed : null;
    }
  } catch {
    value = null;
  }
  cache = { at: now, value };
  return value;
}

/** `first-party/<repo>/<path>` keys map back to a path in the sibling checkout; vendor keys carry nothing extra. */
export function provenanceFor(key: string | null, sync: SyncManifest | null) {
  const match = key?.match(/^first-party\/([^/]+)\/(.+)$/);
  const repo = match?.[1];
  const localPath = match?.[2];
  if (!repo || !localPath) return {};
  const state = sync?.repos?.[repo];
  return {
    repo,
    localPath,
    ...(state?.commit ? { syncedCommit: state.commit, ...(state.dirty ? { syncedDirty: true } : {}) } : {}),
    ...(sync?.syncedAt ? { syncedAt: sync.syncedAt } : {}),
  };
}

export async function withProvenance<T extends { hits: Array<{ key: string | null }> }>(
  env: Pick<DocsRagBindings, "CORPUS">,
  result: T,
) {
  const sync = await loadSyncManifest(env);
  return {
    ...result,
    hits: result.hits.filter((hit) => hit.key !== SYNC_KEY).map((hit) => ({ ...hit, ...provenanceFor(hit.key, sync) })),
  };
}
