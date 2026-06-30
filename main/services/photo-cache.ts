// Fetches PCO photo URLs and caches them to disk under userData/cache/photos/.
// Returns the local file path so the stage-photo:// protocol can serve it.

import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";

import { getUserDataPath } from "./app-paths.js";
import { pruneCacheDir } from "./cache-prune.js";

// Photos are small; keep ~90 days of them, capped at 250 MB.
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_BYTES = 250 * 1024 * 1024;

let cacheDir: string | null = null;

async function getCacheDir(): Promise<string> {
  if (!cacheDir) {
    const userDataPath = getUserDataPath();
    cacheDir = path.join(userDataPath, "cache", "photos");
    await fs.mkdir(cacheDir, { recursive: true });
  }
  return cacheDir;
}

function urlToFilename(url: string): string {
  const hash = crypto.createHash("sha256").update(url).digest("hex");
  // Try to preserve the extension from the URL for MIME type inference.
  const match = url.match(/\.(\w{2,5})(?:\?|$)/);
  const ext = match ? `.${match[1]}` : ".jpg";
  return `${hash}${ext}`;
}

export async function getPhotoPath(photoUrl: string): Promise<string | null> {
  try {
    const dir = await getCacheDir();
    const filename = urlToFilename(photoUrl);
    const filePath = path.join(dir, filename);

    // Return cached version if it exists.
    try {
      await fs.access(filePath);
      return filePath;
    } catch {
      // Not cached yet — fetch.
    }

    // Fetch with a timeout + one retry: PCO photo URLs occasionally blip, and a
    // hung connection would otherwise stall the slot. Failures aren't cached, so
    // the next request (or the client's retry) re-attempts.
    const buffer = await fetchPhoto(photoUrl);
    if (!buffer) return null;
    await fs.writeFile(filePath, buffer);
    return filePath;
  } catch (err) {
    console.error("[photo-cache] Error caching photo:", err);
    return null;
  }
}

/** Evict stale/oversized cached photos. Safe — pruned photos re-fetch on demand. */
export async function prunePhotoCache(): Promise<void> {
  const dir = await getCacheDir();
  const r = await pruneCacheDir(dir, { maxAgeMs: MAX_AGE_MS, maxBytes: MAX_BYTES });
  if (r.removed > 0) {
    console.log(`[photo-cache] pruned ${r.removed} file(s), freed ${(r.freedBytes / 1e6).toFixed(1)} MB`);
  }
}

async function fetchPhoto(photoUrl: string): Promise<Buffer | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(photoUrl, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) {
        console.error(`[photo-cache] Failed to fetch ${photoUrl}: ${response.status}`);
        if (response.status >= 400 && response.status < 500) return null; // don't retry client errors
        continue;
      }
      return Buffer.from(await response.arrayBuffer());
    } catch (err) {
      console.error(`[photo-cache] fetch attempt ${attempt + 1} failed for ${photoUrl}:`, err instanceof Error ? err.message : err);
    }
  }
  return null;
}
