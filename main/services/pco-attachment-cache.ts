// Caches PCO plan attachments to disk under userData/cache/attachments/, keyed by
// the attachment id (immutable per upload). PCO only hands out short-lived S3
// links, so we download once on first request and reuse the file for every kiosk
// display — and for every week the same plan is loaded.

import * as fs from "fs/promises";
import * as path from "path";

import { getUserDataPath } from "./app-paths.js";
import { pruneCacheDir } from "./cache-prune.js";

// Attachments (PDFs/images) are larger but rarely change; keep ~90 days, 500 MB.
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_BYTES = 500 * 1024 * 1024;

let cacheDir: string | null = null;

async function getCacheDir(): Promise<string> {
  if (!cacheDir) {
    cacheDir = path.join(getUserDataPath(), "cache", "attachments");
    await fs.mkdir(cacheDir, { recursive: true });
  }
  return cacheDir;
}

/** Best-effort file extension from the MIME type, falling back to the filename. */
function extFor(contentType: string | null, filename: string): string {
  const ct = (contentType ?? "").toLowerCase();
  if (ct.includes("pdf")) return "pdf";
  if (ct.includes("png")) return "png";
  if (ct.includes("jpeg") || ct.includes("jpg")) return "jpg";
  if (ct.includes("gif")) return "gif";
  if (ct.includes("webp")) return "webp";
  const m = filename.match(/\.(\w{2,5})$/);
  return m ? m[1].toLowerCase() : "bin";
}

/** Evict stale/oversized cached attachments. Safe — pruned files re-download on demand. */
export async function pruneAttachmentCache(): Promise<void> {
  const dir = await getCacheDir();
  const r = await pruneCacheDir(dir, { maxAgeMs: MAX_AGE_MS, maxBytes: MAX_BYTES });
  if (r.removed > 0) {
    console.log(`[attachment-cache] pruned ${r.removed} file(s), freed ${(r.freedBytes / 1e6).toFixed(1)} MB`);
  }
}

/** MIME type to serve a cached attachment with, from its extension. */
export function mimeForExt(ext: string): string {
  switch (ext) {
    case "pdf": return "application/pdf";
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    default: return "application/octet-stream";
  }
}

/**
 * Return the cached file path + extension for an attachment, downloading it from
 * a freshly-opened PCO link on first request. `openUrl` is a thunk so we only pay
 * the `open` round-trip on a cache miss. Returns null on download failure.
 */
export async function getAttachmentFile(
  id: string,
  contentType: string | null,
  filename: string,
  openUrl: () => Promise<string>,
): Promise<{ path: string; ext: string } | null> {
  try {
    const dir = await getCacheDir();
    const ext = extFor(contentType, filename);
    const safe = id.replace(/[^a-zA-Z0-9_-]/g, "");
    const filePath = path.join(dir, `${safe}.${ext}`);

    try {
      await fs.access(filePath);
      return { path: filePath, ext };
    } catch {
      // Not cached yet — open + download.
    }

    const url = await openUrl();
    const resp = await fetch(url);
    if (!resp.ok) {
      console.error(`[attachment-cache] fetch ${id} → HTTP ${resp.status}`);
      return null;
    }
    await fs.writeFile(filePath, Buffer.from(await resp.arrayBuffer()));
    return { path: filePath, ext };
  } catch (err) {
    console.error("[attachment-cache] error:", err);
    return null;
  }
}
