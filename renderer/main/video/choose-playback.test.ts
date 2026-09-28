import { strict as assert } from "node:assert";
import { test } from "node:test";
import { choosePlayback } from "./choose-playback.js";

const RELAY = { via: "relay", whep: "/video/p/whep", hls: "/video/p/index.m3u8" } as const;
const CAPS = { webrtc: true, nativeHls: false, mse: true };
const base = { play: RELAY, status: { state: "live" as const }, caps: CAPS, allowHls: true, webrtcFailed: false };

test("WebRTC first", () => assert.deepEqual(choosePlayback(base), { method: "webrtc", url: "/video/p/whep" }));
test("HLS when the relay saw B-frames", () => {
  assert.deepEqual(
    choosePlayback({ ...base, status: { state: "delayed", delayedBecause: "b-frames" } }),
    { method: "hls", url: "/video/p/index.m3u8" },
  );
});
test("HLS when WebRTC failed on this screen", () => {
  assert.equal(choosePlayback({ ...base, webrtcFailed: true }).method, "hls");
});
test("HLS when the browser has no WebRTC", () => {
  assert.equal(choosePlayback({ ...base, caps: { ...CAPS, webrtc: false } }).method, "hls");
});
test("the per-screen switch keeps a screen off HLS", () => {
  assert.deepEqual(choosePlayback({ ...base, webrtcFailed: true, allowHls: false }), { method: "none", reason: "hls-off-here" });
});
test("no HLS path at all is can't-play", () => {
  assert.deepEqual(
    choosePlayback({ ...base, webrtcFailed: true, caps: { webrtc: true, nativeHls: false, mse: false } }),
    { method: "none", reason: "no-player" },
  );
});
test("embed plays its iframe", () => {
  assert.deepEqual(choosePlayback({ ...base, play: { via: "embed", src: "https://y/e" } }), { method: "embed", url: "https://y/e" });
});
test("external WHEP has no HLS to fall back to", () => {
  const ext = { ...base, play: { via: "external", url: "http://h/whep", protocol: "whep" } as const };
  assert.equal(choosePlayback(ext).method, "webrtc");
  assert.deepEqual(choosePlayback({ ...ext, webrtcFailed: true }), { method: "none", reason: "no-player" });
});
test("external HLS obeys the switch", () => {
  const ext = { ...base, play: { via: "external", url: "http://h/x.m3u8", protocol: "hls" } as const };
  assert.equal(choosePlayback(ext).method, "hls");
  assert.equal(choosePlayback({ ...ext, allowHls: false }).method, "none");
});
