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
  /** Test seam: a fake pin table so a test can inject its own SHA-256 and
   *  asset name without touching the real pin. Defaults to ASSETS. */
  assets?: typeof ASSETS;
  /** Test seam for the extraction step. Defaults to the real tar-based
   *  extractor; a test replaces it with a spy to prove a failed verification
   *  never reaches extraction. */
  extract?: ExtractFn;
}

type EnsureBinaryResult = { ok: true; path: string } | { ok: false; reason: string; placeArchiveAt: string };

async function extractAndFinish(
  archivePath: string,
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
      placeArchiveAt: archivePath,
    };
  }
  if (process.platform !== "win32") {
    try {
      await fsp.chmod(exePath, 0o755);
    } catch (err) {
      return {
        ok: false,
        reason: `could not make ${exePath} executable: ${errorMessage(err)}`,
        placeArchiveAt: archivePath,
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
      console.warn(`[video] hand-placed ${archivePath} does not match the pinned checksum; left in place`);
      return {
        ok: false,
        reason: `hand-placed archive at ${archivePath} does not match the pinned checksum (expected ${asset.sha256}, got ${got})`,
        placeArchiveAt: archivePath,
      };
    }
    return extractAndFinish(archivePath, versionDir, asset, exePath, extract);
  }

  await fsp.mkdir(downloadsDir, { recursive: true });
  console.log(`[video] downloading MediaMTX ${MEDIAMTX_VERSION} (${asset.name})`);
  const downloaded = await downloadToPart(
    downloadUrlFor(asset),
    partPath,
    opts.fetchImpl ?? fetch,
    opts.onProgress,
    MEDIAMTX_DOWNLOAD_BYTES,
  );
  if (!downloaded.ok) {
    await fsp.unlink(partPath).catch(() => {});
    return { ok: false, reason: downloaded.reason, placeArchiveAt: archivePath };
  }
  if (downloaded.sha256 !== asset.sha256) {
    await fsp.unlink(partPath).catch(() => {});
    console.warn(
      `[video] checksum mismatch for ${asset.name}: expected ${asset.sha256}, got ${downloaded.sha256}; deleted`,
    );
    return {
      ok: false,
      reason: `checksum mismatch for ${asset.name}: expected ${asset.sha256}, got ${downloaded.sha256}`,
      placeArchiveAt: archivePath,
    };
  }
  await fsp.rename(partPath, archivePath);
  return extractAndFinish(archivePath, versionDir, asset, exePath, extract);
}
