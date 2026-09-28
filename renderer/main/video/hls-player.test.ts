// renderer/main/video/hls-player.test.ts — which HLS player startHls picks, and
// what it does with hls.js's errors.
//
// hls.js itself is replaced through __setHlsLoaderForTests: under Node it loads
// but has no MediaSource to attach to, so the real library cannot be driven
// here. The stand-in records what startHls asked of it, which is the decision
// under test — native HLS or hls.js — and it raises ERROR events the way hls.js
// does. No jsdom: the <video> is a plain object with the two members startHls
// touches.

import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";

import { __setHlsLoaderForTests, startHls } from "./hls-player.js";

type Listener = (event: string, data: { fatal: boolean; details?: string; type: string }) => void;

class FakeHls {
  static Events = { ERROR: "hlsError" };
  static last: FakeHls | null = null;
  readonly calls: string[] = [];
  latency = 3.4;
  private listeners: Listener[] = [];
  constructor() {
    FakeHls.last = this;
  }
  on(event: string, fn: Listener): void {
    if (event === FakeHls.Events.ERROR) this.listeners.push(fn);
  }
  loadSource(url: string): void {
    this.calls.push(`loadSource ${url}`);
  }
  attachMedia(): void {
    this.calls.push("attachMedia");
  }
  destroy(): void {
    this.calls.push("destroy");
  }
  /** Raise an ERROR the way hls.js does. */
  raise(data: { fatal: boolean; details?: string; type: string }): void {
    for (const fn of this.listeners) fn(FakeHls.Events.ERROR, data);
  }
}

function useFakeHls(): void {
  FakeHls.last = null;
  __setHlsLoaderForTests(async () => ({ default: FakeHls }) as unknown as typeof import("hls.js"));
}

/** A <video> that says it can play HLS natively, as Chrome 153 now does. */
function nativeCapableVideo() {
  return { src: "", canPlayType: () => "maybe" } as unknown as HTMLVideoElement & { src: string };
}

const g = globalThis as unknown as { MediaSource?: unknown; ManagedMediaSource?: unknown };

afterEach(() => {
  __setHlsLoaderForTests(null);
  delete g.MediaSource;
  delete g.ManagedMediaSource;
});

test("with MediaSource present, hls.js plays it even where the browser claims native HLS", async () => {
  useFakeHls();
  g.MediaSource = class {};
  const video = nativeCapableVideo();

  await startHls("/video/p/index.m3u8", video);

  assert.equal(video.src, "", "native HLS was chosen although MSE exists");
  assert.deepEqual(FakeHls.last?.calls, ["loadSource /video/p/index.m3u8", "attachMedia"]);
});

test("ManagedMediaSource alone counts as MSE: hls.js, not native", async () => {
  useFakeHls();
  g.ManagedMediaSource = class {};
  const video = nativeCapableVideo();

  await startHls("/video/p/index.m3u8", video);

  assert.equal(video.src, "", "native HLS was chosen although ManagedMediaSource exists");
  assert.ok(FakeHls.last, "expected hls.js to be constructed");
});

test("with no MSE at all, native HLS plays it", async () => {
  useFakeHls();
  const video = nativeCapableVideo();

  await startHls("/video/p/index.m3u8", video);

  assert.equal(video.src, "/video/p/index.m3u8");
  assert.equal(FakeHls.last, null, "hls.js must not be constructed without MSE");
});

test("a fatal hls.js error reaches onFatal with its details; a non-fatal one does not", async () => {
  useFakeHls();
  g.MediaSource = class {};
  const fatal: string[] = [];

  await startHls("/video/p/index.m3u8", nativeCapableVideo(), { onFatal: (why) => fatal.push(why) });
  FakeHls.last!.raise({ fatal: false, details: "bufferStalledError", type: "mediaError" });
  FakeHls.last!.raise({ fatal: true, details: "manifestLoadError", type: "networkError" });

  assert.deepEqual(fatal, ["manifestLoadError"]);
});

test("stop() destroys the hls.js instance, and latency is hls.js's own", async () => {
  useFakeHls();
  g.MediaSource = class {};

  const session = await startHls("/video/p/index.m3u8", nativeCapableVideo());
  assert.equal(session.latencySeconds(), 3.4);
  session.stop();

  assert.equal(FakeHls.last!.calls.at(-1), "destroy");
});
