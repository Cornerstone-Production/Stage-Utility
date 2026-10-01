// main/services/video/feed-store.ts — the operator's feeds. Config: backed up.

import { DataStore } from "../data-store.js";
import { DEFAULT_VIDEO_PORTS, type VideoFeedsFile } from "../../types/video.js";

export const videoFeedsStore = new DataStore<VideoFeedsFile>(
  "video-feeds.json",
  { feeds: [], ports: DEFAULT_VIDEO_PORTS },
  "config",
);

/** The file with every missing field defaulted. A file written by an older build
 *  (or restored from one) has no `ports`, or only some; each gets its default. */
export async function loadFeedsFile(): Promise<VideoFeedsFile> {
  const raw = (await videoFeedsStore.load()) as Partial<VideoFeedsFile> | null;
  return {
    feeds: Array.isArray(raw?.feeds) ? raw.feeds : [],
    ports: { ...DEFAULT_VIDEO_PORTS, ...(raw?.ports ?? {}) },
  };
}
