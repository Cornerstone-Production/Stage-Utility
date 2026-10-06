// Fetches PCO photo URLs and caches them to disk under userData/cache/photos/.
// Returns the local file path so the stage-photo:// protocol can serve it.

import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";

import { getUserDataPath } from "./app-paths.js";
import { downscaleAvatarUrl } from "./avatar-geometry.js";
import { pruneCacheDir } from "./cache-prune.js";
import { scrub, scrubError } from "./scrub.js";

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

/** Where `photoUrl` is on disk, or null when it has not been fetched yet. */
async function cachedPhotoPath(photoUrl: string): Promise<string | null> {
  const filePath = path.join(await getCacheDir(), urlToFilename(photoUrl));
  try {
    await fs.access(filePath);
    return filePath;
  } catch {
    return null;
  }
}

/**
 * Fetches in flight, by upstream URL. Thirteen slots across a Screens page ask
 * for the same few photos at once; without this each one fetched and wrote the
 * same file, and a reader could open it half-written.
 */
const inflight = new Map<string, Promise<string | null>>();

export function getPhotoPath(photoUrl: string): Promise<string | null> {
  const running = inflight.get(photoUrl);
  if (running) return running;
  const p = loadPhoto(photoUrl).finally(() => inflight.delete(photoUrl));
  inflight.set(photoUrl, p);
  return p;
}

async function loadPhoto(photoUrl: string): Promise<string | null> {
  if (!isAllowedPhotoUrl(photoUrl)) {
    console.warn(`[photo-cache] refused to fetch a photo from outside PCO: ${scrub(photoUrl)}`);
    return null;
  }
  try {
    const cached = await cachedPhotoPath(photoUrl);
    if (cached) return cached;

    // Fetch with a timeout + one retry: PCO photo URLs occasionally blip, and a
    // hung connection would otherwise stall the slot. Failures aren't cached, so
    // the next request (or the client's retry) re-attempts.
    const buffer = await fetchPhoto(photoUrl);
    if (!buffer) return null;
    // Written aside and renamed into place, so the file is either absent or
    // whole: it is served immutable, and a torn one would be kept for a year.
    const filePath = path.join(await getCacheDir(), urlToFilename(photoUrl));
    const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    try {
      await fs.writeFile(tmp, buffer);
      await fs.rename(tmp, filePath);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
    return filePath;
  } catch (err) {
    console.error("[photo-cache] Error caching photo:", scrubError(err));
    return null;
  }
}

/** A cached photo, and whether it is the size that was asked for. */
export interface SizedPhoto {
  path: string;
  /**
   * True when the smaller copy could not be had and this is the photo at the
   * geometry it was given instead. The caller must not cache that as the sized
   * answer: it is the right image at the wrong size, and would stay wrong for a
   * year under an immutable header.
   */
  fellBack: boolean;
}

/** How long a smaller copy PCO failed to give is not asked for again. */
const SIZED_RETRY_MS = 5 * 60 * 1000;
/**
 * How long a request waits on PCO for the small copy when the original is
 * already on disk to stand in. Long enough for a healthy fetch (a few hundred
 * ms), so the small copy is what gets served; short enough that an unreachable
 * PCO costs a display this rather than fetchPhoto's 16 s of timeouts.
 */
const SIZED_WAIT_MS = 1500;

/** `p`, or null if it has not settled within `ms`. `p` carries on regardless. */
function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
/** Failed sized URLs remembered at once. The URL comes from the request, so the
 *  memory is bounded rather than trusting callers to send few distinct ones. */
const MAX_FAILED_SIZED = 500;
/** Sized URL -> when PCO last failed it. */
const failedSized = new Map<string, number>();

function sizedRecentlyFailed(sizedUrl: string): boolean {
  const at = failedSized.get(sizedUrl);
  if (at === undefined) return false;
  if (Date.now() - at < SIZED_RETRY_MS) return true;
  failedSized.delete(sizedUrl);
  return false;
}

/** Remember a failed sized URL. True when this is news: nothing live recorded it. */
function recordSizedFailure(sizedUrl: string): boolean {
  const news = !sizedRecentlyFailed(sizedUrl);
  failedSized.delete(sizedUrl);
  failedSized.set(sizedUrl, Date.now());
  if (failedSized.size > MAX_FAILED_SIZED) {
    const oldest = failedSized.keys().next().value;
    if (oldest !== undefined) failedSized.delete(oldest);
  }
  return news;
}

/**
 * Fetch the smaller copy, remembering it if PCO will not give it.
 *
 * Every request waiting on the same copy shares one fetch, and each of them
 * lands here when it fails. Only the first records it as news, so one failure is
 * one line. The line says what happens next rather than what was served: this
 * request may yet be answered by the original, or by nothing, and a failure of
 * the original is its own line.
 */
async function fetchSized(photoUrl: string, sizedUrl: string, size: number): Promise<string | null> {
  const got = await getPhotoPath(sizedUrl);
  if (!got && recordSizedFailure(sizedUrl)) {
    console.warn(
      `[photo-cache] PCO did not give a ${scrub(size)}px copy of ${scrub(photoUrl)}; serving it at its own geometry where it can be, retrying in ${scrub(SIZED_RETRY_MS / 60000)} min`,
    );
  }
  return got;
}

/** The first of `ps` to resolve to something, or null once all have resolved null. */
function firstFound<T>(ps: Promise<T | null>[]): Promise<T | null> {
  return new Promise((resolve) => {
    let pending = ps.length;
    for (const p of ps) {
      void p.then((v) => {
        if (v !== null) resolve(v);
        else if (--pending === 0) resolve(null);
      });
    }
  });
}

/**
 * The photo at `photoUrl`, at most `size` device pixels on its longest side.
 *
 * `size` null means the geometry the URL already carries — the server's choice,
 * and what every request got before displays said how big they draw.
 *
 * The smaller copy comes from PCO's own resizer (see avatar-geometry.ts), not
 * from resizing here: no image library, and PCO's CDN caches every variant. Its
 * disk entry is keyed by the sized upstream URL, and the size is IN that URL's
 * geometry — so a full-size photo already on disk from before sizes existed has
 * a different key and is never handed out as the small one.
 *
 * PCO gets SIZED_WAIT_MS to deliver the small copy. If it has not, the photo at
 * its own geometry stands in (`fellBack`), so a slot shows the right face rather
 * than a broken image: from disk at once if it is there, otherwise fetched
 * alongside the small copy, whichever arrives first. Without the cap an
 * unreachable PCO held every load for 16 s, for a face that was on disk all
 * along, and 32 s for one that was not. The small copy's fetch carries on, so
 * the next load gets it.
 *
 * A small copy PCO failed is not asked for again for SIZED_RETRY_MS, so an outage
 * costs one fetch and one line per photo, not one per load. Null only when
 * neither the small copy nor the original can be had.
 */
export async function getSizedPhotoPath(photoUrl: string, size: number | null): Promise<SizedPhoto | null> {
  const sizedUrl = size === null || !isAllowedPhotoUrl(photoUrl) ? photoUrl : downscaleAvatarUrl(photoUrl, size);
  if (size === null || sizedUrl === photoUrl) {
    const hit = await getPhotoPath(photoUrl);
    return hit ? { path: hit, fellBack: false } : null;
  }

  const sizedHit = await cachedPhotoPath(sizedUrl);
  if (sizedHit) return { path: sizedHit, fellBack: false };

  // Neither of these rejects: getPhotoPath logs its own failure and returns null.
  const fetching = sizedRecentlyFailed(sizedUrl) ? null : fetchSized(photoUrl, sizedUrl, size);
  if (fetching) {
    const quick = await within(fetching, SIZED_WAIT_MS);
    if (quick) return { path: quick, fellBack: false };
  }
  const original = getPhotoPath(photoUrl).then((p) => (p ? { path: p, fellBack: true } : null));
  const sized = fetching?.then((p) => (p ? { path: p, fellBack: false } : null));
  return firstFound(sized ? [sized, original] : [original]);
}

/** Tests only: forget which small copies PCO has failed. */
export function __resetSizedFailuresForTests(): void {
  failedSized.clear();
}

/** Tests only: wait for every photo fetch in flight, including background ones. */
export async function __settlePhotoFetchesForTests(): Promise<void> {
  while (inflight.size > 0) await Promise.all(inflight.values());
}

/** Evict stale/oversized cached photos. Safe — pruned photos re-fetch on demand. */
export async function prunePhotoCache(): Promise<void> {
  const dir = await getCacheDir();
  const r = await pruneCacheDir(dir, { maxAgeMs: MAX_AGE_MS, maxBytes: MAX_BYTES });
  if (r.removed > 0) {
    console.log(`[photo-cache] pruned ${scrub(r.removed)} file(s), freed ${scrub((r.freedBytes / 1e6).toFixed(1))} MB`);
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
          `[photo-cache] refused a redirect from ${scrub(photoUrl)} to ${scrub(response.headers.get("location") ?? "?")}`,
        );
        return null;
      }
      if (!response.ok) {
        console.error(`[photo-cache] Failed to fetch ${scrub(photoUrl)}: ${scrub(response.status)}`);
        if (response.status >= 400 && response.status < 500) return null; // don't retry client errors
        continue;
      }
      // What is cached is served immutable for a year, so a 200 that is a web page
      // (a captive portal, a proxy's error page) must not be kept as the photo.
      // A denylist, not "must be image/*": a CDN that serves avatars as
      // binary/octet-stream is still serving avatars.
      const contentType = response.headers.get("content-type") ?? "";
      if (/^(text\/|application\/(json|xml))/i.test(contentType)) {
        console.error(`[photo-cache] refused a ${scrub(contentType)} body from ${scrub(photoUrl)}: not an image`);
        return null;
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
        console.error(`[photo-cache] refused ${scrub(declared)} declared bytes from ${scrub(photoUrl)} (over cap)`);
        return null;
      }
      const buf = await readCapped(response, MAX_PHOTO_BYTES);
      if (!buf) {
        console.error(`[photo-cache] refused an over-cap body from ${scrub(photoUrl)}`);
        return null;
      }
      return buf;
    } catch (err) {
      // The URL is a caller's string (/photos?u=), so it goes through scrub() like
      // every other value here. One template, no trailing arguments: a `%s` in the
      // URL then has nothing to eat.
      console.error(`[photo-cache] fetch attempt ${scrub(attempt + 1)} failed for ${scrub(photoUrl)}: ${scrub(err)}`);
    }
  }
  return null;
}
