// video-kinds.ts — offers every VideoSourceKind for a test, no matter which
// module builds the feed.
//
// This build's own allowedKinds() offers only embed and external (see
// video-service.ts), and a password only exists for pull — so a test that
// needs a pull or push feed opens every kind for its own duration, through the
// same private hook, and closes it again whether it passed or threw.

import type { VideoSourceKind } from "../../types/video.js";

/** Offers every kind for the duration of `fn`: this build offers only embed
 *  and external, and a password only exists for pull. */
export async function withAllKinds<T>(fn: () => Promise<T>): Promise<T> {
  const { videoService } = await import("../video/video-service.js");
  const svc = videoService as unknown as { allowedKinds: () => ReadonlySet<VideoSourceKind> };
  svc.allowedKinds = () => new Set<VideoSourceKind>(["pull", "push", "embed", "external"]);
  try {
    return await fn();
  } finally {
    delete (svc as { allowedKinds?: unknown }).allowedKinds;
  }
}
