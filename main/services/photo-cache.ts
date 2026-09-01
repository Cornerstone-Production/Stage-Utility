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
/** A single photo is an avatar, not a payload. Refuse anything absurd. */
const MAX_PHOTO_BYTES = 12 * 1024 * 1024;

/**
 * Hosts this proxy will fetch from.
 *
 * `/photos?u=` is reachable unauthenticated from the LAN and hands the response
 * body straight back, so without this it is an open proxy: `?u=http://192.168.1.1/`
 * or `?u=http://127.0.0.1:9090/metrics` makes the appliance fetch an internal host
 * the caller cannot reach itself, and reads the result. Every photo URL originates
 * from a PCO Person record — production serves them all from
 * avatars.planningcenteronline.com — so the legitimate surface is one domain.
 *
 * If PCO ever moves its avatars to another CDN the symptom is a default avatar
 * plus a named line in /log, not a silent blank: see the rejection log below.
 */
const ALLOWED_HOSTS = ["planningcenteronline.com"];

/** Is this a URL we are willing to fetch on a caller's behalf? */
export function isAllowedPhotoUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  // https only: PCO serves avatars over TLS, and plain http would additionally
  // permit a downgrade to an internal host that happens to answer on port 80.
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  return ALLOWED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

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
  if (!isAllowedPhotoUrl(photoUrl)) {
    console.warn(`[photo-cache] refused to fetch a photo from outside PCO: ${photoUrl}`);
    return null;
  }
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

/**
 * Read a response body, giving up once it exceeds `maxBytes`.
 *
 * Returns null rather than throwing when it is over — the caller treats that the
 * same as any other unusable response. Cancels the stream so the transfer stops
 * rather than running to completion in the background.
 */
export async function readCapped(response: Response, maxBytes: number): Promise<Buffer | null> {
  if (!response.body) {
    const buf = Buffer.from(await response.arrayBuffer());
    return buf.byteLength > maxBytes ? null : buf;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function fetchPhoto(photoUrl: string): Promise<Buffer | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // redirect: "manual" is load-bearing, not a tidy-up. fetch follows redirects
      // by default and only the FIRST url is checked against the allowlist, so a
      // single redirect on any allowed host — including https to plain http —
      // walks straight to an internal address and hands the body back to the
      // caller. That is the exact attack the allowlist exists to stop, and it
      // reduced the guarantee to "PCO has no open redirect anywhere on its
      // domain", which this code cannot assert. Real avatars answer 200 with no
      // Location, so refusing 3xx costs nothing.
      const response = await fetch(photoUrl, {
        signal: AbortSignal.timeout(8000),
        redirect: "manual",
      });
      if (response.status >= 300 && response.status < 400) {
        console.warn(
          `[photo-cache] refused a redirect from ${photoUrl} to ${response.headers.get("location") ?? "?"}`,
        );
        return null;
      }
      if (!response.ok) {
        console.error(`[photo-cache] Failed to fetch ${photoUrl}: ${response.status}`);
        if (response.status >= 400 && response.status < 500) return null; // don't retry client errors
        continue;
      }
      // The 250 MB cache cap is only enforced by a once-daily prune, so without a
      // per-photo ceiling a stream of large responses can fill a Pi's card between
      // runs. An avatar that trips this is not an avatar.
      //
      // The declared length is a fast path, not the guard. A chunked response has
      // no content-length, Number(null) is 0, and the check passed — so the cap
      // only ever applied to responses that declared a size, and everything else
      // was fully materialised in a Pi's heap before the size was even looked at.
      // The body is therefore read incrementally and abandoned the moment it goes
      // over, which is what the guarantee needs to be.
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > MAX_PHOTO_BYTES) {
        console.error(`[photo-cache] refused ${declared} declared bytes from ${photoUrl} (over cap)`);
        return null;
      }
      const buf = await readCapped(response, MAX_PHOTO_BYTES);
      if (!buf) {
        console.error(`[photo-cache] refused an over-cap body from ${photoUrl}`);
        return null;
      }
      return buf;
    } catch (err) {
      // photoUrl comes out of a PCO response, so it stays out of the format
      // string — a `%s` in it would eat the error and report only the attempt.
      console.error(
        "[photo-cache] fetch attempt failed:",
        attempt + 1,
        photoUrl,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return null;
}
