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
import { ASSETS, MEDIAMTX_DOWNLOAD_BYTES, MEDIAMTX_VERSION, downloadUrlFor, type MediaMtxAsset } from "./mediamtx-pin.js";

const execFileAsync = promisify(execFile);

// A pinned archive is ~27 MB. 64 MB is a sanity ceiling against a redirect or
// a compromised host serving something else entirely — checked against bytes
// actually received, never the (spoofable, sometimes absent) declared
// Content-Length, which is a progress hint only.
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 300_000;

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
  const asset = ASSETS.get(`${process.platform}-${process.arch}`);
  if (!asset) return false;
  return exists(path.join(relayDir(), MEDIAMTX_VERSION, asset.exe));
}

async function sha256OfFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

type DownloadResult = { ok: true; sha256: string } | { ok: false; reason: string };

/** Streams the response to `<archive>.part`, hashing as it goes, and refuses
 *  past MAX_DOWNLOAD_BYTES of ACTUAL received bytes — not the declared
 *  Content-Length, which a chunked response may omit entirely. */
async function downloadToPart(
  url: string,
  partPath: string,
  fetchImpl: typeof fetch,
  onProgress: ((received: number, total: number) => void) | undefined,
  totalHint: number,
): Promise<DownloadResult> {
  let response: Response;
  try {
    response = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (err) {
    return { ok: false, reason: `could not reach ${url}: ${errorMessage(err)}` };
  }
  if (!response.ok) return { ok: false, reason: `download of ${url} failed: HTTP ${response.status}` };
  if (!response.body) return { ok: false, reason: `download of ${url} returned no body` };

  const declared = Number(response.headers.get("content-length"));
  const total = Number.isFinite(declared) && declared > 0 ? declared : totalHint;

  const hash = createHash("sha256");
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
      hash.update(value);
      await file.write(value);
      onProgress?.(received, total);
    }
    return { ok: true, sha256: hash.digest("hex") };
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
 * — item 3 (findings-t15-r2.md): it used to be the full archive path for
 * every failure except the unsupported-platform one, so the renderer's
 * "place X at Y" read "place mediamtx.tar.gz at .../mediamtx.tar.gz",
 * naming the same file twice. `assetName` and `placeArchiveAt` are sent as
 * the two separate fields they are — "place <assetName> in
 * <placeArchiveAt>" — never one path a caller has to split apart.
 */
type EnsureBinaryResult =
  | { ok: true; path: string }
  | { ok: false; reason: string; placeArchiveAt: string; assetName: string | null };

async function extractAndFinish(
  archivePath: string,
  downloadsDir: string,
  versionDir: string,
  asset: MediaMtxAsset,
  exePath: string,
  extract: ExtractFn,
): Promise<EnsureBinaryResult> {
  try {
    await extract(archivePath, versionDir, asset.exe);
  } catch (err) {
    return {
      ok: false,
      reason: `extracting ${asset.name} failed: ${errorMessage(err)}`,
      placeArchiveAt: downloadsDir,
      assetName: asset.name,
    };
  }
  if (process.platform !== "win32") {
    try {
      await fsp.chmod(exePath, 0o755);
    } catch (err) {
      return {
        ok: false,
        reason: `could not make ${exePath} executable: ${errorMessage(err)}`,
        placeArchiveAt: downloadsDir,
        assetName: asset.name,
      };
    }
  }
  return { ok: true, path: exePath };
}

/**
 * Makes sure the pinned MediaMTX binary is on disk, in this order:
 *
 *   1. Already extracted (`<version>/<exe>`) — used as-is, no fetch, no
 *      re-verification.
 *   2. A hand-placed archive in `downloads/` — verified against the pinned
 *      checksum. A match extracts with no fetch; a mismatch is refused and
 *      left in place (it is the operator's file).
 *   3. Otherwise downloaded, verified, and extracted.
 *
 * Every failure returns `{ ok: false, reason, placeArchiveAt }` rather than
 * throwing — the caller (the relay's status) turns that straight into what
 * the page shows.
 */
export async function ensureBinary(opts: EnsureBinaryOptions = {}): Promise<EnsureBinaryResult> {
  const assets = opts.assets ?? ASSETS;
  const asset = assets.get(`${process.platform}-${process.arch}`) ?? null;
  const downloadsDir = path.join(relayDir(), "downloads");

  if (!asset) {
    return {
      ok: false,
      reason: `Video relay is not available for ${process.platform} ${process.arch}.`,
      placeArchiveAt: downloadsDir,
      assetName: null,
    };
  }

  const versionDir = path.join(relayDir(), MEDIAMTX_VERSION);
  const exePath = path.join(versionDir, asset.exe);
  const archivePath = path.join(downloadsDir, asset.name);
  const partPath = `${archivePath}.part`;
  const extract = opts.extract ?? realExtract;

  if (await exists(exePath)) return { ok: true, path: exePath };

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
  );
  if (!downloaded.ok) {
    await fsp.unlink(partPath).catch(() => {});
    return { ok: false, reason: downloaded.reason, placeArchiveAt: downloadsDir, assetName: asset.name };
  }
  if (downloaded.sha256 !== asset.sha256) {
    await fsp.unlink(partPath).catch(() => {});
    // Same reasoning as the hand-placed check above — no logging here; the
    // caller logs once per outage from the returned `reason`, not once per
    // retry from this call.
    return {
      ok: false,
      reason: `checksum mismatch for ${asset.name}: expected ${asset.sha256}, got ${downloaded.sha256}`,
      placeArchiveAt: downloadsDir,
      assetName: asset.name,
    };
  }
  await fsp.rename(partPath, archivePath);
  return extractAndFinish(archivePath, downloadsDir, versionDir, asset, exePath, extract);
}
