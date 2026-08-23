// signage-storage.ts — how much of the disk signage is using, and how much is left.
//
// Signage is the only part of this app that can fill a disk. Everything else
// writes JSON measured in kilobytes; a media library is video measured in
// hundreds of megabytes, on a Pi with a 32 GB card. An operator uploading a
// service recording has no way to know they are three files from the server
// being unable to write anything at all — including the stores that hold their
// schedules.
//
// So the numbers are REAL: the free space is the filesystem's own, not a
// quota this app invented, because what runs out is the card.

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { isSignageVideo } from "../types/signage.js";
import { getUserDataPath } from "./app-paths.js";
import { signageMediaStore } from "./signage-media-store.js";
import { SIGNAGE_MEDIA_DIR } from "./signage-media-store.js";

export interface SignageStorage {
  /** Bytes of graphics in the library. */
  images: number;
  /** Bytes of video in the library. */
  video: number;
  /**
   * Bytes on the media disk used by anything that is not this library —
   * the OS, logs, everything else. Derived, never measured: walking a whole
   * filesystem to draw a bar is not worth a Pi's IO.
   */
  other: number;
  free: number;
  total: number;
  /** Files on disk that no record points at, waiting for the next prune. */
  orphanBytes: number;
}

/** Below this much free, an operator needs telling before they upload again. */
export const LOW_SPACE_BYTES = 2 * 1024 * 1024 * 1024;
/** And below this, uploading is about to start failing. */
export const CRITICAL_SPACE_BYTES = 512 * 1024 * 1024;

/**
 * What is on the disk, split the way the media library is split.
 *
 * Sizes come from the FILES rather than from the manifest's `bytes` field. The
 * two should agree, and when they do not the disk is right — a manifest can be
 * stale, hand-edited, or restored from a backup whose files were skipped for
 * being too large, and a bar drawn from it would confidently describe a disk
 * nobody has.
 */
export async function signageStorage(): Promise<SignageStorage> {
  const dir = path.join(getUserDataPath(), SIGNAGE_MEDIA_DIR);

  const [statfs, entries, media] = await Promise.all([
    fs.statfs(getUserDataPath()),
    fs.readdir(dir).catch(() => [] as string[]),
    signageMediaStore.load().catch(() => []),
  ]);

  const mimeOf = new Map(media.map((m) => [m.file, m.mime]));
  const known = new Set(media.map((m) => m.file));

  let images = 0;
  let video = 0;
  let orphanBytes = 0;
  for (const file of entries) {
    const size = await fs
      .stat(path.join(dir, file))
      .then((s) => (s.isFile() ? s.size : 0))
      // One unreadable file must not cost the whole figure. It is counted as
      // nothing, which understates rather than invents.
      .catch(() => 0);
    if (!known.has(file)) {
      // On disk, referenced by nothing. Usually a deleted record whose bytes
      // are waiting out the prune grace period.
      orphanBytes += size;
      continue;
    }
    if (isSignageVideo(mimeOf.get(file) ?? "")) video += size;
    else images += size;
  }

  const total = statfs.blocks * statfs.bsize;
  const free = statfs.bavail * statfs.bsize;
  // Everything the disk holds that is not this library. Subtracted rather than
  // measured, and floored at zero so a filesystem reporting oddly cannot draw a
  // negative segment.
  const other = Math.max(0, total - free - images - video - orphanBytes);

  return { images, video, other, free, total, orphanBytes };
}

/** How worried to be, in one word. */
export function storagePressure(s: Pick<SignageStorage, "free">): "ok" | "low" | "critical" {
  if (s.free <= CRITICAL_SPACE_BYTES) return "critical";
  if (s.free <= LOW_SPACE_BYTES) return "low";
  return "ok";
}
