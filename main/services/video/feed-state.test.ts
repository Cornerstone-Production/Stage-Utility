// One case per input shape feedState() tells apart, and the status each reads as.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { feedState, type FeedStateInput } from "./feed-state.js";
import type { RelayPath } from "./relay.js";

const READY: RelayPath = {
  name: "cam",
  ready: true,
  readyTime: "2026-09-27T12:00:00Z",
  source: { type: "rtspSource", id: "src-1" },
  video: { codec: "H264", width: 1920, height: 1080, profile: "High" },
  readers: 1,
};

const NOT_READY: RelayPath = {
  name: "cam",
  ready: false,
  readyTime: null,
  source: null,
  video: null,
  readers: 0,
};

const base: FeedStateInput = {
  kind: "pull",
  relayUp: true,
  path: undefined,
  bframesMark: undefined,
  recentlyRequested: false,
  lastSeenAt: null,
};

test("path ready, H264, no mark -> live, with codec/width/height/profile", () => {
  assert.deepEqual(feedState({ ...base, path: READY }), {
    state: "live",
    codec: "H264",
    width: 1920,
    height: 1080,
    profile: "High",
  });
});

test("path ready, H264, mark with the same readyTime -> delayed, delayedBecause b-frames", () => {
  assert.deepEqual(feedState({ ...base, path: READY, bframesMark: { readyTime: READY.readyTime } }), {
    state: "delayed",
    delayedBecause: "b-frames",
    codec: "H264",
    width: 1920,
    height: 1080,
    profile: "High",
  });
});

test("path ready, mark with a different readyTime -> live (the source reconnected; the mark is stale)", () => {
  assert.deepEqual(feedState({ ...base, path: READY, bframesMark: { readyTime: "2026-09-27T11:00:00Z" } }), {
    state: "live",
    codec: "H264",
    width: 1920,
    height: 1080,
    profile: "High",
  });
});

test("path ready, codec H265 -> delayed, delayedBecause codec", () => {
  const h265: RelayPath = { ...READY, video: { codec: "H265", width: 1280, height: 720 } };
  assert.deepEqual(feedState({ ...base, path: h265 }), {
    state: "delayed",
    delayedBecause: "codec",
    codec: "H265",
    width: 1280,
    height: 720,
    profile: undefined,
  });
});

test("pull, not ready, not recently requested -> standby", () => {
  assert.deepEqual(feedState({ ...base, kind: "pull", path: NOT_READY, recentlyRequested: false }), {
    state: "standby",
  });
});

test("pull, not ready, requested in the last 15 s -> offline, lastSeenAt", () => {
  assert.deepEqual(
    feedState({ ...base, kind: "pull", path: NOT_READY, recentlyRequested: true, lastSeenAt: 1_000 }),
    { state: "offline", lastSeenAt: 1_000 },
  );
});

test("push, not ready, never seen -> waiting", () => {
  assert.deepEqual(feedState({ ...base, kind: "push", path: NOT_READY, lastSeenAt: null }), {
    state: "waiting",
  });
});

test("push, not ready, seen before -> offline, lastSeenAt", () => {
  assert.deepEqual(feedState({ ...base, kind: "push", path: NOT_READY, lastSeenAt: 5_000 }), {
    state: "offline",
    lastSeenAt: 5_000,
  });
});

test("relay up, but no path at all for this feed -> offline, lastSeenAt", () => {
  assert.deepEqual(feedState({ ...base, kind: "push", relayUp: true, path: undefined, lastSeenAt: 9_000 }), {
    state: "offline",
    lastSeenAt: 9_000,
  });
  // Same for a pull feed, and regardless of recentlyRequested: no path at
  // all is not the on-demand case the pull branch handles.
  assert.deepEqual(
    feedState({ ...base, kind: "pull", relayUp: true, path: undefined, recentlyRequested: true, lastSeenAt: 9_000 }),
    { state: "offline", lastSeenAt: 9_000 },
  );
});

// ── The relay itself not being up (off, starting, or never attached — "video switched off") ──

test("relay not up -> standby, whatever path/kind/lastSeenAt say — never a red offline for something nobody has asked about yet", () => {
  assert.deepEqual(feedState({ ...base, relayUp: false, kind: "pull", path: undefined }), { state: "standby" });
  assert.deepEqual(feedState({ ...base, relayUp: false, kind: "push", path: undefined, lastSeenAt: 9_000 }), {
    state: "standby",
  });
  // Even with a (necessarily stale) path present, or recentlyRequested set —
  // the relay being off governs, not any leftover input from before it went off.
  assert.deepEqual(feedState({ ...base, relayUp: false, kind: "pull", path: READY, recentlyRequested: true }), {
    state: "standby",
  });
  assert.deepEqual(feedState({ ...base, relayUp: false, kind: "push", path: NOT_READY, lastSeenAt: 5_000 }), {
    state: "standby",
  });
});
