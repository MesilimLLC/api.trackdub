import { PIN_SENTENCE } from "@/docs-rag/pin.generated";
import type { DocsRagFilter } from "@/docs-rag/types";

export const DOC_SCOPES = [
  "all",
  "first-party",
  "trackdub",
  "trackdub-gated",
  "api",
  "vendor",
  "nvidia",
  "microsoft",
  "amd",
  "intel",
  "qualcomm",
  "qwen",
  "whisper",
  "speech-models",
  "onnxruntime",
] as const;

export type DocScope = (typeof DOC_SCOPES)[number];

const FOLDER: Record<Exclude<DocScope, "all">, string> = {
  "first-party": "first-party/",
  trackdub: "first-party/trackdub/",
  "trackdub-gated": "first-party/trackdub-gated/",
  api: "first-party/api/",
  vendor: "vendor/",
  nvidia: "vendor/nvidia/",
  microsoft: "vendor/microsoft/",
  amd: "vendor/amd/",
  intel: "vendor/intel/",
  qualcomm: "vendor/qualcomm/",
  qwen: "vendor/qwen/",
  whisper: "vendor/whisper/",
  "speech-models": "vendor/speech-models/",
  onnxruntime: "vendor/onnxruntime/",
};

export function isDocScope(value: string): value is DocScope {
  return (DOC_SCOPES as readonly string[]).includes(value);
}

/** AI Search treats folder `gte` as a prefix match on the R2 key directory. */
export function filterForScope(scope: DocScope): DocsRagFilter | undefined {
  switch (scope) {
    case "all":
      return undefined;
    case "first-party":
    case "trackdub":
    case "trackdub-gated":
    case "api":
    case "vendor":
    case "nvidia":
    case "microsoft":
    case "amd":
    case "intel":
    case "qualcomm":
    case "qwen":
    case "whisper":
    case "speech-models":
    case "onnxruntime": {
      // `folder` metadata stores the directory WITH a trailing slash
      // (e.g. "vendor/nvidia/"). A `$lt` of `${prefix}0` keeps that slash in
      // the boundary string ("vendor/nvidia/0"), and since "0" (0x30) sorts
      // after "/" (0x2F), the upper bound lands above every real folder value,
      // matching nothing. Strip the trailing slash so the boundary compares
      // against the last real path character: "vendor/nvidia0".
      const prefix = FOLDER[scope];
      return { folder: { $gte: prefix, $lt: `${prefix.slice(0, -1)}0` } };
    }
    default: {
      const _exhaustive: never = scope;
      throw new Error(`unhandled scope ${String(_exhaustive)}`);
    }
  }
}

export const SYSTEM_PROMPT = `You answer Trackdub implementation questions from retrieved documentation only.
Prefer chunks under first-party/ over vendor/. ${PIN_SENTENCE.replace(/\.$/, "")}, as a standalone ONNX Runtime plugin, not the Windows ML catalog EP.
If first-party text and a vendor page disagree, follow first-party and say so.
Vendor /latest/ pages may be newer than the pin. If the context does not contain the answer, say you do not have it. Do not invent APIs, flags, or readiness claims.
Quote version numbers, flags and symbol names verbatim from the context, and name the source key (first-party/... or vendor/...) behind each claim.`;
