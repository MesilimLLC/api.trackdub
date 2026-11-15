import { Hono } from "hono";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { createDb } from "@/db/client";
import { dubJobs } from "@/db/schema";
import { requireAuth } from "@/middleware/auth";
import { validate } from "@/middleware/validate";
import { ApiError } from "@/lib/errors";
import { isDubProcessorReady } from "@/lib/capabilities";
import {
  CANCELLABLE_DUB_STATUSES,
  DUB_JOB_STATUSES,
  contentLengthExceedsUploadLimit,
  isAllowedMediaFileName,
  isDubJobStatus,
  isKnownLanguageCode,
  isOwnedUploadPath,
  isSafeDownloadContentType,
  extensionForDownloadContentType,
  contentTypeForDownloadExtension,
  MAX_UPLOAD_BYTES,
  toDubJobDto,
  uploadObjectKey,
  type DubJobStatus,
} from "@/lib/dubs";
import type { AppEnv } from "@/types/env";

/**
 * Portal cloud dub job API.
 *
 * Routes match portal.trackdub OpenAPI + CreateJobPage / FileDropZone /
 * useJobs expectations. Auth is session-cookie via requireAuth.
 *
 * Honest scaffold: create leaves jobs Queued. No fake Running/Completed and
 * no invented output media — a later pipeline worker owns that.
 */
export const dubs = new Hono<AppEnv>({ strict: false });

dubs.use("*", requireAuth);

const createJobSchema = z
  .object({
    projectName: z.string().trim().min(1).max(128),
    sourceLanguage: z.string().trim().min(2).max(16),
    targetLanguage: z.string().trim().min(2).max(16),
    inputMediaPath: z.string().trim().min(1).max(1024),
  })
  .superRefine((body, ctx) => {
    if (!isKnownLanguageCode(body.sourceLanguage)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceLanguage"],
        message: "Unknown source language code",
      });
    }
    if (!isKnownLanguageCode(body.targetLanguage)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetLanguage"],
        message: "Unknown target language code",
      });
    }
    if (body.sourceLanguage === body.targetLanguage) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetLanguage"],
        message: "Source and target language must differ",
      });
    }
  });

const listQuerySchema = z.object({
  status: z.string().optional(),
});

function requireUser(c: { get: (k: "user") => AppEnv["Variables"]["user"] }) {
  const user = c.get("user");
  if (!user) throw ApiError.unauthorized();
  return user;
}

async function loadOwnedJob(db: ReturnType<typeof createDb>, userId: string, jobId: string) {
  const rows = await db
    .select()
    .from(dubJobs)
    .where(and(eq(dubJobs.id, jobId), eq(dubJobs.userId, userId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw ApiError.notFound("Job not found");
  return row;
}

/**
 * POST /api/dubs/upload — multipart field `file`.
 * Response: `{ filePath }` (portal FileDropZone).
 */
dubs.post("/upload", async (c) => {
  const user = requireUser(c);

  if (!isDubProcessorReady(c.env)) {
    throw ApiError.serviceUnavailable(
      "Cloud dubbing processing is not available; media was not uploaded",
    );
  }

  // Cap at MAX_UPLOAD_BYTES (not + framing slack). Multipart overhead means
  // Content-Length is a slightly stricter early reject than file.size alone.
  if (contentLengthExceedsUploadLimit(c.req.header("content-length"))) {
    throw ApiError.payloadTooLarge("Upload exceeds the 100 MB Worker limit");
  }

  let body: Awaited<ReturnType<typeof c.req.parseBody>>;
  try {
    body = await c.req.parseBody({ all: true });
  } catch {
    throw ApiError.badRequest("Malformed multipart body");
  }
  const file = body["file"];
  if (!(file instanceof File)) {
    throw ApiError.badRequest('Expected multipart field "file"');
  }

  if (!isAllowedMediaFileName(file.name)) {
    throw ApiError.unsupportedMediaType("Unsupported media file type");
  }
  if (file.size <= 0) {
    throw ApiError.badRequest("Empty file");
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw ApiError.payloadTooLarge("Upload exceeds the 100 MB Worker limit");
  }

  const uploadId = crypto.randomUUID();
  const objectKey = uploadObjectKey(user.id, uploadId, file.name);
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw ApiError.payloadTooLarge("Upload exceeds the 100 MB Worker limit");
  }

  await c.env.MEDIA.put(objectKey, bytes, {
    httpMetadata: {
      contentType: file.type || "application/octet-stream",
    },
    customMetadata: {
      userId: user.id,
      originalFileName: file.name,
      uploadedAt: new Date().toISOString(),
    },
  });

  return c.json(
    {
      filePath: objectKey,
      fileName: file.name,
      fileSize: file.size,
    },
    200,
  );
});

/**
 * GET /api/dubs — list jobs for the session user.
 * Optional `?status=` filter (portal JobStatus string).
 */
dubs.get("/", validate("query", listQuerySchema), async (c) => {
  const user = requireUser(c);
  const { status } = c.get("valid_query");
  const db = createDb(c.env.DB);

  let filterStatus: DubJobStatus | undefined;
  if (status && status !== "All") {
    if (!isDubJobStatus(status)) {
      throw ApiError.badRequest(`Invalid status filter. Expected one of: ${DUB_JOB_STATUSES.join(", ")}`);
    }
    filterStatus = status;
  }

  const where =
    filterStatus === undefined
      ? eq(dubJobs.userId, user.id)
      : and(eq(dubJobs.userId, user.id), eq(dubJobs.status, filterStatus));

  const items = await db
    .select()
    .from(dubJobs)
    .where(where)
    .orderBy(desc(dubJobs.createdAt));

  const countRow = await db
    .select({ count: sql<number>`count(*)` })
    .from(dubJobs)
    .where(where);
  const totalCount = Number(countRow[0]?.count ?? items.length);

  return c.json({
    items: items.map(toDubJobDto),
    totalCount,
  });
});

/**
 * POST /api/dubs — create a Queued job from a prior upload path.
 * Portal CreateJobPage posts JSON and navigates to `/jobs/${jobId}`.
 */
dubs.post("/", validate("json", createJobSchema), async (c) => {
  const user = requireUser(c);
  const body = c.get("valid_json");
  const db = createDb(c.env.DB);

  if (!isDubProcessorReady(c.env)) {
    throw ApiError.serviceUnavailable(
      "Cloud dubbing processing is not available; no job was created",
    );
  }

  if (!isOwnedUploadPath(user.id, body.inputMediaPath)) {
    throw ApiError.badRequest("inputMediaPath is not an upload owned by this user");
  }

  const object = await c.env.MEDIA.head(body.inputMediaPath);
  if (!object) {
    throw ApiError.badRequest("inputMediaPath does not exist in media storage");
  }

  const now = new Date();
  const id = crypto.randomUUID();

  await db.insert(dubJobs).values({
    id,
    userId: user.id,
    projectName: body.projectName,
    sourceLanguage: body.sourceLanguage,
    targetLanguage: body.targetLanguage,
    status: "Queued",
    inputMediaPath: body.inputMediaPath,
    outputMediaPath: null,
    progressPercent: 0,
    currentStage: null,
    errorMessage: null,
    durationSeconds: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  });

  const row = await loadOwnedJob(db, user.id, id);
  return c.json(toDubJobDto(row), 201);
});

/**
 * GET /api/dubs/:jobId
 */
dubs.get("/:jobId", async (c) => {
  const user = requireUser(c);
  const jobId = c.req.param("jobId");
  const db = createDb(c.env.DB);
  const row = await loadOwnedJob(db, user.id, jobId);
  return c.json(toDubJobDto(row));
});

/**
 * DELETE /api/dubs/:jobId — cancel Queued or Running.
 * Status check is in the UPDATE WHERE so a concurrent Completer cannot lose
 * the race and get overwritten to Cancelled.
 */
dubs.delete("/:jobId", async (c) => {
  const user = requireUser(c);
  const jobId = c.req.param("jobId");
  const db = createDb(c.env.DB);

  // Ownership 404 before attempting cancel.
  await loadOwnedJob(db, user.id, jobId);

  const now = new Date();
  const cancelled = await db
    .update(dubJobs)
    .set({
      status: "Cancelled",
      updatedAt: now,
      completedAt: now,
      currentStage: null,
    })
    .where(
      and(
        eq(dubJobs.id, jobId),
        eq(dubJobs.userId, user.id),
        inArray(dubJobs.status, [...CANCELLABLE_DUB_STATUSES]),
      ),
    )
    .returning();

  const updated = cancelled[0];
  if (!updated) {
    const current = await loadOwnedJob(db, user.id, jobId);
    throw ApiError.badRequest(`Cannot cancel a job in status ${current.status}`);
  }

  return c.json(toDubJobDto(updated));
});

/**
 * GET /api/dubs/:jobId/download — stream completed output from R2.
 * Portal treats 404 as missing output and 409 as not completed.
 */
dubs.get("/:jobId/download", async (c) => {
  const user = requireUser(c);
  const jobId = c.req.param("jobId");
  const db = createDb(c.env.DB);
  const row = await loadOwnedJob(db, user.id, jobId);

  if (row.status !== "Completed") {
    throw ApiError.conflict("Job not completed");
  }
  if (!row.outputMediaPath) {
    throw ApiError.notFound("Download not available");
  }

  const object = await c.env.MEDIA.get(row.outputMediaPath);
  if (!object) {
    throw ApiError.notFound("Download not available");
  }

  const storedType = object.httpMetadata?.contentType ?? null;
  if (!isSafeDownloadContentType(storedType)) {
    throw ApiError.unsupportedMediaType("Download content type is not a safe media type");
  }

  // Never trust stored metadata for browser sniffing: force a safe type,
  // attachment disposition, and nosniff so a hostile object cannot XSS.
  // Derive filename extension from the validated type (or object key for
  // octet-stream) so WebM/MOV/etc. are not always named .mp4.
  const rawBase = storedType!.split(";")[0]!.trim().toLowerCase();
  const ext = extensionForDownloadContentType(rawBase, row.outputMediaPath);
  const responseType =
    rawBase === "application/octet-stream"
      ? contentTypeForDownloadExtension(ext)
      : rawBase;

  const headers = new Headers();
  headers.set("content-type", responseType);
  headers.set("x-content-type-options", "nosniff");
  headers.set("etag", object.httpEtag);
  const safeName = row.projectName.replace(/[^\w.\- ]+/g, "_").slice(0, 80) || "output";
  headers.set("content-disposition", `attachment; filename="${safeName}.${ext}"`);

  return new Response(object.body, { status: 200, headers });
});
