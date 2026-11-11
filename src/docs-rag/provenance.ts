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

/** AI Search timestamps are seconds for some indexes and milliseconds for others. */
function toMillis(indexedAt: number): number {
  return indexedAt < 1e12 ? indexedAt * 1000 : indexedAt;
}

/**
 * The index reflects a document's current bytes only if it was indexed at or after that object's own
 * R2 upload. An unchanged object keeps its old upload time, and its bytes still match the synced commit.
 */
function indexedCurrent(indexedAt: number | undefined, uploadedAt: number | undefined): boolean {
  return indexedAt !== undefined && uploadedAt !== undefined && toMillis(indexedAt) >= uploadedAt;
}

function commitFields(state: { commit?: unknown; dirty?: unknown } | undefined) {
  return {
    ...(typeof state?.commit === "string" && state.commit !== "" ? { syncedCommit: state.commit } : {}),
    ...(state?.dirty === true ? { syncedDirty: true } : {}),
  };
}

function syncedAtField(sync: SyncManifest | null) {
  return typeof sync?.syncedAt === "string" && sync.syncedAt !== "" ? { syncedAt: sync.syncedAt } : {};
}

/** `first-party/<repo>/<path>` maps to its repo and checkout path; any other key yields null. */
function parseFirstPartyKey(key: string | null): { repo: string; localPath: string } | null {
  const match = key?.match(/^first-party\/([^/]+)\/(.+)$/);
  return match?.[1] && match[2] ? { repo: match[1], localPath: match[2] } : null;
}

export function provenanceFor(
  key: string | null,
  sync: SyncManifest | null,
  freshness: { indexedAt?: number; uploadedAt?: number } = {},
) {
  const location = parseFirstPartyKey(key);
  if (!location) return {};
  const current = indexedCurrent(freshness.indexedAt, freshness.uploadedAt);
  const commit = current ? commitFields(sync?.repos?.[location.repo]) : {};
  return { ...location, ...commit, ...syncedAtField(sync) };
}

async function objectUploadedAt(env: Pick<DocsRagBindings, "CORPUS">, key: string): Promise<number | undefined> {
  try {
    const head = await env.CORPUS.head(key);
    return head?.uploaded instanceof Date ? head.uploaded.getTime() : undefined;
  } catch {
    return undefined;
  }
}

export async function withProvenance<T extends { hits: Array<{ key: string | null; indexedAt?: number }> }>(
  env: Pick<DocsRagBindings, "CORPUS">,
  result: T,
) {
  const sync = await loadSyncManifest(env);
  const visible = result.hits.filter((hit) => hit.key !== SYNC_KEY);
  const uploads = new Map<string, Promise<number | undefined>>();
  const uploadedAt = (key: string) => {
    if (!uploads.has(key)) uploads.set(key, objectUploadedAt(env, key));
    return uploads.get(key) ?? Promise.resolve(undefined);
  };
  const hits = await Promise.all(
    visible.map(async ({ indexedAt, ...hit }) => {
      const current = hit.key && parseFirstPartyKey(hit.key) ? await uploadedAt(hit.key) : undefined;
      return { ...hit, ...provenanceFor(hit.key, sync, { indexedAt, uploadedAt: current }) };
    }),
  );
  return { ...result, hits };
}
