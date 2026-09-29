// renderer/main/video/playback-stats.test.ts — the delta math against fake
// stats objects, no jsdom: a fake RTCPeerConnection (a minimal one, not the
// shared fake-peer-connection.ts fixture — this file needs its getStats() to
// answer a DIFFERENT report on each call, which that fixture's fixed stub
// does not do) and a fake <video> that is a plain EventTarget with the two
// members createSampler reads.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createSampler, trackDelta } from "./playback-stats.js";

// ── trackDelta ───────────────────────────────────────────────────────────

test("trackDelta: two samples give the difference", () => {
  const delta = trackDelta();
  assert.equal(delta(10), 10, "the first reading is a delta against a zero baseline");
  assert.equal(delta(14), 4);
  assert.equal(delta(20), 6);
});

test("trackDelta: a counter that goes backwards restarts from zero rather than going negative", () => {
  const delta = trackDelta();
  delta(100);
  assert.equal(delta(3), 0, "a fresh session's lower counter must not read as -97 decoded frames");
  assert.equal(delta(9), 6, "the NEXT delta is measured from the new, lower baseline");
});

// ── createSampler: webrtc ────────────────────────────────────────────────

class FakeVideoEl extends EventTarget {
  videoWidth = 0;
  videoHeight = 0;
}

function fakePc(reports: { framesDecoded: number; framesDropped: number; frameWidth: number; frameHeight: number }[]) {
  let call = 0;
  return {
    getStats: async () => {
      const r = reports[Math.min(call, reports.length - 1)]!;
      call += 1;
      return new Map([["in", { type: "inbound-rtp", kind: "video", ...r }]]);
    },
  } as unknown as RTCPeerConnection;
}

test("webrtc: decoded/dropped are deltas since the last sample; width/height are the current size", async () => {
  const pc = fakePc([
    { framesDecoded: 30, framesDropped: 1, frameWidth: 1280, frameHeight: 720 },
    { framesDecoded: 90, framesDropped: 3, frameWidth: 1920, frameHeight: 1080 },
  ]);
  const video = new FakeVideoEl() as unknown as HTMLVideoElement;
  const sampler = createSampler("feed-1", "webrtc", video, pc);
  try {
    const first = await sampler.sample();
    assert.deepEqual(first, { feedId: "feed-1", via: "webrtc", decoded: 30, dropped: 1, stalls: 0, width: 1280, height: 720 });
    const second = await sampler.sample();
    assert.deepEqual(second, { feedId: "feed-1", via: "webrtc", decoded: 60, dropped: 2, stalls: 0, width: 1920, height: 1080 });
  } finally {
    sampler.stop();
  }
});

test("webrtc: a new session's counters starting over read as a zero delta, not negative", async () => {
  const pc = fakePc([
    { framesDecoded: 500, framesDropped: 20, frameWidth: 1280, frameHeight: 720 },
    { framesDecoded: 4, framesDropped: 0, frameWidth: 1280, frameHeight: 720 }, // a fresh attempt's own counters
  ]);
  const video = new FakeVideoEl() as unknown as HTMLVideoElement;
  const sampler = createSampler("feed-1", "webrtc", video, pc);
  try {
    await sampler.sample();
    const report = await sampler.sample();
    assert.equal(report!.decoded, 0, "a lower decoded count must not read as negative frames");
    assert.equal(report!.dropped, 0);
  } finally {
    sampler.stop();
  }
});

test("webrtc: getStats() rejecting skips that sample — null, never a throw into the caller", async () => {
  const video = new FakeVideoEl() as unknown as HTMLVideoElement;
  const pc = { getStats: async () => { throw new Error("connection closing"); } } as unknown as RTCPeerConnection;
  const sampler = createSampler("feed-1", "webrtc", video, pc);
  try {
    const report = await sampler.sample();
    assert.equal(report, null);
  } finally {
    sampler.stop();
  }
});

test("webrtc: no inbound-rtp video report at all is also skipped, not reported as zeros", async () => {
  const video = new FakeVideoEl() as unknown as HTMLVideoElement;
  const pc = { getStats: async () => new Map([["out", { type: "outbound-rtp", kind: "video" }]]) } as unknown as RTCPeerConnection;
  const sampler = createSampler("feed-1", "webrtc", video, pc);
  try {
    assert.equal(await sampler.sample(), null);
  } finally {
    sampler.stop();
  }
});

// ── createSampler: hls ───────────────────────────────────────────────────

class FakeHlsVideoEl extends EventTarget {
  videoWidth: number;
  videoHeight: number;
  private totalVideoFrames: number;
  private droppedVideoFrames: number;
  constructor(w: number, h: number, total: number, dropped: number) {
    super();
    this.videoWidth = w;
    this.videoHeight = h;
    this.totalVideoFrames = total;
    this.droppedVideoFrames = dropped;
  }
  set(total: number, dropped: number, w = this.videoWidth, h = this.videoHeight) {
    this.totalVideoFrames = total;
    this.droppedVideoFrames = dropped;
    this.videoWidth = w;
    this.videoHeight = h;
  }
  getVideoPlaybackQuality() {
    return { totalVideoFrames: this.totalVideoFrames, droppedVideoFrames: this.droppedVideoFrames };
  }
}

test("hls: totalVideoFrames/droppedVideoFrames are deltas; videoWidth/Height are the current size", async () => {
  const video = new FakeHlsVideoEl(1280, 720, 50, 2);
  const sampler = createSampler("feed-2", "hls", video as unknown as HTMLVideoElement);
  try {
    const first = await sampler.sample();
    assert.deepEqual(first, { feedId: "feed-2", via: "hls", decoded: 50, dropped: 2, stalls: 0, width: 1280, height: 720 });
    video.set(140, 5, 1920, 1080);
    const second = await sampler.sample();
    assert.deepEqual(second, { feedId: "feed-2", via: "hls", decoded: 90, dropped: 3, stalls: 0, width: 1920, height: 1080 });
  } finally {
    sampler.stop();
  }
});

// ── stalls: a `waiting` event, either method ─────────────────────────────

test("a `waiting` event on the <video> counts as a stall, as a delta like any other counter", async () => {
  const video = new FakeHlsVideoEl(0, 0, 0, 0);
  const sampler = createSampler("feed-3", "hls", video as unknown as HTMLVideoElement);
  try {
    video.dispatchEvent(new Event("waiting"));
    video.dispatchEvent(new Event("waiting"));
    const first = await sampler.sample();
    assert.equal(first!.stalls, 2);
    video.dispatchEvent(new Event("waiting"));
    const second = await sampler.sample();
    assert.equal(second!.stalls, 1, "expected the delta since the last sample, not the running total");
  } finally {
    sampler.stop();
  }
});

test("stop() drops the `waiting` listener: a stall after stop() is never counted", async () => {
  const video = new FakeHlsVideoEl(0, 0, 0, 0);
  const sampler = createSampler("feed-3", "hls", video as unknown as HTMLVideoElement);
  sampler.stop();
  video.dispatchEvent(new Event("waiting"));
  // A fresh sampler on the same element proves the old listener is gone: if it
  // were still attached, this stall would show up as 2, not 1.
  const after = createSampler("feed-3", "hls", video as unknown as HTMLVideoElement);
  video.dispatchEvent(new Event("waiting"));
  const report = await after.sample();
  after.stop();
  assert.equal(report!.stalls, 1, "expected only the stall fired after the fresh sampler was created");
});
