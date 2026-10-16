// Tests for POST /api/displays/presence's own heartbeat body handling.
//
// handlePresenceHeartbeat is exported from remote-server.ts specifically so
// this shape — the display heartbeat lands first and unconditionally, a
// malformed or missing `video` field never blocks it — is provable without a
// live server or an HTTP round trip.

import assert from "node:assert/strict";
import { test } from "node:test";

import { handlePresenceHeartbeat } from "./remote-server.js";

type VideoPlaybackReport = import("../types/video.js").VideoPlaybackReport;

function deps() {
  const heartbeats: string[] = [];
  const screenRecords: { outputId: string; deviceId: unknown; screen: unknown }[] = [];
  const videoRecords: { outputId: string; reports: VideoPlaybackReport[] }[] = [];
  return {
    heartbeats,
    screenRecords,
    videoRecords,
    d: {
      heartbeat: (outputId: string) => heartbeats.push(outputId),
      recordScreen: async (outputId: string, deviceId: unknown, screen: unknown) => {
        screenRecords.push({ outputId, deviceId, screen });
        return null;
      },
      recordVideo: (outputId: string, reports: VideoPlaybackReport[]) => videoRecords.push({ outputId, reports }),
    },
  };
}

const REPORT: VideoPlaybackReport = { feedId: "feed-1", via: "webrtc", decoded: 100, dropped: 0, stalls: 0, width: 1920, height: 1080, jitterBufferMs: 240 };

test("the display heartbeat lands first, and unconditionally — a body with no video field at all", () => {
  const { heartbeats, videoRecords, d } = deps();
  handlePresenceHeartbeat("display-1", {}, d);
  assert.deepEqual(heartbeats, ["display-1"]);
  assert.deepEqual(videoRecords, []);
});

test("a valid video array is passed through to recordVideo, exactly as parsed", () => {
  const { videoRecords, d } = deps();
  handlePresenceHeartbeat("display-1", { video: [REPORT] }, d);
  assert.deepEqual(videoRecords, [{ outputId: "display-1", reports: [REPORT] }]);
});

test("a malformed video field is refused whole by parseVideoReports, but the heartbeat still counts", () => {
  const { heartbeats, videoRecords, d } = deps();
  handlePresenceHeartbeat("display-1", { video: "not an array" }, d);
  assert.deepEqual(heartbeats, ["display-1"], "the heartbeat must land regardless of what video holds");
  assert.deepEqual(videoRecords, [], "a refused video field records nothing");
});

test("an empty video array records nothing either — there is nothing to report", () => {
  const { videoRecords, d } = deps();
  handlePresenceHeartbeat("display-1", { video: [] }, d);
  assert.deepEqual(videoRecords, []);
});

test("the screen-size read is always attempted, with whatever deviceId/screen the body carries", async () => {
  const { screenRecords, d } = deps();
  handlePresenceHeartbeat("display-1", { deviceId: "dev-1", screen: { w: 1920, h: 1080 } }, d);
  await Promise.resolve(); // recordScreen's own .then() runs on a microtask
  assert.deepEqual(screenRecords, [{ outputId: "display-1", deviceId: "dev-1", screen: { w: 1920, h: 1080 } }]);
});
