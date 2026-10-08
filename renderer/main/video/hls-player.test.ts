// renderer/main/video/hls-player.test.ts — which HLS player startHls picks, and
// what it does with hls.js's errors.
//
// hls.js itself is replaced by test-fixtures/fake-hls.ts: under Node it loads
// but has no MediaSource to attach to, so the real library cannot be driven
// here. The stand-in records what startHls asked of it, which is the decision
// under test — native HLS or hls.js — and the latency it reports, which is
// what the live catch-up acts on. No jsdom: the <video> is a plain object with
// the members startHls touches.

import { strict as assert } from "node:assert";
import { afterEach, mock, test } from "node:test";

import { LIVE_JUMP_COOLDOWN_MS, MAX_LIVE_SYNC_RATE, startHls } from "./hls-player.js";
import { FakeHls, installFakeHls } from "../../test-fixtures/fake-hls.js";

let undo: (() => void) | null = null;
function useFakeHls(): void {
  undo = installFakeHls();
}

/** A <video> that says it can play HLS natively, as Chrome 153 now does. */
function nativeCapableVideo() {
  return {
    src: "",
    currentTime: 0,
    seekable: { length: 0, end: (_i: number) => 0 },
    canPlayType: () => "maybe",
    paused: false,
  } as unknown as HTMLVideoElement & { src: string; currentTime: number; paused: boolean };
}

const g = globalThis as unknown as { MediaSource?: unknown; ManagedMediaSource?: unknown };

afterEach(() => {
  mock.timers.reset();
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

test("hls.js is allowed to speed up toward live, but no faster than the cap", async () => {
  useFakeHls();
  await startHls("/video/p/index.m3u8", nativeCapableVideo());
  assert.equal(FakeHls.last!.config.maxLiveSyncPlaybackRate, MAX_LIVE_SYNC_RATE);
});

test("hls.js: past the margin, catchUp jumps to hls.js's live sync position", async () => {
  useFakeHls();
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const video = nativeCapableVideo();
  const session = await startHls("/video/p/index.m3u8", video);
  const fake = FakeHls.last!;
  video.currentTime = 100;
  fake.liveSyncPosition = 103.5;

  fake.latency = 3.5; // 2.0 past the 1.5 target: on the margin, not past it
  assert.equal(session.catchUp(), null);
  assert.equal(video.currentTime, 100);

  fake.latency = 5;
  assert.equal(session.catchUp(), 3.5);
  assert.equal(video.currentTime, 103.5);
});

test("hls.js: no jump without a live sync position or a target", async () => {
  useFakeHls();
  const video = nativeCapableVideo();
  const session = await startHls("/video/p/index.m3u8", video);
  const fake = FakeHls.last!;
  fake.latency = 9;

  assert.equal(session.catchUp(), null, "no playlist yet: liveSyncPosition is null");
  fake.liveSyncPosition = 50;
  fake.targetLatency = null;
  assert.equal(session.catchUp(), null);
  assert.equal(video.currentTime, 0);
});

test("a paused picture never jumps, and does not spend the cooldown", async () => {
  useFakeHls();
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const video = nativeCapableVideo();
  const session = await startHls("/video/p/index.m3u8", video);
  const fake = FakeHls.last!;
  fake.latency = 6;
  fake.liveSyncPosition = 10;

  video.paused = true;
  assert.equal(session.catchUp(), null);
  assert.equal(video.currentTime, 0);
  video.paused = false;
  assert.equal(session.catchUp(), 10, "playing again, it jumps at once");
});

test("a second jump waits out the cooldown", async () => {
  useFakeHls();
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const video = nativeCapableVideo();
  const session = await startHls("/video/p/index.m3u8", video);
  const fake = FakeHls.last!;
  fake.latency = 6;
  fake.liveSyncPosition = 10;

  assert.equal(session.catchUp(), 10);
  fake.liveSyncPosition = 20;
  mock.timers.tick(LIVE_JUMP_COOLDOWN_MS - 1);
  assert.equal(session.catchUp(), null, "still inside the cooldown");
  mock.timers.tick(1);
  assert.equal(session.catchUp(), 10);
  assert.equal(video.currentTime, 20);
});

test("a sync position behind the playhead is not a jump, and does not spend the cooldown", async () => {
  useFakeHls();
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const video = nativeCapableVideo();
  const session = await startHls("/video/p/index.m3u8", video);
  const fake = FakeHls.last!;
  fake.latency = 6; // a source stall: latency grows while the playlist stands still
  fake.liveSyncPosition = 90;
  video.currentTime = 100;

  assert.equal(session.catchUp(), null);
  assert.equal(video.currentTime, 100, "must never seek backward");
  fake.liveSyncPosition = 105;
  assert.equal(session.catchUp(), 5, "the non-jump left the cooldown unspent");
});

test("native HLS never jumps: it does not say where it means to sit", async () => {
  useFakeHls();
  delete g.MediaSource;
  const video = nativeCapableVideo();
  const session = await startHls("/video/p/index.m3u8", video);
  Object.assign(video, { seekable: { length: 1, end: () => 60 } });
  video.currentTime = 40;

  assert.equal(session.catchUp(), null);
  assert.equal(video.currentTime, 40);
});
