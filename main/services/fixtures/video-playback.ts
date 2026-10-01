// video-playback.ts — what the screen playback-health tests share: a report,
// a feed to report against, and the waits a heartbeat's fire-and-forget
// record needs before a test reads what it did.

import { strict as assert } from "node:assert";

import type { VideoPlaybackReport } from "../../types/video.js";

/** One report, everything defaulted to "nothing wrong" — each test overrides
 *  only what it is testing. */
export function report(overrides: Partial<VideoPlaybackReport> = {}): VideoPlaybackReport {
  return { feedId: "feed-1", via: "webrtc", decoded: 1000, dropped: 0, stalls: 0, width: 1920, height: 1080, ...overrides };
}

/** Adds an external feed through the real video service and returns its id.
 *  The service is imported when this runs, not when this file loads: every
 *  test that uses it points STAGE_UTILITY_DATA at a temp dir before its own
 *  first import of the service. */
export async function addRelayFeed(name: string): Promise<string> {
  const { videoService } = await import("../video/video-service.js");
  const made = await videoService.addFeed({ name, source: { kind: "external", url: "https://relay.example/whep" } });
  assert.ok(made.ok, "expected the fixture feed to be added");
  return (made as { feed: { id: string } }).feed.id;
}

/**
 * recordPlaybackReports() records fire-and-forget, behind a feed-store read
 * that resolves from memory once anything has loaded it. Iteration-bounded,
 * not wall-clock-bounded: several tests fake Date to jump a full minute in
 * zero real time. Enough for a log line; not for a publish — see
 * settleUntil().
 */
export async function settle(iterations = 20): Promise<void> {
  for (let i = 0; i < iterations; i++) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Waits until `done()` holds, or fails after 5 s of wall-clock time. A
 * heartbeat's publish runs fire-and-forget behind real file reads (the relay
 * binary and archive checks in state()), so a fixed number of turns can end
 * before it lands under load, and a frame count read then is short by one.
 * performance.now(), not Date.now(): several tests fake Date.
 */
export async function settleUntil(done: () => boolean, what: string): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!done() && performance.now() < deadline) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(done(), `timed out waiting for ${what}`);
}
