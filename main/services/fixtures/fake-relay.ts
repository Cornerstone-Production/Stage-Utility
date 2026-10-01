// fake-relay.ts — a VideoRelay that talks to nothing, for every test that
// attaches one to the video service.

import type { VideoRelay } from "../video/relay.js";

/** Every method answers at once: no paths, nothing reconciled, nobody to
 *  kick. Pass only the methods a test needs to behave differently. */
export function fakeRelay(overrides: Partial<VideoRelay> = {}): VideoRelay {
  return {
    reconcile: async () => {},
    status: async () => [],
    playback: (feedId) => ({ whep: `/video/${feedId}/whep`, hls: `/video/${feedId}/index.m3u8` }),
    kickPublisher: async () => false,
    ...overrides,
  };
}
