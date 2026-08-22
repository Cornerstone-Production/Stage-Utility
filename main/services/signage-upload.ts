// signage-upload.ts — a request body straight to disk, hashed on the way.
//
// Every other upload in this app goes through readRawBody, which accumulates
// chunks and then Buffer.concats them: peak memory is roughly twice the body.
// That is fine for a config bundle and wrong for a 200 MB video, and readRawBody
// says so itself — a body past its 128 MB ceiling "wants streaming to a temp
// file, not a bigger number". Raising that number instead would leave an
// unauthenticated ~400 MB allocation one curl away on a Pi, which is the OOM the
// ceiling exists to prevent.
//
// So nothing here ever holds the body. The cap is checked as bytes arrive rather
// than against Content-Length, because that header is the sender's claim and a
// chunked request does not send one at all.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  SIGNAGE_EXT_BY_MIME,
  SIGNAGE_MIME_CAPS,
  isSignageMime,
} from "../types/signage.js";
import { getUserDataPath } from "./app-paths.js";
import { SIGNAGE_MEDIA_DIR } from "./signage-media-store.js";

export class UploadTooLargeError extends Error {
  readonly status = 413;
  constructor(readonly limit: number) {
    super(`Upload exceeds ${Math.round(limit / (1024 * 1024))} MB`);
    this.name = "UploadTooLargeError";
  }
}

/**
 * Stream `req` into the media directory, returning the content-addressed name.
 *
 * `existed` is true when those exact bytes were already stored, which is how the
 * same graphic uploaded twice collapses to one file instead of two copies of a
 * hundred megabytes.
 */
export async function streamUploadToMedia(
  req: Readable,
  mime: string,
): Promise<{ file: string; bytes: number; existed: boolean }> {
  // Checked before anything is created, so a refused type leaves no directory,
  // no temp file and no trace.
  if (!isSignageMime(mime)) throw new Error(`${mime} is not accepted`);
  const limit = SIGNAGE_MIME_CAPS[mime];
  const ext = SIGNAGE_EXT_BY_MIME[mime];

  const dir = path.join(getUserDataPath(), SIGNAGE_MEDIA_DIR);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `upload-${crypto.randomBytes(8).toString("hex")}.tmp`);

  const hash = crypto.createHash("sha256");
  let bytes = 0;

  try {
    // pipeline rather than a hand-rolled loop: it propagates a failure in either
    // direction and destroys both ends, so a client that disconnects mid-upload
    // cannot leave the write stream open holding the temp file.
    await pipeline(
      req,
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          bytes += chunk.byteLength;
          if (bytes > limit) throw new UploadTooLargeError(limit);
          hash.update(chunk);
          yield chunk;
        }
      },
      fs.createWriteStream(tmp),
    );

    if (bytes === 0) throw new Error("empty upload");

    const file = `${hash.digest("hex").slice(0, 16)}.${ext}`;
    try {
      // link, not rename: rename would clobber, and an existing file with this
      // name already holds these exact bytes. EEXIST is the success case for a
      // duplicate rather than an error to report.
      await fsp.link(tmp, path.join(dir, file));
      return { file, bytes, existed: false };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      return { file, bytes, existed: true };
    }
  } finally {
    // Every exit path, including the 413 and a reset connection. One 200 MB
    // orphan per aborted upload fills an SD card in an afternoon.
    await fsp.rm(tmp, { force: true }).catch((err) => {
      console.error(`[signage-upload] could not remove the temp file ${tmp}:`, err);
    });
  }
}
