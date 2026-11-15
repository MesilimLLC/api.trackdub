import { LANGUAGES } from "@/lib/languages";

/** Portal `JobStatus` string values. Keep in sync with portal.trackdub useJobs. */
export const DUB_JOB_STATUSES = [
  "Queued",
  "Running",
  "Completed",
  "Failed",
  "Cancelled",
] as const;

export type DubJobStatus = (typeof DUB_JOB_STATUSES)[number];

export const TERMINAL_DUB_STATUSES: readonly DubJobStatus[] = [
  "Completed",
  "Failed",
  "Cancelled",
];

export const CANCELLABLE_DUB_STATUSES: readonly DubJobStatus[] = ["Queued", "Running"];

/** Match portal FileDropZone allowed extensions. */
export const ALLOWED_MEDIA_EXTENSIONS = new Set([
  ".mp4",
  ".mkv",
  ".mov",
  ".avi",
  ".webm",
  ".mp3",
  ".wav",
  ".flac",
  ".ogg",
]);

/**
 * Content types we will serve from `/api/dubs/:id/download`.
 * Anything else is rejected rather than streamed with a misleading filename.
 */
export const ALLOWED_DOWNLOAD_CONTENT_TYPES = new Set([
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-matroska",
  "video/x-msvideo",
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/flac",
  "audio/ogg",
  "application/octet-stream",
]);

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
  "video/x-msvideo": "avi",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/flac": "flac",
  "audio/ogg": "ogg",
};

const ALLOWED_OUTPUT_EXTENSIONS = new Set(Object.values(EXTENSION_BY_CONTENT_TYPE));

/**
 * Worker request-body limit for direct multipart upload. Portal UI advertises
 * 5 GB; true multi-GB needs R2 multipart / direct-to-R2 later. Scaffold is
 * honest about the Worker bound.
 */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

const LANGUAGE_CODES = new Set(LANGUAGES.map((l) => l.code));

export function isKnownLanguageCode(code: string): boolean {
  return LANGUAGE_CODES.has(code);
}

export function isDubJobStatus(value: string): value is DubJobStatus {
  return (DUB_JOB_STATUSES as readonly string[]).includes(value);
}

export function mediaExtension(fileName: string): string {
  const idx = fileName.lastIndexOf(".");
  if (idx < 0) return "";
  return fileName.slice(idx).toLowerCase();
}

export function isAllowedMediaFileName(fileName: string): boolean {
  return ALLOWED_MEDIA_EXTENSIONS.has(mediaExtension(fileName));
}

/** Strip path separators and control chars from an uploaded file name. */
export function sanitizeFileName(fileName: string): string {
  const base = fileName.replace(/[/\\]/g, "_").replace(/[^\w.\- ()[\]]+/g, "_").trim();
  if (!base || base === "." || base === "..") return "upload.bin";
  return base.slice(0, 200);
}

export function uploadObjectKey(userId: string, uploadId: string, fileName: string): string {
  return `uploads/${userId}/${uploadId}/${sanitizeFileName(fileName)}`;
}

/**
 * Decode percent-encoding repeatedly so `%2e%2e` / double-encoding cannot hide
 * `..` segments. Malformed encoding fails closed.
 */
function decodeObjectKeyFully(objectKey: string): string | null {
  let current = objectKey;
  for (let i = 0; i < 8; i++) {
    try {
      const next = decodeURIComponent(current.replace(/\+/g, "%20"));
      if (next === current) return current;
      current = next;
    } catch {
      return null;
    }
  }
  // Still changing after many passes → treat as hostile.
  return null;
}

function hasUnsafePathSegments(path: string): boolean {
  return path.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

/**
 * True when the R2 key is under this user's upload prefix (path-traversal safe).
 *
 * Upload keys we mint are plain ASCII (`uploads/{userId}/{uuid}/{file}`). Reject
 * percent-encoding, path segments equal to `.`/`..`, backslashes, and any key
 * that does not keep that shape after full URI decode / slash normalization.
 * Filenames may contain `..` as a substring (e.g. `take..01.wav`); only whole
 * segments equal to `..` are treated as traversal.
 */
export function isOwnedUploadPath(userId: string, objectKey: string): boolean {
  if (!userId || !objectKey) return false;
  if (objectKey.includes("\0") || objectKey.includes("\\")) return false;
  // Our minted keys never use percent-encoding; encoded forms are hostile.
  if (objectKey.includes("%") || objectKey.includes("+")) return false;
  if (objectKey.startsWith("/") || hasUnsafePathSegments(objectKey)) return false;

  const decoded = decodeObjectKeyFully(objectKey);
  if (decoded === null) return false;

  const normalized = decoded.replace(/\\/g, "/").replace(/\/+/g, "/");
  if (normalized !== objectKey) return false;
  if (normalized.startsWith("/") || normalized.includes("\0")) return false;
  if (hasUnsafePathSegments(normalized)) return false;

  const prefix = `uploads/${userId}/`;
  if (!normalized.startsWith(prefix)) return false;

  // Expected shape: uploads/{userId}/{uploadId}/{fileName}[+ optional deeper]
  const rest = normalized.split("/").slice(2);
  return rest.length >= 2;
}

/** Early reject when Content-Length already exceeds the stated file-byte cap. */
export function contentLengthExceedsUploadLimit(
  contentLengthHeader: string | undefined,
): boolean {
  if (contentLengthHeader === undefined || contentLengthHeader === "") return false;
  const n = Number(contentLengthHeader);
  return Number.isFinite(n) && n > MAX_UPLOAD_BYTES;
}

/** Normalize and allowlist Content-Type for download responses. */
export function isSafeDownloadContentType(contentType: string | undefined | null): boolean {
  if (!contentType) return false;
  const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return ALLOWED_DOWNLOAD_CONTENT_TYPES.has(base);
}

/**
 * Filename extension for a validated download Content-Type.
 * For `application/octet-stream`, prefer a safe extension from `objectKey`
 * when present; otherwise default to `mp4` (scaffold export shape).
 */
export function extensionForDownloadContentType(
  contentType: string,
  objectKey?: string | null,
): string {
  const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (base === "application/octet-stream") {
    if (objectKey) {
      const fromPath = mediaExtension(objectKey).replace(/^\./, "").toLowerCase();
      if (ALLOWED_OUTPUT_EXTENSIONS.has(fromPath)) return fromPath;
    }
    return "mp4";
  }
  return EXTENSION_BY_CONTENT_TYPE[base] ?? "bin";
}

/** Map a validated download extension back to a Content-Type. */
export function contentTypeForDownloadExtension(ext: string): string {
  for (const [type, mapped] of Object.entries(EXTENSION_BY_CONTENT_TYPE)) {
    if (mapped === ext) return type;
  }
  return "video/mp4";
}

export interface DubJobRow {
  id: string;
  projectName: string;
  sourceLanguage: string;
  targetLanguage: string;
  status: string;
  inputMediaPath: string;
  outputMediaPath: string | null;
  progressPercent: number;
  currentStage: string | null;
  errorMessage: string | null;
  durationSeconds: number | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

/** CamelCase DTO matching portal `DubJobApiDto` / CreateJobPage expectations. */
export function toDubJobDto(row: DubJobRow) {
  return {
    id: row.id,
    jobId: row.id,
    projectName: row.projectName,
    sourceLanguage: row.sourceLanguage,
    targetLanguage: row.targetLanguage,
    status: row.status,
    inputMediaPath: row.inputMediaPath,
    outputMediaPath: row.outputMediaPath,
    progressPercent: row.progressPercent,
    currentStage: row.currentStage,
    errorMessage: row.errorMessage,
    durationSeconds: row.durationSeconds,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}
