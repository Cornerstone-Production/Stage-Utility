// main/services/video/acquire.ts — getting the pinned MediaMTX binary onto
// disk: downloaded, verified, and extracted, or hand-placed and verified.
//
// The relay directory is runtime data (never backed up):
//   <data>/video-relay/downloads/<asset>      — the verified archive
//   <data>/video-relay/<version>/mediamtx[.exe] — the extracted binary
//
// Nothing here runs the binary; that is a later task's supervisor. This is
// only "is a runnable file on disk, and how did it get there."

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

import { getUserDataPath } from "../app-paths.js";
import { errorMessage } from "../errors.js";
import { ASSETS, MEDIAMTX_DOWNLOAD_BYTES, MEDIAMTX_VERSION, assetFor, downloadUrlFor, type MediaMtxAsset } from "./mediamtx-pin.js";

const execFileAsync = promisify(execFile);

// A pinned archive is ~27 MB. 64 MB is a sanity ceiling against a redirect or
// a compromised host serving something else entirely — checked against bytes
// actually received, never the (spoofable, sometimes absent) declared
// Content-Length, which is a progress hint only.
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;

/** A download is abandoned when no bytes arrive for this long (the connect and
 *  the response headers count too), so a slow but steady link still finishes. */
const DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;
/** The outright ceiling, for a host that trickles just fast enough never to
 *  idle: MAX_DOWNLOAD_BYTES bounds the size, this bounds the time. */
const DOWNLOAD_TOTAL_TIMEOUT_MS = 60 * 60 * 1000;

/** The timer functions the watchdog uses, injectable so a test can see which
 *  timers are live. */
interface WatchdogTimers {
  setTimeout: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimeout: (timer: NodeJS.Timeout) => void;
}

interface DownloadTimeouts {
  idleMs: number;
  totalMs: number;
  /** Replaces the global timer functions; for tests. */
  timers?: WatchdogTimers;
}

const DEFAULT_DOWNLOAD_TIMEOUTS: DownloadTimeouts = { idleMs: DOWNLOAD_IDLE_TIMEOUT_MS, totalMs: DOWNLOAD_TOTAL_TIMEOUT_MS };

/** An abort signal that fires after `idleMs` without a `touch()`, or after
 *  `totalMs` outright, carrying the reason as its Error. `stop()` clears both
 *  timers. Both are unref'd as well, so a `stop()` that was missed can never
 *  hold the process open for the length of the ceiling (an hour). */
function downloadWatchdog({ idleMs, totalMs, timers }: DownloadTimeouts): { signal: AbortSignal; touch: () => void; stop: () => void } {
  const t = timers ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (timer) => clearTimeout(timer) };
  const controller = new AbortController();
  const abort = (why: string): void => controller.abort(new Error(why));
  const totalTimer = t.setTimeout(() => abort(`still going after ${totalMs / 1000} s`), totalMs);
  totalTimer.unref();
  let idleTimer: NodeJS.Timeout | null = null;
  const clearIdle = (): void => {
    if (idleTimer) t.clearTimeout(idleTimer);
    idleTimer = null;
  };
  const touch = (): void => {
    clearIdle();
    idleTimer = t.setTimeout(() => abort(`no data for ${idleMs / 1000} s`), idleMs);
    idleTimer.unref();
  };
  const stop = (): void => {
    t.clearTimeout(totalTimer);
    clearIdle();
  };
  touch();
  return { signal: controller.signal, touch, stop };
}

export function relayDir(): string {
  return path.join(getUserDataPath(), "video-relay");
}

type ExtractFn = (archive: string, destDir: string, member: string) => Promise<void>;

/** `tar -xf` reads gzip and zip alike on bsdtar/Windows 10+, and gzip on GNU
 *  tar — the one archive tool every supported platform ships. */
async function realExtract(archive: string, destDir: string, member: string): Promise<void> {
  await fsp.mkdir(destDir, { recursive: true });
  await execFileAsync("tar", ["-xf", archive, "-C", destDir, member]);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Whether the pinned binary is already extracted on this machine — used for
 *  the "off" status line's own copy (main/types/video.ts's `binaryPresent`):
 *  "never downloaded yet" (show the download-size sentence) needs telling
 *  apart from "downloaded once, just switched off since" (say nothing),
 *  which `relay.state === "off"` alone cannot do. `false` for a platform/arch
 *  with no pinned asset at all — there is nothing to have extracted. */
export async function relayBinaryPresent(): Promise<boolean> {
  const asset = assetFor();
  if (!asset) return false;
  return usableBinary(path.join(relayDir(), MEDIAMTX_VERSION, asset.exe));
}

/** Whether the pinned archive sits in `video-relay/downloads` — placed by
 *  hand, or left by an earlier download — whether or not it is extracted.
 *  Not verified here: ensureBinary checks it against the pin before use. */
export async function relayArchivePresent(): Promise<boolean> {
  const asset = assetFor();
  if (!asset) return false;
  return exists(path.join(relayDir(), "downloads", asset.name));
}

/** A file with bytes in it that this process may run — not merely a name.
 *  An extract interrupted partway leaves the name with no bytes, and a file
 *  can lose its execute bit; neither is a binary to trust. */
async function usableBinary(exePath: string): Promise<boolean> {
  try {
    const st = await fsp.stat(exePath);
    if (!st.isFile() || st.size === 0) return false;
    if (process.platform !== "win32") await fsp.access(exePath, fs.constants.X_OK);
    return true;
  } catch {
    return false; // missing, or not runnable: extracted again
  }
}

async function sha256OfFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

type DownloadResult = { ok: true } | { ok: false; reason: string };

/** Streams the response to `<archive>.part` and refuses past
 *  MAX_DOWNLOAD_BYTES of ACTUAL received bytes — not the declared
 *  Content-Length, which a chunked response may omit entirely. The caller
 *  hashes the file itself, so what is verified is what reached the disk. */
async function downloadToPart(
  url: string,
  partPath: string,
  fetchImpl: typeof fetch,
  onProgress: ((received: number, total: number) => void) | undefined,
  totalHint: number,
  timeouts: DownloadTimeouts,
): Promise<DownloadResult> {
  const watchdog = downloadWatchdog(timeouts);
  try {
    return await streamToPart(url, partPath, fetchImpl, onProgress, totalHint, watchdog);
  } finally {
    watchdog.stop();
  }
}

async function streamToPart(
  url: string,
  partPath: string,
  fetchImpl: typeof fetch,
  onProgress: ((received: number, total: number) => void) | undefined,
  totalHint: number,
  watchdog: { signal: AbortSignal; touch: () => void },
): Promise<DownloadResult> {
  let response: Response;
  try {
    response = await fetchImpl(url, { redirect: "follow", signal: watchdog.signal });
  } catch (err) {
    return { ok: false, reason: `could not reach ${url}: ${errorMessage(err)}` };
  }
  if (!response.ok) return { ok: false, reason: `download of ${url} failed: HTTP ${response.status}` };
  if (!response.body) return { ok: false, reason: `download of ${url} returned no body` };

  const declared = Number(response.headers.get("content-length"));
  const total = Number.isFinite(declared) && declared > 0 ? declared : totalHint;

  const file = await fsp.open(partPath, "w");
  const reader = response.body.getReader();
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_DOWNLOAD_BYTES) {
        // Cancels the stream so the transfer stops rather than running to
        // completion in the background.
        await reader.cancel().catch(() => {});
        return { ok: false, reason: `download of ${url} exceeded ${MAX_DOWNLOAD_BYTES} bytes; refused` };
      }
      await file.write(value);
      watchdog.touch();
      onProgress?.(received, total);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `download of ${url} failed: ${errorMessage(err)}` };
  } finally {
    reader.releaseLock();
    await file.close();
  }
}

export interface EnsureBinaryOptions {
  fetchImpl?: typeof fetch;
  onProgress?: (received: number, total: number) => void;
  /** Fired the moment a real network download is about to start (after the
   *  already-extracted, and hand-placed-archive, checks both come up empty)
   *  — never on a retry that reused a cached binary or a verified hand-placed
   *  archive. The caller (relay-lifecycle.ts) decides whether THIS call is
   *  worth a log line; this module has no notion of "retry" to gate it on
   *  itself, and used to log unconditionally, once per attempt rather than
   *  once per download streak. */
  onDownloadStart?: () => void;
  /** Test seam: a fake pin table so a test can inject its own SHA-256 and
   *  asset name without touching the real pin. Defaults to ASSETS. */
  assets?: typeof ASSETS;
  /** Test seam for the extraction step. Defaults to the real tar-based
   *  extractor; a test replaces it with a spy to prove a failed verification
   *  never reaches extraction. */
  extract?: ExtractFn;
  /** Test seam: small timeouts, so a test need not wait real seconds. */
  downloadTimeouts?: DownloadTimeouts;
}

/**
 * `assetName` says which failure this is, rather than a caller guessing from
 * whether `placeArchiveAt` looks like a bare directory or a full file path:
 * `null` for "no pinned asset exists for this platform/arch at all" (nothing
 * to place by hand, ever); the real asset's file name for every other
 * failure, all of which DO have a specific archive the operator could place
 * by hand.
 *
 * `placeArchiveAt` is ALWAYS the bare downloads DIRECTORY, never a file path
 * — a full path made the renderer's "place X at Y" name the same file
 * twice. `assetName` and `placeArchiveAt` are sent as
 * the two separate fields they are — "place <assetName> in
 * <placeArchiveAt>" — never one path a caller has to split apart.
 */
type EnsureBinaryResult =
  | { ok: true; path: string }
  | { ok: false; reason: string; placeArchiveAt: string; assetName: string | null };

/** Where an extract is staged before it is renamed into place: beside the
 *  version directory, so the rename stays on one filesystem. */
const STAGING_SUFFIX = ".partial";

/**
 * Extracts into a staging directory and renames it into place only once the
 * binary in it is there and runnable, so the version directory is either
 * whole or absent — a crash mid-extract can never leave a partial one under
 * the name the next start trusts.
 */
async function extractAndFinish(
  archivePath: string,
  downloadsDir: string,
  versionDir: string,
  asset: MediaMtxAsset,
  exePath: string,
  extract: ExtractFn,
): Promise<EnsureBinaryResult> {
  const staging = `${versionDir}${STAGING_SUFFIX}`;
  const stagedExe = path.join(staging, asset.exe);
  const failed = async (reason: string): Promise<EnsureBinaryResult> => {
    await fsp.rm(staging, { recursive: true, force: true });
    return { ok: false, reason, placeArchiveAt: downloadsDir, assetName: asset.name };
  };
  await fsp.rm(staging, { recursive: true, force: true });
  try {
    await extract(archivePath, staging, asset.exe);
  } catch (err) {
    return failed(`extracting ${asset.name} failed: ${errorMessage(err)}`);
  }
  if (process.platform !== "win32") {
    try {
      await fsp.chmod(stagedExe, 0o755);
    } catch (err) {
      return failed(`could not make ${stagedExe} executable: ${errorMessage(err)}`);
    }
  }
  if (!(await usableBinary(stagedExe))) return failed(`${asset.name} held no runnable ${asset.exe}`);
  await fsp.rm(versionDir, { recursive: true, force: true });
  await fsp.rename(staging, versionDir);
  return { ok: true, path: exePath };
}

/**
 * Makes sure the pinned MediaMTX binary is on disk, in this order:
 *
 *   1. Already extracted (`<version>/<exe>`, there and runnable) — used
 *      as-is, no fetch, no re-verification. A version directory without a
 *      runnable binary is removed and extracted again.
 *   2. A hand-placed archive in `downloads/` — verified against the pinned
 *      checksum. A match extracts with no fetch; a mismatch is refused and
 *      left in place (it is the operator's file).
 *   3. Otherwise downloaded, verified, and extracted.
 *
 * Every failure returns `{ ok: false, reason, placeArchiveAt }` rather than
 * throwing, whatever step it came from — the caller (the relay's status)
 * turns that straight into what the page shows.
 */
export async function ensureBinary(opts: EnsureBinaryOptions = {}): Promise<EnsureBinaryResult> {
  const assets = opts.assets ?? ASSETS;
  const asset = assetFor(process.platform, process.arch, assets);
  const downloadsDir = path.join(relayDir(), "downloads");

  if (!asset) {
    return {
      ok: false,
      reason: `Video relay is not available for ${process.platform} ${process.arch}.`,
      placeArchiveAt: downloadsDir,
      assetName: null,
    };
  }

  // Every failure is returned, whatever step it came from — the relay's
  // status is built from what this answers, and a throw would bypass it.
  try {
    return await ensureAsset(asset, downloadsDir, opts);
  } catch (err) {
    return {
      ok: false,
      reason: `could not set up MediaMTX ${MEDIAMTX_VERSION}: ${errorMessage(err)}`,
      placeArchiveAt: downloadsDir,
      assetName: asset.name,
    };
  }
}

async function ensureAsset(asset: MediaMtxAsset, downloadsDir: string, opts: EnsureBinaryOptions): Promise<EnsureBinaryResult> {
  const versionDir = path.join(relayDir(), MEDIAMTX_VERSION);
  const exePath = path.join(versionDir, asset.exe);
  const archivePath = path.join(downloadsDir, asset.name);
  const partPath = `${archivePath}.part`;
  const extract = opts.extract ?? realExtract;

  if (await usableBinary(exePath)) return { ok: true, path: exePath };
  // Anything else under the version's name is a partial extract, or a
  // binary that lost its mode: removed, and extracted again below.
  await fsp.rm(versionDir, { recursive: true, force: true });

  if (await exists(archivePath)) {
    const got = await sha256OfFile(archivePath);
    if (got !== asset.sha256) {
      // No logging here — this can be reached on every retry (relay-lifecycle.ts
      // calls ensureBinary again on its own backoff), and the caller already
      // owns "once per outage" logging through its own OutageLog, keyed on
      // this exact `reason` string. A second log line here duplicated it on
      // every single attempt instead of once.
      return {
        ok: false,
        reason: `hand-placed archive at ${archivePath} does not match the pinned checksum (expected ${asset.sha256}, got ${got})`,
        placeArchiveAt: downloadsDir,
        assetName: asset.name,
      };
    }
    return extractAndFinish(archivePath, downloadsDir, versionDir, asset, exePath, extract);
  }

  await fsp.mkdir(downloadsDir, { recursive: true });
  opts.onDownloadStart?.();
  const downloaded = await downloadToPart(
    downloadUrlFor(asset),
    partPath,
    opts.fetchImpl ?? fetch,
    opts.onProgress,
    MEDIAMTX_DOWNLOAD_BYTES,
    opts.downloadTimeouts ?? DEFAULT_DOWNLOAD_TIMEOUTS,
  );
  if (!downloaded.ok) {
    await fsp.unlink(partPath).catch(() => {});
    return { ok: false, reason: downloaded.reason, placeArchiveAt: downloadsDir, assetName: asset.name };
  }
  const got = await sha256OfFile(partPath);
  if (got !== asset.sha256) {
    await fsp.unlink(partPath).catch(() => {});
    // Same reasoning as the hand-placed check above — no logging here; the
    // caller logs once per outage from the returned `reason`, not once per
    // retry from this call.
    return {
      ok: false,
      reason: `checksum mismatch for ${asset.name}: expected ${asset.sha256}, got ${got}`,
      placeArchiveAt: downloadsDir,
      assetName: asset.name,
    };
  }
  await fsp.rename(partPath, archivePath);
  return extractAndFinish(archivePath, downloadsDir, versionDir, asset, exePath, extract);
}
