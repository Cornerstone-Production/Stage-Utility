// renderer/main/video/hls-player.test.ts — which HLS player startHls picks, and
// what it does with hls.js's errors.
//
// hls.js itself is replaced by test-fixtures/fake-hls.ts: under Node it loads
// but has no MediaSource to attach to, so the real library cannot be driven
// here. The stand-in records what startHls asked of it, which is the decision
// under test — native HLS or hls.js. No jsdom: the <video> is a plain object
// with the two members startHls touches.

import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";

import { startHls } from "./hls-player.js";
import { FakeHls, installFakeHls } from "../../test-fixtures/fake-hls.js";

let undo: (() => void) | null = null;
function useFakeHls(): void {
  undo = installFakeHls();
}

/** A <video> that says it can play HLS natively, as Chrome 153 now does. */
function nativeCapableVideo() {
  return { src: "", canPlayType: () => "maybe" } as unknown as HTMLVideoElement & { src: string };
}

const g = globalThis as unknown as { MediaSource?: unknown; ManagedMediaSource?: unknown };

afterEach(() => {
  undo?.();
  undo = null;
  delete g.MediaSource;
  delete g.ManagedMediaSource;
});

test("with MediaSource present, hls.js plays it even where the browser claims native HLS", async () => {
  useFakeHls();
  const video = nativeCapableVideo();

  await startHls("/video/p/index.m3u8", video);

  assert.equal(video.src, "", "native HLS was chosen although MSE exists");
  assert.deepEqual(FakeHls.last?.calls, ["loadSource /video/p/index.m3u8", "attachMedia"]);
});

test("ManagedMediaSource alone counts as MSE: hls.js, not native", async () => {
  useFakeHls();
  delete g.MediaSource;
  g.ManagedMediaSource = class {};
  const video = nativeCapableVideo();

  await startHls("/video/p/index.m3u8", video);

  assert.equal(video.src, "", "native HLS was chosen although ManagedMediaSource exists");
  assert.ok(FakeHls.last, "expected hls.js to be constructed");
});

test("with no MSE at all, native HLS plays it", async () => {
  useFakeHls();
  delete g.MediaSource;
  const video = nativeCapableVideo();

  await startHls("/video/p/index.m3u8", video);

  assert.equal(video.src, "/video/p/index.m3u8");
  assert.equal(FakeHls.last, null, "hls.js must not be constructed without MSE");
});

test("a fatal hls.js error reaches onFatal with its details; a non-fatal one does not", async () => {
  useFakeHls();
  const fatal: string[] = [];

  await startHls("/video/p/index.m3u8", nativeCapableVideo(), { onFatal: (why) => fatal.push(why) });
  FakeHls.last!.raise({ fatal: false, details: "bufferStalledError", type: "mediaError" });
  FakeHls.last!.raise({ fatal: true, details: "manifestLoadError", type: "networkError" });

  assert.deepEqual(fatal, ["manifestLoadError"]);
});

test("stop() destroys the hls.js instance, and latency is hls.js's own", async () => {
  useFakeHls();

  const session = await startHls("/video/p/index.m3u8", nativeCapableVideo());
  assert.equal(session.latencySeconds(), 3.4);
  session.stop();

  assert.equal(FakeHls.last!.calls.at(-1), "destroy");
});
