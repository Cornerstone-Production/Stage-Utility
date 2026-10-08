// renderer/main/video/playback-stats.test.ts — the delta math against fake
// stats objects, no jsdom: a fake RTCPeerConnection (a minimal one, not the
// shared fake-peer-connection.ts fixture — this file needs its getStats() to
// answer a DIFFERENT report on each call, which that fixture's fixed stub
// does not do) and a fake <video> that is a plain EventTarget with the two
// members createSampler reads.

import { strict as assert } from "node:assert";
import { mock, test } from "node:test";

import { DEFAULT_SETTLE_MS } from "@main/services/repeat-log";
import { DRAIN_TIMEOUT_MS } from "./playback-reports.js";
import { createSampler, FRAME_WAIT_MS, NOT_A_MEASUREMENT_MS, rtpBehindMs, STATS_READ_TIMEOUT_MS, trackDelta } from "./playback-stats.js";

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
    assert.deepEqual(first, { feedId: "feed-1", via: "webrtc", decoded: 30, dropped: 1, stalls: 0, width: 1280, height: 720, jitterBufferMs: null, behindNewestMs: null });
    const second = await sampler.sample();
    assert.deepEqual(second, { feedId: "feed-1", via: "webrtc", decoded: 60, dropped: 2, stalls: 0, width: 1920, height: 1080, jitterBufferMs: null, behindNewestMs: null });
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

// ── createSampler: webrtc stalls — freezeCount, not `waiting` ────────────
//
// A `<video>` playing a MediaStream (every WebRTC session) never fires
// `waiting` when the stream starves — three real 3 s SIGSTOPs of a 1080p
// publisher, driven through a real browser, gave `waits: 0` for 46 actually
// dropped frames. Chrome's `inbound-rtp` video report carries its own
// receiver-side `freezeCount` instead; this reads that, falling back to
// `waiting` only when a browser's report carries no such field at all.

function fakePcFreeze(reports: { framesDecoded: number; framesDropped: number; frameWidth: number; frameHeight: number; freezeCount: number }[]) {
  let call = 0;
  return {
    getStats: async () => {
      const r = reports[Math.min(call, reports.length - 1)]!;
      call += 1;
      return new Map([["in", { type: "inbound-rtp", kind: "video", ...r }]]);
    },
  } as unknown as RTCPeerConnection;
}

test("webrtc: freezeCount is read as the stall delta, the same as decoded/dropped", async () => {
  const pc = fakePcFreeze([
    { framesDecoded: 300, framesDropped: 0, frameWidth: 1920, frameHeight: 1080, freezeCount: 1 },
    { framesDecoded: 600, framesDropped: 0, frameWidth: 1920, frameHeight: 1080, freezeCount: 4 },
  ]);
  const video = new FakeVideoEl() as unknown as HTMLVideoElement;
  const sampler = createSampler("feed-1", "Feed", { via: "webrtc", pc }, video, noLog);
  try {
    const first = await sampler.sample();
    assert.equal(first!.stalls, 1, "the first reading is a delta against a zero baseline, like every other counter here");
    const second = await sampler.sample();
    assert.equal(second!.stalls, 3, "expected the delta since the last sample, not the running total");
  } finally {
    sampler.stop();
  }
});

test("webrtc: a new session's freezeCount restarting at zero reads as a zero delta, not negative", async () => {
  const pc = fakePcFreeze([
    { framesDecoded: 500, framesDropped: 0, frameWidth: 1920, frameHeight: 1080, freezeCount: 5 },
    { framesDecoded: 4, framesDropped: 0, frameWidth: 1920, frameHeight: 1080, freezeCount: 0 }, // a fresh attempt's own counters
  ]);
  const video = new FakeVideoEl() as unknown as HTMLVideoElement;
  const sampler = createSampler("feed-1", "Feed", { via: "webrtc", pc }, video, noLog);
  try {
    await sampler.sample();
    const report = await sampler.sample();
    assert.equal(report!.stalls, 0, "a lower freezeCount must not read as a negative stall delta");
  } finally {
    sampler.stop();
  }
});

test("webrtc: an absent freezeCount falls back to counting `waiting` events", async () => {
  // fakePc's reports (unlike fakePcFreeze's) carry no freezeCount field at
  // all — the shape a browser that does not implement it would answer with.
  const pc = fakePc([{ framesDecoded: 300, framesDropped: 0, frameWidth: 1920, frameHeight: 1080 }]);
  const video = new FakeVideoEl() as unknown as HTMLVideoElement;
  const sampler = createSampler("feed-1", "Feed", { via: "webrtc", pc }, video, noLog);
  try {
    video.dispatchEvent(new Event("waiting"));
    video.dispatchEvent(new Event("waiting"));
    const report = await sampler.sample();
    assert.equal(report!.stalls, 2, "no freezeCount at all must fall back to the `waiting` count, the same source HLS uses");
  } finally {
    sampler.stop();
  }
});

/** getStats() answering each report in turn, each exactly as given — a
 *  report without `freezeCount` carries no such key at all. */
function fakePcSequence(reports: Record<string, number>[]) {
  let call = 0;
  return {
    getStats: async () => {
      const r = reports[Math.min(call, reports.length - 1)]!;
      call += 1;
      return new Map([["in", { type: "inbound-rtp", kind: "video", ...r }]]);
    },
  } as unknown as RTCPeerConnection;
}

test("webrtc: a session that started on freezeCount stays on it when a later report carries none", async () => {
  const pc = fakePcSequence([
    { framesDecoded: 300, framesDropped: 0, frameWidth: 1920, frameHeight: 1080, freezeCount: 1 },
    { framesDecoded: 600, framesDropped: 0, frameWidth: 1920, frameHeight: 1080 },
    { framesDecoded: 900, framesDropped: 0, frameWidth: 1920, frameHeight: 1080, freezeCount: 4 },
  ]);
  const video = new FakeVideoEl() as unknown as HTMLVideoElement;
  const sampler = createSampler("feed-1", "Feed", { via: "webrtc", pc }, video, noLog);
  try {
    assert.equal((await sampler.sample())!.stalls, 1);
    video.dispatchEvent(new Event("waiting"));
    video.dispatchEvent(new Event("waiting"));
    assert.equal((await sampler.sample())!.stalls, 0, "a report missing freezeCount must not switch this session to counting `waiting`");
    assert.equal((await sampler.sample())!.stalls, 3, "freezeCount resumes from its own last reading");
  } finally {
    sampler.stop();
  }
});

test("webrtc: a session that started on `waiting` stays on it when a later report carries freezeCount", async () => {
  const pc = fakePcSequence([
    { framesDecoded: 300, framesDropped: 0, frameWidth: 1920, frameHeight: 1080 },
    { framesDecoded: 600, framesDropped: 0, frameWidth: 1920, frameHeight: 1080, freezeCount: 5 },
  ]);
  const video = new FakeVideoEl() as unknown as HTMLVideoElement;
  const sampler = createSampler("feed-1", "Feed", { via: "webrtc", pc }, video, noLog);
  try {
    assert.equal((await sampler.sample())!.stalls, 0);
    video.dispatchEvent(new Event("waiting"));
    assert.equal((await sampler.sample())!.stalls, 1, "a report that starts carrying freezeCount must not switch this session off `waiting`");
  } finally {
    sampler.stop();
  }
});

// ── createSampler: webrtc receive delay ──────────────────────────────────
//
// jitterBufferMs is two cumulative counters read as deltas; behindNewestMs
// compares the RTP timestamp of the NEXT frame to reach the screen
// (requestVideoFrameCallback metadata) with the newest the receiver has heard
// (getSynchronizationSources), both read in that frame's own callback.
// Neither can be seen on a real clock here: the real browser figures were
// measured against a live relay, see docs/integrations/video-feeds.md.

type SyncSource = { timestamp: number; rtpTimestamp: number };

/** A peer connection whose getStats() answers each report in turn and whose
 *  one video receiver reports `sources` as its synchronization sources. */
function fakePcDelay(
  reports: Record<string, number>[],
  receiver: { sources?: () => SyncSource[]; kind?: string; noMethod?: boolean } = {},
) {
  let call = 0;
  const rx: Record<string, unknown> = { track: { kind: receiver.kind ?? "video" } };
  if (!receiver.noMethod) rx.getSynchronizationSources = receiver.sources ?? (() => []);
  return {
    getStats: async () => {
      const r = reports[Math.min(call, reports.length - 1)]!;
      call += 1;
      return new Map([["in", { type: "inbound-rtp", kind: "video", framesDecoded: 1, framesDropped: 0, frameWidth: 1280, frameHeight: 720, ...r }]]);
    },
    getReceivers: () => [rx],
  } as unknown as RTCPeerConnection;
}

/** A <video> whose requestVideoFrameCallback the test fires by hand. */
class FakeRvfcVideo extends EventTarget {
  videoWidth = 0;
  videoHeight = 0;
  private cb: ((now: number, metadata?: { rtpTimestamp?: number }) => void) | null = null;
  requested = 0;
  cancelled: number[] = [];
  requestVideoFrameCallback(cb: (now: number, metadata?: { rtpTimestamp?: number }) => void): number {
    this.cb = cb;
    this.requested += 1;
    return 7;
  }
  cancelVideoFrameCallback(handle: number): void {
    this.cancelled.push(handle);
    this.cb = null;
  }
  /** A frame reaches the screen: fires the pending callback, if one is armed.
   *  A hidden tab never calls this, and a frame with nothing armed goes
   *  nowhere, as in a browser. */
  present(metadata?: { rtpTimestamp?: number }): void {
    const cb = this.cb;
    this.cb = null;
    cb?.(0, metadata);
  }
  get armed(): boolean {
    return this.cb !== null;
  }
}

/** Samples once while a frame reaches the screen with `metadata`. */
async function sampleWithFrame(sampler: ReturnType<typeof createSampler>, video: FakeRvfcVideo, metadata?: { rtpTimestamp?: number }) {
  const pending = sampler.sample();
  video.present(metadata);
  return pending;
}

test("webrtc: jitterBufferMs is the average wait per frame THIS interval, from the delta of the two counters", async () => {
  const pc = fakePcDelay([
    { jitterBufferDelay: 1, jitterBufferEmittedCount: 10 },
    { jitterBufferDelay: 3, jitterBufferEmittedCount: 20 },
  ]);
  const sampler = createSampler("feed-1", "Feed", { via: "webrtc", pc }, new FakeVideoEl() as unknown as HTMLVideoElement, noLog);
  try {
    assert.equal((await sampler.sample())!.jitterBufferMs, 100, "the first read is a delta against zero: 1 s over 10 frames");
    assert.equal((await sampler.sample())!.jitterBufferMs, 200, "2 s over the next 10 frames, not the running 3 s over 20 (150)");
  } finally {
    sampler.stop();
  }
});

test("webrtc: jitterBufferMs is null — never zero — when the counters are missing, did not advance, or restarted", async () => {
  const missing = createSampler("feed-1", "Feed", { via: "webrtc", pc: fakePcDelay([{ jitterBufferDelay: 2 }]) }, new FakeVideoEl() as unknown as HTMLVideoElement, noLog);
  try {
    assert.equal((await missing.sample())!.jitterBufferMs, null, "no emitted count");
  } finally {
    missing.stop();
  }

  const flat = createSampler(
    "feed-1",
    "Feed",
    {
      via: "webrtc",
      pc: fakePcDelay([
        { jitterBufferDelay: 2, jitterBufferEmittedCount: 20 },
        { jitterBufferDelay: 2.5, jitterBufferEmittedCount: 20 },
        { jitterBufferDelay: 0.1, jitterBufferEmittedCount: 2 },
      ]),
    },
    new FakeVideoEl() as unknown as HTMLVideoElement,
    noLog,
  );
  try {
    await flat.sample();
    assert.equal((await flat.sample())!.jitterBufferMs, null, "delay moved but no frame left the buffer: nothing to average");
    assert.equal((await flat.sample())!.jitterBufferMs, null, "counters that went backwards are a fresh session, a zero delta");
  } finally {
    flat.stop();
  }
});

test("webrtc: a figure at or past a minute is not a measurement — null, not a clamp", async () => {
  const sampler = createSampler(
    "feed-1",
    "Feed",
    { via: "webrtc", pc: fakePcDelay([{ jitterBufferDelay: 59.999, jitterBufferEmittedCount: 1 }, { jitterBufferDelay: 119.999, jitterBufferEmittedCount: 2 }]) },
    new FakeVideoEl() as unknown as HTMLVideoElement,
    noLog,
  );
  try {
    assert.equal(NOT_A_MEASUREMENT_MS, 60_000);
    assert.equal((await sampler.sample())!.jitterBufferMs, 59_999, "just under is reported as it is");
    assert.equal((await sampler.sample())!.jitterBufferMs, null, "a full minute per frame is not what the buffer held");
  } finally {
    sampler.stop();
  }
});

test("hls: a report carries neither receive-delay figure, not even as null", async () => {
  const video = new FakeHlsVideoEl(1280, 720, 50, 2);
  const sampler = createSampler("feed-2", "Feed", { via: "hls" }, video as unknown as HTMLVideoElement, noLog);
  try {
    const report = await sampler.sample();
    assert.equal("jitterBufferMs" in report!, false);
    assert.equal("behindNewestMs" in report!, false);
  } finally {
    sampler.stop();
  }
});

test("rtpBehindMs: ticks at 90 kHz, across the 32-bit wrap, never negative", () => {
  assert.equal(rtpBehindMs(90_000 + 9_000, 90_000), 100);
  assert.equal(rtpBehindMs(90_000, 90_000), 0);
  assert.equal(rtpBehindMs(1_000, 5_000), 0, "a displayed frame ahead of the newest read is 0, not a wrapped 13 hours");
  // 0xFFFFFF00 to 8000: 256 + 8000 ticks across the wrap.
  assert.equal(rtpBehindMs(8_000, 0xffffff00), (256 + 8_000) / 90);
});

test("the frame wait fits inside the stats read, which fits inside the heartbeat's drain", () => {
  assert.ok(FRAME_WAIT_MS < STATS_READ_TIMEOUT_MS && STATS_READ_TIMEOUT_MS < DRAIN_TIMEOUT_MS);
});

test("webrtc: behindNewestMs is the next presented frame's RTP timestamp against the receiver's newest, across the wrap", async () => {
  const video = new FakeRvfcVideo();
  const pc = fakePcDelay([{}], { sources: () => [{ timestamp: 1000, rtpTimestamp: 8_000 }] });
  const sampler = createSampler("feed-1", "Feed", { via: "webrtc", pc }, video as unknown as HTMLVideoElement, noLog);
  try {
    assert.equal((await sampleWithFrame(sampler, video, { rtpTimestamp: 0xffffff00 }))!.behindNewestMs, 92, "(256 + 8000) ticks / 90, rounded");
  } finally {
    sampler.stop();
  }
});

test("webrtc: behindNewestMs reads the most recently heard source, not the first listed", async () => {
  const video = new FakeRvfcVideo();
  const pc = fakePcDelay([{}], {
    sources: () => [
      { timestamp: 100, rtpTimestamp: 999_999 },
      { timestamp: 900, rtpTimestamp: 90_000 + 45_000 },
    ],
  });
  const sampler = createSampler("feed-1", "Feed", { via: "webrtc", pc }, video as unknown as HTMLVideoElement, noLog);
  try {
    assert.equal((await sampleWithFrame(sampler, video, { rtpTimestamp: 90_000 }))!.behindNewestMs, 500);
  } finally {
    sampler.stop();
  }
});

test("webrtc: behindNewestMs is null when either side cannot be read", async () => {
  const cases: [why: string, pc: RTCPeerConnection, metadata: { rtpTimestamp?: number }][] = [
    ["the frame carries no rtpTimestamp", fakePcDelay([{}], { sources: () => [{ timestamp: 1, rtpTimestamp: 5 }] }), {}],
    ["the receiver has heard no source", fakePcDelay([{}], { sources: () => [] }), { rtpTimestamp: 1 }],
    ["the receiver has no getSynchronizationSources", fakePcDelay([{}], { noMethod: true }), { rtpTimestamp: 1 }],
    ["the only receiver is audio", fakePcDelay([{}], { kind: "audio", sources: () => [{ timestamp: 1, rtpTimestamp: 5 }] }), { rtpTimestamp: 1 }],
  ];
  for (const [why, pc, metadata] of cases) {
    const video = new FakeRvfcVideo();
    const sampler = createSampler("feed-1", "Feed", { via: "webrtc", pc }, video as unknown as HTMLVideoElement, noLog);
    try {
      assert.equal((await sampleWithFrame(sampler, video, metadata))!.behindNewestMs, null, why);
    } finally {
      sampler.stop();
    }
  }
});

test("webrtc: a frame callback delivered with no metadata object is tolerated and reads null", async () => {
  // A shim or older engine may call back with nothing; reading `.rtpTimestamp`
  // off undefined once threw out of the browser's frame loop.
  const video = new FakeRvfcVideo();
  const pc = fakePcDelay([{}], { sources: () => [{ timestamp: 1, rtpTimestamp: 90_000 }] });
  const sampler = createSampler("feed-1", "Feed", { via: "webrtc", pc }, video as unknown as HTMLVideoElement, noLog);
  try {
    assert.equal((await sampleWithFrame(sampler, video))!.behindNewestMs, null);
  } finally {
    sampler.stop();
  }
});

test("webrtc: no frame reaching the screen (a hidden tab, a paused picture) is null after FRAME_WAIT_MS — and the rest of the report still goes out", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const video = new FakeRvfcVideo();
  const pc = fakePcDelay([{ framesDecoded: 90, jitterBufferDelay: 1, jitterBufferEmittedCount: 10 }], { sources: () => [{ timestamp: 1, rtpTimestamp: 720_000 }] });
  const sampler = createSampler("feed-1", "Feed", { via: "webrtc", pc }, video as unknown as HTMLVideoElement, noLog);
  try {
    let report: Awaited<ReturnType<typeof sampler.sample>> = null;
    let done = false;
    void sampler.sample().then((r) => {
      report = r;
      done = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(done, false, "the sample waits for a frame before giving up");
    mock.timers.tick(FRAME_WAIT_MS);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(done, true);
    assert.equal(report!.behindNewestMs, null, "no frame was presented, so nothing says how far behind the screen is");
    assert.equal(report!.jitterBufferMs, 100);
    assert.equal(report!.decoded, 90);
    assert.deepEqual(video.cancelled, [7], "the unanswered callback is cancelled, not left pending on the element");
  } finally {
    sampler.stop();
    mock.timers.reset();
  }
});

test("webrtc: a frame presented long ago cannot stand in for a figure — only a frame arriving during THIS sample counts", async () => {
  // A frame at timestamp 0 reached the screen, then the tab stopped drawing
  // while the receiver kept taking frames in (newest 720000, eight seconds
  // on). Reading the old frame against the new newest gave a false
  // 8000 ms behind; a sample now waits for a frame of its own, and none comes.
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const video = new FakeRvfcVideo();
  const pc = fakePcDelay([{}], { sources: () => [{ timestamp: 1, rtpTimestamp: 720_000 }] });
  const sampler = createSampler("feed-1", "Feed", { via: "webrtc", pc }, video as unknown as HTMLVideoElement, noLog);
  try {
    video.present({ rtpTimestamp: 0 }); // the last frame ever drawn
    let report: Awaited<ReturnType<typeof sampler.sample>> = null;
    void sampler.sample().then((r) => {
      report = r;
    });
    mock.timers.tick(FRAME_WAIT_MS);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(report!.behindNewestMs, null);
  } finally {
    sampler.stop();
    mock.timers.reset();
  }
});

test("webrtc: clocks that are not comparable (a source change leaves two SSRCs) read null, not a made-up lag", async () => {
  const video = new FakeRvfcVideo();
  const pc = fakePcDelay([{}], { sources: () => [{ timestamp: 1, rtpTimestamp: 90 * NOT_A_MEASUREMENT_MS }] });
  const sampler = createSampler("feed-1", "Feed", { via: "webrtc", pc }, video as unknown as HTMLVideoElement, noLog);
  try {
    assert.equal((await sampleWithFrame(sampler, video, { rtpTimestamp: 0 }))!.behindNewestMs, null, "exactly a minute is out");
    const just = fakePcDelay([{}], { sources: () => [{ timestamp: 1, rtpTimestamp: 90 * (NOT_A_MEASUREMENT_MS - 1) }] });
    const second = createSampler("feed-1", "Feed", { via: "webrtc", pc: just }, video as unknown as HTMLVideoElement, noLog);
    try {
      assert.equal((await sampleWithFrame(second, video, { rtpTimestamp: 0 }))!.behindNewestMs, NOT_A_MEASUREMENT_MS - 1, "a millisecond under is a figure");
    } finally {
      second.stop();
    }
  } finally {
    sampler.stop();
  }
});

test("webrtc: behindNewestMs is null without requestVideoFrameCallback at all, and the report still goes out", async () => {
  const pc = fakePcDelay([{ jitterBufferDelay: 1, jitterBufferEmittedCount: 10 }], { sources: () => [{ timestamp: 1, rtpTimestamp: 5 }] });
  const sampler = createSampler("feed-1", "Feed", { via: "webrtc", pc }, new FakeVideoEl() as unknown as HTMLVideoElement, noLog);
  try {
    const report = await sampler.sample();
    assert.equal(report!.behindNewestMs, null);
    assert.equal(report!.jitterBufferMs, 100);
  } finally {
    sampler.stop();
  }
});

test("webrtc: a sample requests one frame callback, not a standing loop — nothing is armed between samples", async () => {
  const video = new FakeRvfcVideo();
  const pc = fakePcDelay([{}], { sources: () => [{ timestamp: 1, rtpTimestamp: 90_000 }] });
  const sampler = createSampler("feed-1", "Feed", { via: "webrtc", pc }, video as unknown as HTMLVideoElement, noLog);
  try {
    assert.equal(video.requested, 0, "creating a sampler wakes the page for nothing");
    await sampleWithFrame(sampler, video, { rtpTimestamp: 0 });
    assert.equal(video.requested, 1);
    assert.equal(video.armed, false, "a delivered callback does not re-arm itself");
    await sampleWithFrame(sampler, video, { rtpTimestamp: 0 });
    assert.equal(video.requested, 2);
  } finally {
    sampler.stop();
  }
});

test("webrtc: stop() during a sample cancels the pending callback, and the sample still settles", async () => {
  const video = new FakeRvfcVideo();
  const sampler = createSampler("feed-1", "Feed", { via: "webrtc", pc: fakePcDelay([{}]) }, video as unknown as HTMLVideoElement, noLog);
  const pending = sampler.sample();
  assert.equal(video.armed, true);
  sampler.stop();
  assert.deepEqual(video.cancelled, [7]);
  assert.equal((await pending)!.behindNewestMs, null);
});

test("webrtc: a getStats() that rejects does not leave a frame callback armed", async () => {
  const video = new FakeRvfcVideo();
  const sampler = createSampler("feed-1", "Feed", { via: "webrtc", pc: rejectingPc() }, video as unknown as HTMLVideoElement, noLog);
  try {
    assert.equal(await sampler.sample(), null);
    assert.deepEqual(video.cancelled, [7]);
    assert.equal(video.armed, false);
  } finally {
    sampler.stop();
  }
});

test("hls: no frame callback is ever requested", async () => {
  const video = new FakeRvfcVideo() as unknown as HTMLVideoElement & FakeRvfcVideo;
  (video as unknown as { getVideoPlaybackQuality: () => unknown }).getVideoPlaybackQuality = () => ({ totalVideoFrames: 1, droppedVideoFrames: 0 });
  const sampler = createSampler("feed-2", "Feed", { via: "hls" }, video, noLog);
  try {
    await sampler.sample();
    assert.equal(video.requested, 0);
  } finally {
    sampler.stop();
  }
});

test("webrtc: getSynchronizationSources() throwing is a failed stats read — null report, logged — not a silent null figure", async () => {
  const logs: string[] = [];
  const video = new FakeRvfcVideo();
  const pc = fakePcDelay([{}], {
    sources: () => {
      throw new Error("receiver gone");
    },
  });
  const sampler = createSampler("feed-1", "Program", { via: "webrtc", pc }, video as unknown as HTMLVideoElement, (r) => logs.push(r));
  try {
    assert.equal(await sampleWithFrame(sampler, video, { rtpTimestamp: 1 }), null);
    assert.deepEqual(logs, ["Program: could not read playback stats: receiver gone"]);
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

test("hls: decoded is totalVideoFrames less droppedVideoFrames, both as deltas; videoWidth/Height are the current size", async () => {
  // totalVideoFrames counts dropped frames too; WebRTC's framesDecoded does
  // not. Reported as-is, 5 dropped of 100 total would read 5% on HLS where
  // the same picture over WebRTC reads 5 of 95.
  const video = new FakeHlsVideoEl(1280, 720, 50, 2);
  const sampler = createSampler("feed-2", "Feed", { via: "hls" }, video as unknown as HTMLVideoElement, noLog);
  try {
    const first = await sampler.sample();
    assert.deepEqual(first, { feedId: "feed-2", via: "hls", decoded: 48, dropped: 2, stalls: 0, width: 1280, height: 720 });
    video.set(140, 5, 1920, 1080);
    const second = await sampler.sample();
    assert.deepEqual(second, { feedId: "feed-2", via: "hls", decoded: 87, dropped: 3, stalls: 0, width: 1920, height: 1080 });
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
// Logged, not swallowed: a persistent getStats() rejection would otherwise
// leave a widget reporting nothing, with no trail anywhere to say why. Uses
// repeat-log.ts's OutageLog, the same class use-video-session.ts's streak
// wraps for dropped playback, rather than a second once-per-outage tracker.

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

test("webrtc: a getStats() that never answers is a failed read — null once STATS_READ_TIMEOUT_MS passes, logged once per outage", async () => {
  // The presence heartbeat gives up on the whole drain at 2 s; a read that
  // hangs has to give up sooner and say so, or the other widgets' reports go
  // with it and nothing anywhere says why the screen stopped reporting.
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const video = new FakeVideoEl() as unknown as HTMLVideoElement;
  const logs: string[] = [];
  const pc = { getStats: () => new Promise(() => {}) } as unknown as RTCPeerConnection;
  const sampler = createSampler("feed-1", "Program (IMAG)", { via: "webrtc", pc }, video, (r) => logs.push(r));
  try {
    assert.ok(STATS_READ_TIMEOUT_MS < DRAIN_TIMEOUT_MS, "a hung read must give up before the heartbeat gives up on every widget");
    for (let i = 0; i < 2; i++) {
      let result: unknown = "pending";
      void sampler.sample().then((r) => {
        result = r;
      });
      mock.timers.tick(STATS_READ_TIMEOUT_MS);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(result, null, "a read that never answers must resolve null once the timeout passes");
    }
    assert.deepEqual(logs, ["Program (IMAG): could not read playback stats: getStats() did not answer within 1.5 s"]);
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
