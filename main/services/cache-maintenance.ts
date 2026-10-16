// Periodic disk-cache maintenance. Runs an initial prune shortly after startup
// (kept off the critical boot path) and then once a day, so the photo + plan-
// attachment caches can't grow without bound on a long-running host.

import { prunePhotoCache } from "./photo-cache.js";
import { pruneAttachmentCache } from "./pco-attachment-cache.js";
import { pruneLayoutImages } from "./layout-image-store.js";
import { getUserDataPath } from "./app-paths.js";
import { pruneOutputHelperCache } from "./output-helper-download.js";
import { pkgVersion } from "./updater.js";

const INITIAL_DELAY_MS = 30_000; // let startup settle first
const INTERVAL_MS = 24 * 60 * 60 * 1000; // daily

class CacheMaintenance {
  private initialTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    this.stop();
    this.initialTimer = setTimeout(() => {
      void this.runOnce();
      this.intervalTimer = setInterval(() => void this.runOnce(), INTERVAL_MS);
    }, INITIAL_DELAY_MS);
  }

  stop(): void {
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.initialTimer = null;
    this.intervalTimer = null;
  }

  private async runOnce(): Promise<void> {
    try {
      await prunePhotoCache();
      await pruneAttachmentCache();
      await pruneLayoutImages();
      // The Mac output helper's zips, about 290 MB a version: an update leaves the
      // old version's behind, and a server that is never asked for it again would
      // keep them for good.
      await pruneOutputHelperCache(getUserDataPath(), pkgVersion());
    } catch (err) {
      console.error("[cache-maintenance] prune failed:", err);
    }
  }
}

export const cacheMaintenance = new CacheMaintenance();
