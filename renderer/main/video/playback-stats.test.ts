// renderer/main/video/playback-stats.test.ts — the delta math against fake
// stats objects, no jsdom: a fake RTCPeerConnection (a minimal one, not the
// shared fake-peer-connection.ts fixture — this file needs its getStats() to
// answer a DIFFERENT report on each call, which that fixture's fixed stub
// does not do) and a fake <video> that is a plain EventTarget with the two
// members createSampler reads.

import { strict as assert } from "node:assert";
import { mock, test } from "node:test";

import { DEFAULT_SETTLE_MS } from "@main/services/repeat-log";
import { createSampler, trackDelta } from "./playback-stats.js";

/** Most tests here are not about logging at all. */
const noLog = () => {};

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
  const sampler = createSampler("feed-1", "Feed", { via: "webrtc", pc }, video, noLog);
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
  const sampler = createSampler("feed-1", "Feed", { via: "webrtc", pc }, video, noLog);
  try {
    await sampler.sample();
    const report = await sampler.sample();
    assert.equal(report!.decoded, 0, "a lower decoded count must not read as negative frames");
    assert.equal(report!.dropped, 0);
  } finally {
    sampler.stop();
  }
});

test("webrtc: no inbound-rtp video report at all is also skipped, not reported as zeros", async () => {
  const video = new FakeVideoEl() as unknown as HTMLVideoElement;
  const pc = { getStats: async () => new Map([["out", { type: "outbound-rtp", kind: "video" }]]) } as unknown as RTCPeerConnection;
  const sampler = createSampler("feed-1", "Feed", { via: "webrtc", pc }, video, noLog);
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
  const sampler = createSampler("feed-2", "Feed", { via: "hls" }, video as unknown as HTMLVideoElement, noLog);
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
  const sampler = createSampler("feed-3", "Feed", { via: "hls" }, video as unknown as HTMLVideoElement, noLog);
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
  const sampler = createSampler("feed-3", "Feed", { via: "hls" }, video as unknown as HTMLVideoElement, noLog);
  sampler.stop();
  video.dispatchEvent(new Event("waiting"));
  // A fresh sampler on the same element proves the old listener is gone: if it
  // were still attached, this stall would show up as 2, not 1.
  const after = createSampler("feed-3", "Feed", { via: "hls" }, video as unknown as HTMLVideoElement, noLog);
  video.dispatchEvent(new Event("waiting"));
  const report = await after.sample();
  after.stop();
  assert.equal(report!.stalls, 1, "expected only the stall fired after the fresh sampler was created");
});

// ── getStats() rejecting: skip the sample, and log once per outage ───────
//
// Not "swallow the failure" — the OLD shape of this catch did that, and the
// review that found it named exactly this failure mode: a persistent
// getStats() rejection degrading a widget's telemetry to permanent silence
// with no diagnostic trail anywhere. Reuses repeat-log.ts's OutageLog, the
// same class use-video-session.ts's own streak already wraps for dropped
// playback — not a second, hand-rolled once-per-outage tracker.

function rejectingPc(message = "getStats failed") {
  return { getStats: async () => { throw new Error(message); } } as unknown as RTCPeerConnection;
}

test("webrtc: getStats() rejecting skips that sample — null, never a throw into the caller", async () => {
  const video = new FakeVideoEl() as unknown as HTMLVideoElement;
  const sampler = createSampler("feed-1", "Feed", { via: "webrtc", pc: rejectingPc() }, video, noLog);
  try {
    const report = await sampler.sample();
    assert.equal(report, null);
  } finally {
    sampler.stop();
  }
});

test("a persistent getStats() rejection logs once across several heartbeats, not once per heartbeat", async () => {
  const video = new FakeVideoEl() as unknown as HTMLVideoElement;
  const logs: string[] = [];
  const sampler = createSampler("feed-1", "Program (IMAG)", { via: "webrtc", pc: rejectingPc("connection error") }, video, (r) => logs.push(r));
  try {
    await sampler.sample();
    await sampler.sample();
    await sampler.sample();
    assert.equal(logs.length, 1, "a repeated rejection is not news");
    assert.equal(logs[0], "Program (IMAG): could not read playback stats: connection error");
  } finally {
    sampler.stop();
  }
});

test("recovery after a persistent rejection logs once, once the success has settled", async () => {
  // OutageLog's own rule (repeat-log.ts): a success right after a failure is
  // a gap in a flapping outage, not its end — recovery is only news once a
  // success has HELD for the settle window. `Date` is faked so the test
  // proves the real default window rather than a shrunk one.
  mock.timers.enable({ apis: ["Date"] });
  const video = new FakeVideoEl() as unknown as HTMLVideoElement;
  const logs: string[] = [];
  let failing = true;
  const pc = {
    getStats: async () => {
      if (failing) throw new Error("connection error");
      return new Map([["in", { type: "inbound-rtp", kind: "video", framesDecoded: 1, framesDropped: 0, frameWidth: 0, frameHeight: 0 }]]);
    },
  } as unknown as RTCPeerConnection;
  const sampler = createSampler("feed-1", "Program (IMAG)", { via: "webrtc", pc }, video, (r) => logs.push(r));
  try {
    await sampler.sample();
    await sampler.sample();
    assert.equal(logs.length, 1, "expected exactly the one failure line so far");

    failing = false;
    await sampler.sample();
    assert.equal(logs.length, 1, "a success right after the failure has not settled yet — not news");

    mock.timers.tick(DEFAULT_SETTLE_MS);
    await sampler.sample();
    assert.equal(logs.length, 2, "expected exactly one recovery line, once the success has settled");
    assert.match(logs[1]!, /^Program \(IMAG\): playback stats readable again/);

    await sampler.sample();
    assert.equal(logs.length, 2, "a second successful read afterward must not log again");
  } finally {
    sampler.stop();
    mock.timers.reset();
  }
});

test("a rejection after stop() (the session closing on purpose) logs nothing", async () => {
  const video = new FakeVideoEl() as unknown as HTMLVideoElement;
  const logs: string[] = [];
  let resolveGetStats!: () => void;
  const pc = {
    getStats: () =>
      new Promise((_resolve, reject) => {
        resolveGetStats = () => reject(new Error("connection closed"));
      }),
  } as unknown as RTCPeerConnection;
  const sampler = createSampler("feed-1", "Program (IMAG)", { via: "webrtc", pc }, video, (r) => logs.push(r));
  const pending = sampler.sample();
  sampler.stop(); // the attempt ends WHILE the getStats() call is still in flight
  resolveGetStats();
  assert.equal(await pending, null);
  assert.deepEqual(logs, [], "a rejection that lands after stop() must not be reported as an outage");
});

test("a successful read that lands after stop() logs no recovery for the ended attempt", async () => {
  mock.timers.enable({ apis: ["Date"] });
  const video = new FakeVideoEl() as unknown as HTMLVideoElement;
  const logs: string[] = [];
  let failing = true;
  let settle!: () => void;
  const pc = {
    getStats: () => {
      if (failing) return Promise.reject(new Error("connection error"));
      return new Promise((resolve) => {
        settle = () => resolve(new Map([["in", { type: "inbound-rtp", kind: "video", framesDecoded: 1, framesDropped: 0, frameWidth: 0, frameHeight: 0 }]]));
      });
    },
  } as unknown as RTCPeerConnection;
  const sampler = createSampler("feed-1", "Program (IMAG)", { via: "webrtc", pc }, video, (r) => logs.push(r));
  try {
    await sampler.sample();
    assert.equal(logs.length, 1, "expected the one failure line");
    failing = false;
    mock.timers.tick(DEFAULT_SETTLE_MS);
    const pending = sampler.sample();
    sampler.stop(); // the attempt ends while the successful read is in flight
    settle();
    await pending;
    assert.equal(logs.length, 1, "a recovery landing after stop() must not be logged");
  } finally {
    sampler.stop();
    mock.timers.reset();
  }
});
