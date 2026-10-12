// capped-download.ts — fetching something from outside and keeping it, once.
//
// Three callers had each written this for themselves: the PCO photo cache (a small
// body read under a cap), the video relay's binary download (a large body streamed
// to a .part file under a cap and an idle watchdog) and the Mac output helper
// download (the same, plus a hash while it streams). They drifted: the cap, the
// stall timeout and the cleanup of a failed file were each right in one place and
// absent in another.
//
// What is here, and the rule each piece holds:
//   - readCapped: a small body, refused past a byte cap, the transfer stopped;
//   - downloadWatchdog: an abort signal that fires after a quiet spell (idle) or
//     after a ceiling (total), so a slow link that keeps moving finishes and a
//     stalled one does not hang;
//   - streamToPart: a body streamed into a temporary file, refused past a byte
//     cap by what actually arrived (never by a declared length), the file removed
//     on every failure;
//   - commitPart: the rename that makes a finished file visible under its real
//     name, so nothing ever sees half a file;
//   - sha256OfFile: what actually reached the disk, hashed.
//
// Nothing here knows what is being downloaded or what to say about it. The caller
// words its own failures.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";

// ── The watchdog ───────────────────────────────────────────────────────────

/** The timer functions the watchdog uses, injectable so a test can see which
 *  timers are live. */
export interface WatchdogTimers {
  setTimeout: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimeout: (timer: NodeJS.Timeout) => void;
}

export interface DownloadTimeouts {
  idleMs: number;
  totalMs: number;
  /** Replaces the global timer functions; for tests. */
  timers?: WatchdogTimers;
}

/** An abort signal that fires after `idleMs` without a `touch()`, or after
 *  `totalMs` outright, carrying the reason as its Error. `stop()` clears both
 *  timers. Both are unref'd as well, so a `stop()` that was missed can never
 *  hold the process open for the length of the ceiling, which the caller sets
 *  (the video relay passes an hour, the output helper two). */
export function downloadWatchdog({ idleMs, totalMs, timers }: DownloadTimeouts): { signal: AbortSignal; touch: () => void; stop: () => void } {
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

// ── A small body ───────────────────────────────────────────────────────────

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

// ── A large body, to a file ────────────────────────────────────────────────

export interface StreamToPartOptions {
  /** Refuse the body once this many bytes have ARRIVED. */
  maxBytes: number;
  /** Open with `wx`: fail if the file exists, instead of overwriting it. */
  exclusive?: boolean;
  mode?: number;
  /** Called with each chunk after it is written, and the running total. A throw
   *  ends the download like any other failure. */
  onChunk?: (chunk: Uint8Array, received: number) => void;
}

/**
 * Streams `body` into `partPath`. Returns `{ ok: true, bytes }` when the body
 * ended inside the cap, and `{ ok: false, bytes }` when it went past it, in which
 * case the transfer was cancelled. Anything else that goes wrong (the stream
 * erroring or being aborted, a write failing, `onChunk` throwing) is thrown.
 *
 * Every path except success removes `partPath`, so a refused or broken download
 * leaves no file behind. On success the file is closed and complete but still
 * under its temporary name: check it, then commitPart().
 */
export async function streamToPart(
  body: ReadableStream<Uint8Array>,
  partPath: string,
  opts: StreamToPartOptions,
): Promise<{ ok: boolean; bytes: number }> {
  const file = await fsp.open(partPath, opts.exclusive ? "wx" : "w", opts.mode);
  const reader = body.getReader();
  let received = 0;
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > opts.maxBytes) {
        // Stops the transfer rather than letting it run to completion unseen.
        await reader.cancel().catch(() => {});
        return { ok: false, bytes: received };
      }
      await file.write(value);
      opts.onChunk?.(value, received);
    }
    finished = true;
    return { ok: true, bytes: received };
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  } finally {
    reader.releaseLock();
    await file.close();
    if (!finished) await fsp.rm(partPath, { force: true });
  }
}

/** Moves a finished, checked file to its real name. A failed rename removes the
 *  part rather than leaving it to be mistaken for a download in progress. */
export async function commitPart(partPath: string, finalPath: string): Promise<void> {
  try {
    await fsp.rename(partPath, finalPath);
  } catch (err) {
    await fsp.rm(partPath, { force: true });
    throw err;
  }
}

/** The SHA-256 of a file on disk, as lowercase hex. */
export async function sha256OfFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
