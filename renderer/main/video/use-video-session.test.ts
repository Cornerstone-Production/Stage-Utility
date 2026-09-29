// renderer/main/video/use-video-session.test.ts — startPlaybackAttempt's state
// machine, driven directly with the shared fake RTCPeerConnection
// (test-fixtures/fake-peer-connection.ts, which dispatches a real
// `connectionstatechange` event on Node's own EventTarget), a
// fake <video> handing back a stored requestVideoFrameCallback, and
// node:test's fake timers for the connect, first-frame, drop-grace and
// backoff windows — plus a few tests that render `useVideoSession` itself
// (via `renderHook`), for behaviour that only exists at the hook layer and
// cannot be proven against `startPlaybackAttempt` alone: the backoff reset,
// and routing a real relay/external feed view through to the right verdict.
//
import { strict as assert } from "node:assert";
import { after, afterEach, mock, test } from "node:test";

import type { VideoFeedView } from "@main/types/video";
import { installRenderDom, unmountAndTeardown } from "../../test-dom.js";
import { FAKE_SDP, FakePeerConnection, installFakePeerConnection, NodeEvent } from "../../test-fixtures/fake-peer-connection.js";
import { FakeHls, installFakeHls } from "../../test-fixtures/fake-hls.js";

const teardown = installRenderDom();

import {
  CONNECT_TIMEOUT_MS,
  DROP_GRACE_MS,
  FIRST_FRAME_TIMEOUT_MS,
  FRAME_POLL_MS,
  PROBE_POLL_MS,
  PROBE_TIMEOUT_MS,
  RESET_AFTER_PLAYING_MS,
  RETRY_MAX_MS,
  RETRY_MIN_MS,
  STREAK_REMIND_MS,
  startPlaybackAttempt,
  useVideoSession,
  WEBRTC_RETRY_AFTER_MS,
} from "./use-video-session.js";
const { renderHook, act, cleanup } = await import("@testing-library/react");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

// Every retry writes a console.debug line (the browser console's Verbose
// level); dozens of them per backoff test are noise in the test output.
const realDebug = console.debug;
console.debug = () => {};
after(() => {
  console.debug = realDebug;
});

/**
 * Drains every already-queued microtask, not a fixed guess at how many
 * `.then()` hops `startWhep`'s offer/POST/answer chain needs — a real
 * `setImmediate` callback runs strictly after the current microtask queue
 * empties, so this is exact whatever that chain's shape happens to be,
 * unaffected by `mock.timers` (only `setTimeout` is faked in these tests).
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

class FakeVideo extends EventTarget {
  private frameCb: (() => void) | undefined;
  requestVideoFrameCallback(cb: () => void): number {
    this.frameCb = cb;
    return 1;
  }
  cancelVideoFrameCallback(): void {
    this.frameCb = undefined;
  }
  /** What getVideoPlaybackQuality() reports as decoded so far. */
  decodedFrames = 0;
  getVideoPlaybackQuality(): { totalVideoFrames: number } {
    return { totalVideoFrames: this.decodedFrames };
  }
  /** Simulates the browser delivering a decoded frame. */
  fireFrame(): void {
    this.frameCb?.();
  }
  /** Simulates the element's own `error` event. */
  fireError(): void {
    this.dispatchEvent(new NodeEvent("error"));
  }
  // What startHls's native branch touches (Node has no MediaSource, so an HLS
  // attempt here always takes it). `srcSets` counts HLS attempts started.
  private assignedSrc = "";
  srcSets = 0;
  get src(): string {
    return this.assignedSrc;
  }
  set src(v: string) {
    this.assignedSrc = v;
    if (v) this.srcSets++;
  }
  srcObject: unknown = null;
  /** Native HLS's latency reads the live edge from here; empty means unknown. */
  seekable = { length: 0, end: (_i: number) => 0 };
  currentTime = 0;
  canPlayType(): string {
    return "maybe";
  }
  removeAttribute(name: string): void {
    if (name === "src") this.assignedSrc = "";
  }
  load(): void {}
}

const EXTERNAL_WHEP: VideoFeedView = {
  id: "cam",
  name: "Cam",
  kind: "external",
  sourceLine: "",
  source: { kind: "external", url: "http://h/cam/whep" },
  play: { via: "external", url: "http://h/cam/whep", protocol: "whep" },
  status: { state: null },
};

type FetchBehavior = "succeed" | "reject" | "hang" | { status: number };

/** Every fetch call, and which promises are still pending (never resolved
 *  unless the test settles them) — for proving a hung POST is bounded by the
 *  connect timeout rather than left open forever. `getHangingSignal()` is for
 *  proving the connect timeout actually ABORTS the hung request's own
 *  signal, not merely its own app-level callback. */
function stubFetch(behaviorOrFn: FetchBehavior | (() => FetchBehavior)) {
  const calls: { method: string; url: string }[] = [];
  let hangingSignal: AbortSignal | undefined;
  const fn = (async (input: string | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url: String(input) });
    const behavior = typeof behaviorOrFn === "function" ? behaviorOrFn() : behaviorOrFn;
    if (method === "DELETE") return { ok: true, status: 200, headers: { get: () => null }, text: async () => "" } as unknown as Response;
    if (behavior === "reject") throw new Error("fetch failed");
    if (behavior === "hang") {
      hangingSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    if (typeof behavior === "object") {
      return { ok: false, status: behavior.status, headers: { get: () => null }, text: async () => "" } as unknown as Response;
    }
    return {
      ok: true,
      status: 201,
      headers: { get: (h: string) => (h === "Location" ? "/video/p/whep/abcd" : null) },
      text: async () => FAKE_SDP,
    } as unknown as Response;
  }) as typeof fetch;
  return { fn, calls, getHangingSignal: () => hangingSignal };
}

// `window.location.href` needs no stubbing here: `installRenderDom()` above
// already provides jsdom's own window at exactly "http://localhost:8788/"
// (test-dom.ts's own JSDOM constructor URL) — the SAME origin a hand-built
// stub used before jsdom was installed for the backoff-reset test below.
// Overwriting `globalThis.window` with a plain object per test, as a stub
// once did, would have pulled the rug out from under `renderHook` in this
// same file, which needs the real one.
function stubGlobals(behavior: FetchBehavior | (() => FetchBehavior)) {
  const { fn, calls, getHangingSignal } = stubFetch(behavior);
  const realFetch = globalThis.fetch;
  globalThis.fetch = fn;
  const restorePc = installFakePeerConnection();
  return {
    calls,
    getHangingSignal,
    restore() {
      globalThis.fetch = realFetch;
      restorePc();
    },
  };
}

function makeCallbacks() {
  const calls: { fn: string; arg?: string }[] = [];
  return {
    calls,
    cb: {
      onPhase: (p: string) => calls.push({ fn: "onPhase", arg: p }),
      onLatency: (s: number | null) => calls.push({ fn: "onLatency", arg: String(s) }),
      onWebrtcUnusable: (reason: string) => calls.push({ fn: "onWebrtcUnusable", arg: reason }),
      onDropped: (reason: string) => calls.push({ fn: "onDropped", arg: reason }),
    },
  };
}

afterEach(() => {
  FakePeerConnection.reset();
});

test("connects and a frame arrives: live, no unusable/dropped verdict", async () => {
  const g = stubGlobals("succeed");
  const video = new FakeVideo() as unknown as HTMLVideoElement & FakeVideo;
  const { calls, cb } = makeCallbacks();
  try {
    const attempt = startPlaybackAttempt(video, { method: "webrtc", url: "/video/p/whep", relayManaged: true }, cb);
    // The offer/POST/answer exchange runs as microtasks.
    await flush();
    const pc = FakePeerConnection.instances[0]!;
    pc.setConnectionState("connected");
    video.fireFrame();

    assert.deepEqual(
      calls.map((c) => c.fn),
      ["onPhase", "onPhase"],
      "expected connecting then live, and nothing else",
    );
    assert.equal(calls[1]!.arg, "live");
    attempt.stop();
  } finally {
    g.restore();
  }
});

test("connected but no frame within FIRST_FRAME_TIMEOUT_MS: webrtc unusable, session stopped", async () => {
  const g = stubGlobals("succeed");
  mock.timers.enable({ apis: ["setTimeout"] });
  const video = new FakeVideo() as unknown as HTMLVideoElement & FakeVideo;
  const { calls, cb } = makeCallbacks();
  try {
    startPlaybackAttempt(video, { method: "webrtc", url: "/video/p/whep", relayManaged: true }, cb);
    await flush();
    const pc = FakePeerConnection.instances[0]!;
    pc.setConnectionState("connected");

    mock.timers.tick(FIRST_FRAME_TIMEOUT_MS);
    await flush();

    assert.deepEqual(calls.filter((c) => c.fn !== "onPhase").map((c) => c.fn), ["onWebrtcUnusable"]);
    assert.equal(g.calls.filter((c) => c.method === "DELETE").length, 1, "expected the session DELETEd exactly once");
  } finally {
    mock.timers.reset();
    g.restore();
  }
});

test("never connects: the post-handshake connect timeout is webrtc-unusable, not a retry", async () => {
  const g = stubGlobals("succeed");
  mock.timers.enable({ apis: ["setTimeout"] });
  const video = new FakeVideo() as unknown as HTMLVideoElement & FakeVideo;
  const { calls, cb } = makeCallbacks();
  try {
    startPlaybackAttempt(video, { method: "webrtc", url: "/video/p/whep", relayManaged: true }, cb);
    await flush();
    // The handshake succeeded (a session exists) but connectionState never
    // reaches "connected" — this is a verdict about WebRTC, not the network.
    mock.timers.tick(CONNECT_TIMEOUT_MS);
    await flush();

    assert.deepEqual(calls.filter((c) => c.fn !== "onPhase").map((c) => c.fn), ["onWebrtcUnusable"]);
  } finally {
    mock.timers.reset();
    g.restore();
  }
});

test("a POST that never gets a reply is dropped (retried), never marked webrtc-unusable", async () => {
  const g = stubGlobals("hang");
  mock.timers.enable({ apis: ["setTimeout"] });
  const video = new FakeVideo() as unknown as HTMLVideoElement & FakeVideo;
  const { calls, cb } = makeCallbacks();
  try {
    startPlaybackAttempt(video, { method: "webrtc", url: "/video/p/whep", relayManaged: true }, cb);
    await flush();

    // The WHOLE handshake window elapses with no reply at all.
    mock.timers.tick(CONNECT_TIMEOUT_MS);
    await flush();

    assert.deepEqual(
      calls.filter((c) => c.fn !== "onPhase").map((c) => c.fn),
      ["onDropped"],
      "a network hang must retry the same method, never fall back permanently — an external WHEP feed has no HLS to fall back to",
    );
  } finally {
    mock.timers.reset();
    g.restore();
  }
});

test("a POST that rejects immediately is dropped (retried) with the real error, not webrtc-unusable", async () => {
  const g = stubGlobals("reject");
  const video = new FakeVideo() as unknown as HTMLVideoElement & FakeVideo;
  const { calls, cb } = makeCallbacks();
  try {
    startPlaybackAttempt(video, { method: "webrtc", url: "/video/p/whep", relayManaged: true }, cb);
    await flush();

    const dropped = calls.find((c) => c.fn === "onDropped");
    assert.ok(dropped, "expected onDropped, not onWebrtcUnusable, for a rejected POST");
    assert.match(dropped!.arg!, /fetch failed/);
    assert.equal(calls.some((c) => c.fn === "onWebrtcUnusable"), false);
  } finally {
    g.restore();
  }
});

test("disconnected then failed, then a full recovery before the grace period: no spurious drop", async () => {
  // A guard against exactly ONE onDropped firing (disconnected -> failed
  // scheduling a SECOND drop timer without clearing the first) is not
  // provable this way: the outer `ended` latch already swallows a second
  // terminal callback however it arrives, so a naive "fires exactly once"
  // check stays green even with the old bug back in. What the missing
  // clearTimeout actually does is ORPHAN the first timer — the "connected"
  // recovery branch only clears whichever timer the (reassigned) variable
  // currently holds, so the orphan outlives a full recovery and fires a
  // SPURIOUS drop on a connection that is, by then, perfectly healthy.
  const g = stubGlobals("succeed");
  mock.timers.enable({ apis: ["setTimeout"] });
  const video = new FakeVideo() as unknown as HTMLVideoElement & FakeVideo;
  const { calls, cb } = makeCallbacks();
  try {
    startPlaybackAttempt(video, { method: "webrtc", url: "/video/p/whep", relayManaged: true }, cb);
    await flush();
    const pc = FakePeerConnection.instances[0]!;
    pc.setConnectionState("connected");
    video.fireFrame(); // now "live"

    pc.setConnectionState("disconnected"); // schedules a drop timer at +DROP_GRACE_MS
    mock.timers.tick(DROP_GRACE_MS / 2);
    pc.setConnectionState("failed"); // must REPLACE that timer, not add a second one
    pc.setConnectionState("connected"); // recovers before either could fire

    // Past where the FIRST (disconnected) timer would fire if orphaned.
    mock.timers.tick(DROP_GRACE_MS);
    await flush();

    assert.deepEqual(
      calls.filter((c) => c.fn !== "onPhase").map((c) => c.fn),
      [],
      "a recovered connection must not report a drop from an orphaned timer",
    );
  } finally {
    mock.timers.reset();
    g.restore();
  }
});

test("stop() ends the attempt cleanly: exactly one DELETE, no further callbacks", async () => {
  const g = stubGlobals("succeed");
  mock.timers.enable({ apis: ["setTimeout"] });
  const video = new FakeVideo() as unknown as HTMLVideoElement & FakeVideo;
  const { calls, cb } = makeCallbacks();
  try {
    const attempt = startPlaybackAttempt(video, { method: "webrtc", url: "/video/p/whep", relayManaged: true }, cb);
    await flush();

    attempt.stop();
    attempt.stop(); // idempotent: a second stop() must not DELETE a second time
    await flush();

    assert.equal(g.calls.filter((c) => c.method === "DELETE").length, 1);

    // Nothing that would have fired later can still reach a callback.
    mock.timers.tick(CONNECT_TIMEOUT_MS + FIRST_FRAME_TIMEOUT_MS);
    await flush();
    assert.deepEqual(
      calls.filter((c) => c.fn !== "onPhase").map((c) => c.fn),
      [],
      "no terminal callback may fire after stop()",
    );
  } finally {
    mock.timers.reset();
    g.restore();
  }
});

// ── the first frame lifts the cover whatever state events arrive ─────────
//
// The frame watch is armed the moment the WHEP answer is applied, not on a
// "connected" event: a picture that is decoding must go live even if that
// event is never observed. With the watch armed only from "connected", a
// session whose state read "connected" by the time the connect timer fired
// had nothing left to fail it and nothing to see its frames — "Connecting"
// forever over a picture that was playing.

test("a frame with no connectionstatechange ever dispatched still goes live, and the connect timer leaves it alone", async () => {
  const g = stubGlobals("succeed");
  mock.timers.enable({ apis: ["setTimeout"] });
  const video = new FakeVideo() as unknown as HTMLVideoElement & FakeVideo;
  const { calls, cb } = makeCallbacks();
  try {
    const attempt = startPlaybackAttempt(video, { method: "webrtc", url: "/video/p/whep", relayManaged: false }, cb);
    await flush();
    // The browser reached "connected" without the event reaching this
    // listener: the state reads connected, no event is dispatched.
    FakePeerConnection.instances[0]!.connectionState = "connected";
    video.fireFrame();

    assert.deepEqual(
      calls.filter((c) => c.fn === "onPhase").map((c) => c.arg),
      ["connecting", "live"],
      "a decoding picture must lift the cover without a connectionstatechange event",
    );

    mock.timers.tick(CONNECT_TIMEOUT_MS + FIRST_FRAME_TIMEOUT_MS);
    await flush();
    assert.deepEqual(
      calls.filter((c) => c.fn !== "onPhase").map((c) => c.fn),
      [],
      "a live session must not be failed by the connect timer",
    );
    attempt.stop();
  } finally {
    mock.timers.reset();
    g.restore();
  }
});

// requestVideoFrameCallback runs only in a rendering step. A page in a
// covered, minimized or napping window gets few rendering steps or none,
// while the element goes on decoding and this attempt's own deadlines go on
// running, so the decoded-frame count is watched as well.

test("a picture that decodes while the page is not being rendered still lifts the cover", async () => {
  const g = stubGlobals("succeed");
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const video = new FakeVideo() as unknown as HTMLVideoElement & FakeVideo;
  const { calls, cb } = makeCallbacks();
  try {
    const attempt = startPlaybackAttempt(video, { method: "webrtc", url: "/video/p/whep", relayManaged: true }, cb);
    await flush();
    FakePeerConnection.instances[0]!.setConnectionState("connected");
    // Frames decode; no rendering step ever runs the frame callback.
    for (let i = 0; i < 5; i++) {
      video.decodedFrames += 6;
      mock.timers.tick(FRAME_POLL_MS);
    }
    mock.timers.tick(FIRST_FRAME_TIMEOUT_MS);
    await flush();

    assert.deepEqual(
      calls.filter((c) => c.fn === "onPhase").map((c) => c.arg),
      ["connecting", "live"],
      "a picture that is decoding must lift the cover whether or not the page renders",
    );
    assert.deepEqual(
      calls.filter((c) => c.fn === "onWebrtcUnusable" || c.fn === "onDropped").map((c) => c.fn),
      [],
      "a decoding picture must never be read as no frame ever arriving",
    );
    attempt.stop();
  } finally {
    mock.timers.reset();
    g.restore();
  }
});

test("a decoded-frame count left from an earlier source is not a first frame", async () => {
  const g = stubGlobals("succeed");
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const video = new FakeVideo() as unknown as HTMLVideoElement & FakeVideo;
  video.decodedFrames = 500; // the element's last picture, not this attempt's
  const { calls, cb } = makeCallbacks();
  try {
    startPlaybackAttempt(video, { method: "webrtc", url: "/video/p/whep", relayManaged: true }, cb);
    await flush();
    FakePeerConnection.instances[0]!.setConnectionState("connected");
    mock.timers.tick(FIRST_FRAME_TIMEOUT_MS);
    await flush();
    assert.deepEqual(
      calls.filter((c) => c.fn !== "onPhase").map((c) => c.fn),
      ["onWebrtcUnusable"],
      "a count that does not move is no frame, whatever its value",
    );
  } finally {
    mock.timers.reset();
    g.restore();
  }
});

test("through the hook: a frame with no 'connected' event puts the widget's phase at live", async () => {
  const g = stubGlobals("succeed");
  const video = new FakeVideo();
  const feed: VideoFeedView = {
    id: "cam",
    name: "Cam",
    kind: "external",
    sourceLine: "",
    source: { kind: "external", url: "http://h/cam/whep" },
    play: { via: "external", url: "http://h/cam/whep", protocol: "whep" },
    status: { state: null },
  };
  try {
    const { result } = renderHook(() =>
      useVideoSession({ active: true, feed, feedDeleted: false, video: video as unknown as HTMLVideoElement, allowHls: true, relayRunning: true }),
    );
    await act(async () => {
      await flush();
    });
    assert.equal(result.current.phase, "connecting");
    act(() => video.fireFrame());
    assert.equal(result.current.phase, "live");
  } finally {
    cleanup();
    g.restore();
  }
});

// ── a relay feed's refusal falls back to HLS; everything else retries ────

test("a relay feed's WHEP refusal (415) is webrtc-unusable — falls back to HLS", async () => {
  const g = stubGlobals({ status: 415 });
  const video = new FakeVideo() as unknown as HTMLVideoElement & FakeVideo;
  const { calls, cb } = makeCallbacks();
  try {
    startPlaybackAttempt(video, { method: "webrtc", url: "/video/p/whep", relayManaged: true }, cb);
    await flush();

    assert.deepEqual(
      calls.filter((c) => c.fn !== "onPhase").map((c) => c.fn),
      ["onWebrtcUnusable"],
      "a relay's outright refusal of the offer is a verdict about the stream, not the network",
    );
  } finally {
    g.restore();
  }
});

test("a relay feed's WHEP 404 retries — a waiting push feed answers 404 until something sends", async () => {
  const g = stubGlobals({ status: 404 });
  const video = new FakeVideo() as unknown as HTMLVideoElement & FakeVideo;
  const { calls, cb } = makeCallbacks();
  try {
    startPlaybackAttempt(video, { method: "webrtc", url: "/video/p/whep", relayManaged: true }, cb);
    await flush();

    assert.deepEqual(calls.filter((c) => c.fn !== "onPhase").map((c) => c.fn), ["onDropped"]);
  } finally {
    g.restore();
  }
});

test("an external WHEP feed's 415 still retries — it has no HLS to fall back to", async () => {
  const g = stubGlobals({ status: 415 });
  const video = new FakeVideo() as unknown as HTMLVideoElement & FakeVideo;
  const { calls, cb } = makeCallbacks();
  try {
    startPlaybackAttempt(video, { method: "webrtc", url: "/video/p/whep", relayManaged: false }, cb);
    await flush();

    assert.deepEqual(
      calls.filter((c) => c.fn !== "onPhase").map((c) => c.fn),
      ["onDropped"],
      "Stage Utility cannot report an external feed's health, so a WHEP refusal there must not be treated as a stream verdict",
    );
  } finally {
    g.restore();
  }
});

// ── srcObject is cleared, never left dangling for HLS to inherit ─────────

test("srcObject is cleared once a WebRTC attempt ends", async () => {
  const g = stubGlobals({ status: 415 }); // relay refusal -> webrtc-unusable -> the hook would retry via HLS
  const raw = new FakeVideo();
  const untyped = raw as unknown as { srcObject: unknown };
  const video = raw as unknown as HTMLVideoElement & FakeVideo;
  untyped.srcObject = "a-live-mediastream";
  const { cb } = makeCallbacks();
  try {
    const attempt = startPlaybackAttempt(video, { method: "webrtc", url: "/video/p/whep", relayManaged: true }, cb);
    await flush();
    assert.equal(untyped.srcObject, null, "expected srcObject cleared the moment the WebRTC attempt ended");
    attempt.stop();
  } finally {
    g.restore();
  }
});

test("srcObject is cleared before an HLS attempt starts, even if something set it since", async () => {
  const g = stubGlobals("succeed");
  const raw = new FakeVideo();
  const untyped = raw as unknown as {
    srcObject: unknown;
    canPlayType: () => string;
    removeAttribute: (name: string) => void;
    load: () => void;
  };
  const video = raw as unknown as HTMLVideoElement & FakeVideo;
  const { cb } = makeCallbacks();
  let attempt: ReturnType<typeof startPlaybackAttempt> | undefined;
  try {
    untyped.srcObject = "leftover-from-a-webrtc-attempt";
    // Node has no MediaSource, so startHls takes its NATIVE branch
    // (`video.src = url`): real hls.js is never imported, and there is no
    // internal Hls instance left running past this test for a cleanup to
    // reach for.
    untyped.canPlayType = () => "maybe";
    untyped.removeAttribute = () => {};
    untyped.load = () => {};
    attempt = startPlaybackAttempt(video, { method: "hls", url: "/video/p/index.m3u8" }, cb);
    await flush();
    assert.equal(untyped.srcObject, null, "expected srcObject cleared before HLS attaches — a non-null one takes precedence over `src`");
  } finally {
    attempt?.stop();
    g.restore();
  }
});

// ── the connect timeout must abort the underlying fetch itself ───────────

test("the connect timeout aborts the hung POST's own signal, not only its app-level callback", async () => {
  const g = stubGlobals("hang");
  mock.timers.enable({ apis: ["setTimeout"] });
  const video = new FakeVideo() as unknown as HTMLVideoElement & FakeVideo;
  const { cb } = makeCallbacks();
  try {
    startPlaybackAttempt(video, { method: "webrtc", url: "/video/p/whep", relayManaged: true }, cb);
    await flush();

    mock.timers.tick(CONNECT_TIMEOUT_MS);
    await flush();

    const signal = g.getHangingSignal();
    assert.ok(signal, "expected the hung POST to have received an AbortSignal");
    assert.equal(signal?.aborted, true, "expected the connect timeout to abort the fetch's OWN signal, not just fire its own callback");
  } finally {
    mock.timers.reset();
    g.restore();
  }
});

// ── the backoff grows across a failing streak ────────────────────────────
//
// Measured by WHEN the next attempt goes out, not by what a log line says:
// the delay is the behaviour, and the log is now once per streak. Only
// provable through `useVideoSession` itself — the backoff exponent lives in
// the hook, across repeated calls to `startPlaybackAttempt`.

const EXPECTED_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000, 30000];

const EXTERNAL_HLS: VideoFeedView = {
  id: "obs",
  name: "OBS",
  kind: "external",
  sourceLine: "",
  source: { kind: "external", url: "http://h/obs/index.m3u8" },
  play: { via: "external", url: "http://h/obs/index.m3u8", protocol: "hls" },
  status: { state: null },
};

/** jsdom's <video> plays no HLS and Node has no MediaSource, so browserCaps()
 *  would answer "can't play" for an HLS feed. Claiming native HLS puts
 *  startHls on its native branch, which only sets `src` on the fake. */
function claimNativeHls(): () => void {
  const proto = Object.getPrototypeOf(document.createElement("video")) as { canPlayType: (t: string) => string };
  const real = proto.canPlayType;
  proto.canPlayType = () => "maybe";
  return () => {
    proto.canPlayType = real;
  };
}

/**
 * The delay before each retry, measured: after each failure, `fail()` drives
 * the attempt to its drop, then the clock is advanced one millisecond short of
 * the expected delay (no new attempt may start) and then the last millisecond
 * (one must). `attempts()` counts attempts started so far.
 */
async function measureDelays(opts: {
  rounds: number;
  attempts: () => number;
  fail: () => void;
  expected: number[];
}): Promise<void> {
  for (let i = 0; i < opts.rounds; i++) {
    const before = opts.attempts();
    act(() => opts.fail());
    const want = opts.expected[i]!;
    await act(async () => {
      mock.timers.tick(want - 1);
      await flush();
    });
    assert.equal(opts.attempts(), before, `retry ${i + 1} started before ${want} ms`);
    await act(async () => {
      mock.timers.tick(1);
      await flush();
    });
    assert.equal(opts.attempts(), before + 1, `retry ${i + 1} did not start at ${want} ms`);
  }
}

test("the retry delay grows 1, 2, 4, 8, 16 s and caps at 30 s across consecutive failures", async () => {
  const g = stubGlobals("reject");
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const video = new FakeVideo();
  try {
    renderHook(() =>
      useVideoSession({ active: true, feed: EXTERNAL_WHEP, feedDeleted: false, video: video as unknown as HTMLVideoElement, allowHls: true, relayRunning: true }),
    );
    await act(async () => {
      await flush();
    });
    // Every POST rejects, so each attempt has already dropped by the time
    // its microtasks drain: `fail` has nothing left to do.
    await measureDelays({
      rounds: EXPECTED_DELAYS.length,
      attempts: () => g.calls.filter((c) => c.method === "POST").length,
      fail: () => {},
      expected: EXPECTED_DELAYS,
    });
  } finally {
    cleanup();
    mock.timers.reset();
    g.restore();
  }
});

test("a failure right after a single frame still grows the delay — one frame is not recovery", async () => {
  // Chrome's native HLS player showed one frame of the relay's LL-HLS and
  // then failed with a demuxer error. Resetting the counter on that frame
  // pinned every retry at RETRY_MIN_MS, for ever.
  const g = stubGlobals("succeed");
  const restoreHls = claimNativeHls();
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const video = new FakeVideo();
  try {
    renderHook(() =>
      useVideoSession({ active: true, feed: EXTERNAL_HLS, feedDeleted: false, video: video as unknown as HTMLVideoElement, allowHls: true, relayRunning: true }),
    );
    await act(async () => {
      await flush();
    });
    await measureDelays({
      rounds: 4,
      attempts: () => video.srcSets,
      fail: () => {
        video.fireFrame();
        video.fireError();
      },
      expected: [1000, 2000, 4000, 8000],
    });
  } finally {
    cleanup();
    mock.timers.reset();
    restoreHls();
    g.restore();
  }
});

test("playback that holds for RESET_AFTER_PLAYING_MS restarts the backoff at RETRY_MIN_MS", async () => {
  const g = stubGlobals("succeed");
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const video = new FakeVideo();
  try {
    renderHook(() =>
      useVideoSession({ active: true, feed: EXTERNAL_WHEP, feedDeleted: false, video: video as unknown as HTMLVideoElement, allowHls: true, relayRunning: true }),
    );
    await act(async () => {
      await flush();
    });
    const posts = () => g.calls.filter((c) => c.method === "POST").length;
    const dropAfterPlaying = (heldMs: number) => () => {
      const pc = FakePeerConnection.instances.at(-1)!;
      pc.setConnectionState("connected");
      video.fireFrame();
      mock.timers.tick(heldMs);
      pc.setConnectionState("failed");
      mock.timers.tick(DROP_GRACE_MS);
    };
    // Two short plays: the counter keeps growing.
    await measureDelays({ rounds: 1, attempts: posts, fail: dropAfterPlaying(0), expected: [1000] });
    await measureDelays({ rounds: 1, attempts: posts, fail: dropAfterPlaying(0), expected: [2000] });
    // A play that holds: the next failure starts over.
    await measureDelays({ rounds: 1, attempts: posts, fail: dropAfterPlaying(RESET_AFTER_PLAYING_MS), expected: [1000] });
  } finally {
    cleanup();
    mock.timers.reset();
    g.restore();
  }
});

// ── the log is written once per streak, never once per retry ─────────────

test("a failing streak logs once, reminds at most every 5 minutes, and logs its recovery", async () => {
  let failing = true;
  const g = stubGlobals(() => (failing ? "reject" : "succeed"));
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const video = new FakeVideo();
  const logs: string[] = [];
  try {
    renderHook(() =>
      useVideoSession({
        active: true,
        feed: EXTERNAL_WHEP,
        feedDeleted: false,
        video: video as unknown as HTMLVideoElement,
        allowHls: true,
        relayRunning: true,
        onLog: (l) => logs.push(l),
      }),
    );
    await act(async () => {
      await flush();
    });
    assert.equal(logs.length, 1, "the first failure is news");
    assert.match(logs[0]!, /"Cam" failed on this screen \(fetch failed\); retrying with backoff/);

    // Keep failing for just under five minutes: dozens of retries, no line.
    for (let t = 0; t < STREAK_REMIND_MS - RETRY_MAX_MS; t += 1000) {
      await act(async () => {
        mock.timers.tick(1000);
        await flush();
      });
    }
    assert.ok(g.calls.filter((c) => c.method === "POST").length > 10, "expected many retries in that time");
    assert.equal(logs.length, 1, "a retry is not news");

    // Past five minutes: one reminder.
    for (let t = 0; t < 2 * RETRY_MAX_MS; t += 1000) {
      await act(async () => {
        mock.timers.tick(1000);
        await flush();
      });
    }
    assert.equal(logs.length, 2, "expected exactly one reminder past five minutes");
    assert.match(logs[1]!, /still failing after \d+ attempts/);

    // The endpoint recovers; playback holds; the recovery is logged once.
    failing = false;
    for (let t = 0; t < RETRY_MAX_MS; t += 1000) {
      await act(async () => {
        mock.timers.tick(1000);
        await flush();
      });
      const pc = FakePeerConnection.instances.at(-1);
      if (pc && pc.connectionState === "new" && g.calls.at(-1)?.method === "POST") {
        act(() => {
          pc.setConnectionState("connected");
          video.fireFrame();
        });
        break;
      }
    }
    act(() => {
      mock.timers.tick(RESET_AFTER_PLAYING_MS);
    });
    assert.equal(logs.length, 3, "expected one recovery line");
    assert.match(logs[2]!, /"Cam" is playing again on this screen after \d+ failed attempts/);
  } finally {
    cleanup();
    mock.timers.reset();
    g.restore();
  }
});

// ── the HLS-off switch's own outage line ────────────────────────────────
//
// A B-frame feed's verdict here is CANT-PLAY, never an attempt — nothing
// retries, so there are no timers to drive; only a rerender (a fresh feed
// object off a repeated status push) can make this fire twice.

const B_FRAMES_FEED: VideoFeedView = {
  id: "p",
  name: "Program",
  kind: "pull",
  sourceLine: "",
  source: { kind: "pull", url: "rtsp://x", username: "" },
  play: { via: "relay", whep: "/video/p/whep", hls: "/video/p/index.m3u8" },
  status: { state: "delayed", delayedBecause: "b-frames" },
};

test("an HLS-off screen logs the can't-play line once, not once per rerender", async () => {
  // installFakeHls defines MediaSource, so this environment could otherwise
  // play the HLS this feed needs — without it every rerender would read as
  // can't-play for the environment's own sake, proving nothing about the
  // switch.
  const undoHls = installFakeHls();
  const video = new FakeVideo();
  const logs: string[] = [];
  try {
    const { rerender } = renderHook(
      ({ feed }: { feed: VideoFeedView }) =>
        useVideoSession({
          active: true,
          feed,
          feedDeleted: false,
          video: video as unknown as HTMLVideoElement,
          allowHls: false,
          relayRunning: true,
          onLog: (l) => logs.push(l),
        }),
      { initialProps: { feed: B_FRAMES_FEED } },
    );
    await act(async () => {
      await flush();
    });
    assert.deepEqual(logs, [`"Program" can't play on this screen: it needs HLS, and HLS is off here`]);

    // Three more renders off a fresh object each time (what a repeated
    // video:state push looks like) — same status, so the same outage.
    for (let i = 0; i < 3; i++) {
      rerender({ feed: { ...B_FRAMES_FEED, status: { state: "delayed", delayedBecause: "b-frames" } } });
      await act(async () => {
        await flush();
      });
    }
    assert.equal(logs.length, 1, "a rerender carrying the same verdict is not news");
  } finally {
    undoHls();
    cleanup();
  }
});

test("recovers once the screen allows HLS again, with exactly one recovery line", async () => {
  const undoHls = installFakeHls();
  const video = new FakeVideo();
  const logs: string[] = [];
  try {
    const { rerender } = renderHook(
      ({ allowHls }: { allowHls: boolean }) =>
        useVideoSession({
          active: true,
          feed: B_FRAMES_FEED,
          feedDeleted: false,
          video: video as unknown as HTMLVideoElement,
          allowHls,
          relayRunning: true,
          onLog: (l) => logs.push(l),
        }),
      { initialProps: { allowHls: false } },
    );
    await act(async () => {
      await flush();
    });
    assert.equal(logs.length, 1, "expected the outage's first line");

    rerender({ allowHls: true });
    await act(async () => {
      await flush();
    });
    assert.equal(logs.length, 2, "expected exactly one recovery line");
    assert.match(logs[1]!, /^"Program" can play on this screen again after \d+ failed attempts?/);

    // Turning it off and on again a second time is a SECOND outage with its
    // own first line and its own recovery — not silence, and not a stale
    // note carried over from the first.
    rerender({ allowHls: false });
    await act(async () => {
      await flush();
    });
    rerender({ allowHls: true });
    await act(async () => {
      await flush();
    });
    assert.equal(logs.length, 4, "expected a second outage to log its own start and its own recovery");
    assert.equal(logs[2], `"Program" can't play on this screen: it needs HLS, and HLS is off here`);
  } finally {
    undoHls();
    cleanup();
  }
});

test("a screen with HLS allowed logs nothing about the switch for the same feed", async () => {
  const undoHls = installFakeHls();
  const g = stubGlobals("succeed");
  const video = new FakeVideo();
  const logs: string[] = [];
  try {
    renderHook(() =>
      useVideoSession({
        active: true,
        feed: B_FRAMES_FEED,
        feedDeleted: false,
        video: video as unknown as HTMLVideoElement,
        allowHls: true,
        relayRunning: true,
        onLog: (l) => logs.push(l),
      }),
    );
    await act(async () => {
      await flush();
    });
    assert.equal(
      logs.some((l) => l.includes("HLS is off here")),
      false,
      "an HLS-allowed screen must never log the HLS-off line",
    );
  } finally {
    undoHls();
    cleanup();
    g.restore();
  }
});

test("through the hook: a feed already playing over WebRTC shows can't-play once it turns to B-frames on an HLS-off screen, with no HLS session opened", async () => {
  // installFakeHls (MediaSource) makes this environment otherwise ABLE to
  // play the HLS this feed would need — proof that FakeHls is never even
  // constructed is proof nothing here fell back to it, not an artifact of
  // jsdom having no HLS player of its own.
  const undoHls = installFakeHls();
  const g = stubGlobals("succeed");
  const video = new FakeVideo();
  const playingFirst: VideoFeedView = { ...B_FRAMES_FEED, status: { state: "live" } };
  try {
    const { result, rerender } = renderHook(
      ({ feed }: { feed: VideoFeedView }) =>
        useVideoSession({
          active: true,
          feed,
          feedDeleted: false,
          video: video as unknown as HTMLVideoElement,
          allowHls: false,
          relayRunning: true,
        }),
      { initialProps: { feed: playingFirst } },
    );
    await act(async () => {
      await flush();
    });
    const pc = FakePeerConnection.instances.at(-1)!;
    act(() => {
      pc.setConnectionState("connected");
      video.fireFrame();
    });
    assert.equal(result.current.phase, "live", "expected WebRTC genuinely playing first");

    // The relay now reports B-frames mid-play — a real path: an encoder's
    // profile can change while it is already sending.
    rerender({ feed: B_FRAMES_FEED });
    await act(async () => {
      await flush();
    });
    assert.equal(
      result.current.phase,
      "cant-play",
      "expected the can't-play cover once a feed already playing needs HLS this screen refuses",
    );
    assert.deepEqual(
      FakeHls.instances.flatMap((h) => h.calls),
      [],
      "expected no HLS session — and so no index.m3u8 request — opened for a feed an HLS-off screen refuses",
    );
  } finally {
    undoHls();
    cleanup();
    g.restore();
  }
});

// ── routing a real feed view to the right verdict on a WHEP refusal ────────
//
// The tests above set `relayManaged` on `startPlaybackAttempt`'s `choice` by
// hand — real proof of the ROUTING lives one layer up, in `computeVerdict`,
// which derives that flag from `feed.play.via`. Flipping the derivation to
// either constant left every test above green, because none of them drive a
// real feed view through `useVideoSession` itself.

test("a real relay feed view whose WHEP answer refuses the offer (415) is treated as webrtc-unusable", async () => {
  const g = stubGlobals({ status: 415 });
  const video = new FakeVideo();
  const feed: VideoFeedView = {
    id: "f",
    name: "F",
    kind: "pull",
    sourceLine: "",
    source: { kind: "pull", url: "rtsp://x", username: "" },
    play: { via: "relay", whep: "/video/f/whep", hls: "/video/f/index.m3u8" },
    status: { state: "live" },
  };
  const logs: string[] = [];
  try {
    renderHook(() =>
      useVideoSession({
        active: true,
        feed,
        feedDeleted: false,
        video: video as unknown as HTMLVideoElement,
        allowHls: true,
        relayRunning: true,
        onLog: (r) => logs.push(r),
      }),
    );
    await act(async () => {
      await flush();
    });

    assert.ok(
      logs.some((l) => l.includes("unusable")),
      "expected a relay's outright refusal to be treated as a verdict about the stream, not the network",
    );
  } finally {
    cleanup();
    g.restore();
  }
});

test("a real external WHEP feed view whose answer refuses the offer (415) retries instead", async () => {
  const g = stubGlobals({ status: 415 });
  const video = new FakeVideo();
  const feed: VideoFeedView = {
    id: "f",
    name: "F",
    kind: "external",
    sourceLine: "",
    source: { kind: "external", url: "http://h/whep" },
    play: { via: "external", url: "http://h/whep", protocol: "whep" },
    status: { state: null },
  };
  const logs: string[] = [];
  try {
    renderHook(() =>
      useVideoSession({
        active: true,
        feed,
        feedDeleted: false,
        video: video as unknown as HTMLVideoElement,
        allowHls: true,
        relayRunning: true,
        onLog: (r) => logs.push(r),
      }),
    );
    await act(async () => {
      await flush();
    });

    assert.ok(
      logs.some((l) => l.includes("retrying with backoff")),
      "expected an external feed's refusal to retry — it has no HLS to fall back to",
    );
    assert.equal(
      logs.some((l) => l.includes("unusable")),
      false,
      "an external feed's health cannot be reported, so a refusal there must not be treated as a stream verdict",
    );
  } finally {
    cleanup();
    g.restore();
  }
});

test("a pull feed going from standby to live keeps the session its request opened", async () => {
  const g = stubGlobals("succeed");
  const video = new FakeVideo();
  const standby: VideoFeedView = {
    id: "f",
    name: "F",
    kind: "pull",
    sourceLine: "",
    source: { kind: "pull", url: "rtsp://x", username: "" },
    play: { via: "relay", whep: "/video/f/whep", hls: "/video/f/index.m3u8" },
    status: { state: "standby" },
  };
  const posts = () => g.calls.filter((c) => c.method === "POST").length;
  const deletes = () => g.calls.filter((c) => c.method === "DELETE").length;
  try {
    const { rerender } = renderHook(
      ({ feed }: { feed: VideoFeedView }) =>
        useVideoSession({
          active: true,
          feed,
          feedDeleted: false,
          video: video as unknown as HTMLVideoElement,
          allowHls: true,
          relayRunning: true,
        }),
      { initialProps: { feed: standby } },
    );
    await act(async () => {
      await flush();
    });
    assert.equal(posts(), 1, "expected the standby pull feed's own WHEP POST");

    // The request is what started the pull, so the relay now reports the
    // feed live. Same method, same URL: the session already open is the one
    // that made it live, and tearing it down for a fresh one drops the
    // picture for nothing.
    rerender({ feed: { ...standby, status: { state: "live", codec: "H264" } } });
    await act(async () => {
      await flush();
    });
    assert.equal(posts(), 1, "a status change that leaves the method and URL alone must not open a second session");
    assert.equal(deletes(), 0, "the session that made the feed live must not be torn down");
  } finally {
    cleanup();
    g.restore();
  }
});

// ── an external feed always retries; a relay feed's WebRTC verdict expires ──
//
// An external WHEP feed has no HLS to fall back to, so a "WebRTC unusable"
// verdict for it used to leave the widget on "This screen can't play video"
// until the page reloaded — even once the endpoint was healthy again. Every
// such verdict for a non-relay feed is a retry with backoff instead. A relay
// feed does fall back to HLS, and that verdict is not forever either: after
// WEBRTC_RETRY_AFTER_MS on HLS it tries WebRTC again.


/** Each way startPlaybackAttempt can decide WebRTC is unusable, driven to
 *  the point of that decision. */
const UNUSABLE_PATHS: { name: string; drive: (pc: FakePeerConnection, video: FakeVideo) => void }[] = [
  { name: "the post-handshake connect timer", drive: () => mock.timers.tick(CONNECT_TIMEOUT_MS) },
  {
    name: "connected, but no frame in time",
    drive: (pc) => {
      pc.setConnectionState("connected");
      mock.timers.tick(FIRST_FRAME_TIMEOUT_MS);
    },
  },
  { name: "failed before it ever connected", drive: (pc) => pc.setConnectionState("failed") },
  {
    name: "connected, then failed before a frame",
    drive: (pc) => {
      pc.setConnectionState("connected");
      pc.setConnectionState("failed");
    },
  },
  { name: "the <video> element's error before a frame", drive: (_pc, video) => video.fireError() },
];

for (const path of UNUSABLE_PATHS) {
  test(`an external WHEP feed retries, never "webrtc unusable": ${path.name}`, async () => {
    const g = stubGlobals("succeed");
    mock.timers.enable({ apis: ["setTimeout"] });
    const video = new FakeVideo();
    const { calls, cb } = makeCallbacks();
    try {
      startPlaybackAttempt(video as unknown as HTMLVideoElement, { method: "webrtc", url: "http://h/cam/whep", relayManaged: false }, cb);
      await flush();
      path.drive(FakePeerConnection.instances[0]!, video);
      await flush();
      assert.deepEqual(calls.filter((c) => c.fn !== "onPhase").map((c) => c.fn), ["onDropped"]);
    } finally {
      mock.timers.reset();
      g.restore();
    }
  });

  test(`a relay feed still falls back to HLS: ${path.name}`, async () => {
    const g = stubGlobals("succeed");
    mock.timers.enable({ apis: ["setTimeout"] });
    const video = new FakeVideo();
    const { calls, cb } = makeCallbacks();
    try {
      startPlaybackAttempt(video as unknown as HTMLVideoElement, { method: "webrtc", url: "/video/p/whep", relayManaged: true }, cb);
      await flush();
      path.drive(FakePeerConnection.instances[0]!, video);
      await flush();
      assert.deepEqual(calls.filter((c) => c.fn !== "onPhase").map((c) => c.fn), ["onWebrtcUnusable"]);
    } finally {
      mock.timers.reset();
      g.restore();
    }
  });
}

test("through the hook: an external WHEP feed that never connects shows Offline and retries, never can't-play", async () => {
  const g = stubGlobals("succeed");
  mock.timers.enable({ apis: ["setTimeout"] });
  const video = new FakeVideo();
  try {
    const { result } = renderHook(() =>
      useVideoSession({ active: true, feed: EXTERNAL_WHEP, feedDeleted: false, video: video as unknown as HTMLVideoElement, allowHls: true, relayRunning: true }),
    );
    await act(async () => {
      await flush();
    });
    act(() => {
      mock.timers.tick(CONNECT_TIMEOUT_MS);
    });
    assert.equal(result.current.phase, "offline", "an external feed with no fallback must wait to retry, not give up");

    await act(async () => {
      mock.timers.tick(RETRY_MIN_MS);
      await flush();
    });
    const posts = g.calls.filter((c) => c.method === "POST");
    assert.equal(posts.length, 2, "expected a second WHEP attempt after the backoff");
    assert.equal(result.current.phase, "connecting");
  } finally {
    cleanup();
    mock.timers.reset();
    g.restore();
  }
});

// ── after a fallback, WebRTC is probed beside the HLS picture ──────────────
//
// A relay feed on HLS because WebRTC failed on this screen tries WebRTC again
// every WEBRTC_RETRY_AFTER_MS — with a second session that plays into no
// element, so the HLS picture stays up while it is tried. A probe whose
// frames arrive is adopted as it stands: the picture moves to it with no
// second connection. One that does not is closed, quietly, and tried again.

const RELAY_LIVE: VideoFeedView = {
  id: "f",
  name: "F",
  kind: "pull",
  sourceLine: "",
  source: { kind: "pull", url: "rtsp://x", username: "" },
  play: { via: "relay", whep: "/video/f/whep", hls: "/video/f/index.m3u8" },
  status: { state: "live" },
};

/** browserCaps() asks a jsdom <video>, which plays no HLS, and Node has no
 *  MediaSource: without this the fallback is "can't play", not HLS. */
function allowNativeHls(): () => void {
  const proto = Object.getPrototypeOf(document.createElement("video")) as { canPlayType: (t: string) => string };
  const real = proto.canPlayType;
  proto.canPlayType = () => "maybe";
  return () => {
    proto.canPlayType = real;
  };
}

/** The WHEP POST answers: 415 for the first (the refusal that falls back to
 *  HLS), then whatever `later` says. */
function refuseFirstThen(later: FetchBehavior): () => FetchBehavior {
  let posts = 0;
  return () => (++posts === 1 ? { status: 415 } : later);
}

function renderRelaySession(video: FakeVideo, logs: string[]) {
  return renderHook(() =>
    useVideoSession({
      active: true,
      feed: RELAY_LIVE,
      feedDeleted: false,
      video: video as unknown as HTMLVideoElement,
      allowHls: true,
      relayRunning: true,
      onLog: (r) => logs.push(r),
    }),
  );
}

test("a relay feed on HLS probes WebRTC every WEBRTC_RETRY_AFTER_MS without taking the HLS picture down, and logs the fallback once", async () => {
  const g = stubGlobals({ status: 415 });
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const undoHls = allowNativeHls();
  const video = new FakeVideo();
  const logs: string[] = [];
  const whepPosts = () => g.calls.filter((c) => c.method === "POST" && c.url.endsWith("/whep")).length;
  const unusableLines = () => logs.filter((l) => l.includes("unusable")).length;
  try {
    const { result } = renderRelaySession(video, logs);
    await act(async () => {
      await flush();
    });
    act(() => video.fireFrame());
    assert.equal(whepPosts(), 1);
    assert.equal(video.src, "/video/f/index.m3u8", "expected the refusal to fall back to HLS");
    assert.equal(result.current.phase, "delayed");
    assert.equal(unusableLines(), 1);

    await act(async () => {
      mock.timers.tick(WEBRTC_RETRY_AFTER_MS - 1);
      await flush();
    });
    assert.equal(whepPosts(), 1, "WebRTC must not be tried again before WEBRTC_RETRY_AFTER_MS");

    for (const round of [2, 3]) {
      await act(async () => {
        mock.timers.tick(round === 2 ? 1 : WEBRTC_RETRY_AFTER_MS);
        await flush();
      });
      assert.equal(whepPosts(), round, `expected WebRTC probed again, round ${round}`);
      assert.equal(video.src, "/video/f/index.m3u8", "the HLS picture must stay up while WebRTC is probed");
      assert.equal(video.srcSets, 1, "HLS must not be restarted by a probe");
      assert.equal(result.current.phase, "delayed", "the widget keeps showing the HLS picture");
      assert.equal(unusableLines(), 1, "a probe that fails again is not news — the fallback was logged once");
    }
  } finally {
    // Unmounted while the stubs are still in: the teardown's DELETE and its
    // cap timer must land on the stubbed fetch and the fake clock, not leak
    // a real timer into the next test.
    cleanup();
    undoHls();
    mock.timers.reset();
    g.restore();
  }
});

test("a probe whose frames arrive is adopted: the picture moves to that session with no second connection", async () => {
  const g = stubGlobals(refuseFirstThen("succeed"));
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const undoHls = allowNativeHls();
  const probeStream = { id: "probe-stream" };
  const video = new FakeVideo();
  const logs: string[] = [];
  const whepPosts = () => g.calls.filter((c) => c.method === "POST" && c.url.endsWith("/whep")).length;
  try {
    const { result } = renderRelaySession(video, logs);
    await act(async () => {
      await flush();
    });
    act(() => video.fireFrame());
    assert.equal(result.current.phase, "delayed");

    FakePeerConnection.trackStream = probeStream;
    await act(async () => {
      mock.timers.tick(WEBRTC_RETRY_AFTER_MS);
      await flush();
    });
    assert.equal(whepPosts(), 2, "expected the probe's own POST");
    const probe = FakePeerConnection.instances.at(-1)!;
    assert.equal(video.src, "/video/f/index.m3u8", "no frame through the probe yet: HLS stays up");
    assert.equal(result.current.phase, "delayed");

    probe.framesReceived = 4;
    await act(async () => {
      mock.timers.tick(PROBE_POLL_MS);
      await flush();
      await flush();
    });
    assert.equal(video.srcObject, probeStream, "expected the picture moved onto the probe's own stream");
    assert.equal(video.src, "", "expected HLS stopped once WebRTC carries the picture");
    assert.notEqual(
      result.current.phase,
      "connecting",
      "an adopted session is already carrying frames: no Connecting cover while the element picks it up",
    );
    assert.equal(whepPosts(), 2, "the probe's session is the one kept — no second connection");
    assert.equal(g.calls.filter((c) => c.method === "DELETE").length, 0, "the adopted session must not be torn down");
    assert.equal(probe.closed, false);

    act(() => video.fireFrame());
    assert.equal(result.current.phase, "live");
  } finally {
    // Unmounted while the stubs are still in: the teardown's DELETE and its
    // cap timer must land on the stubbed fetch and the fake clock, not leak
    // a real timer into the next test.
    cleanup();
    undoHls();
    mock.timers.reset();
    g.restore();
  }
});

test("an adopted session that then shows no frame goes back to HLS without logging the fallback a second time", async () => {
  const g = stubGlobals(refuseFirstThen("succeed"));
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const undoHls = allowNativeHls();
  const video = new FakeVideo();
  const logs: string[] = [];
  try {
    const { result } = renderRelaySession(video, logs);
    await act(async () => {
      await flush();
    });
    act(() => video.fireFrame());
    FakePeerConnection.trackStream = { id: "probe-stream" };
    await act(async () => {
      mock.timers.tick(WEBRTC_RETRY_AFTER_MS);
      await flush();
    });
    const probe = FakePeerConnection.instances.at(-1)!;
    probe.connectionState = "connected";
    probe.framesReceived = 4;
    await act(async () => {
      mock.timers.tick(PROBE_POLL_MS);
      await flush();
      await flush();
    });
    assert.equal(video.src, "", "expected the picture moved onto the adopted session");

    // The adopted session's frames never reach this element.
    await act(async () => {
      mock.timers.tick(FIRST_FRAME_TIMEOUT_MS);
      await flush();
    });
    assert.equal(video.src, "/video/f/index.m3u8", "expected HLS back once the adopted session showed nothing");
    assert.equal(result.current.phase, "connecting");
    assert.equal(
      logs.filter((l) => l.includes("unusable")).length,
      1,
      "the same outage is not logged twice: WebRTC never held in between",
    );
  } finally {
    cleanup();
    undoHls();
    mock.timers.reset();
    g.restore();
  }
});

test("a probe that never sees a frame closes its session within PROBE_TIMEOUT_MS, and HLS plays on", async () => {
  const g = stubGlobals(refuseFirstThen("succeed"));
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const undoHls = allowNativeHls();
  const video = new FakeVideo();
  const logs: string[] = [];
  const whepPosts = () => g.calls.filter((c) => c.method === "POST" && c.url.endsWith("/whep")).length;
  try {
    const { result } = renderRelaySession(video, logs);
    await act(async () => {
      await flush();
    });
    act(() => video.fireFrame());
    await act(async () => {
      mock.timers.tick(WEBRTC_RETRY_AFTER_MS);
      await flush();
    });
    assert.equal(whepPosts(), 2);
    await act(async () => {
      mock.timers.tick(PROBE_TIMEOUT_MS);
      await flush();
    });
    assert.equal(g.calls.filter((c) => c.method === "DELETE").length, 1, "expected the failed probe's session DELETEd");
    assert.equal(video.src, "/video/f/index.m3u8");
    assert.equal(video.srcSets, 1, "HLS must not be restarted by a failed probe");
    assert.equal(result.current.phase, "delayed");
    assert.equal(logs.filter((l) => l.includes("unusable")).length, 1);

    await act(async () => {
      mock.timers.tick(WEBRTC_RETRY_AFTER_MS);
      await flush();
    });
    assert.equal(whepPosts(), 3, "expected the next probe a full WEBRTC_RETRY_AFTER_MS later");
  } finally {
    // Unmounted while the stubs are still in: the teardown's DELETE and its
    // cap timer must land on the stubbed fetch and the fake clock, not leak
    // a real timer into the next test.
    cleanup();
    undoHls();
    mock.timers.reset();
    g.restore();
  }
});

// ── HLS: its failures, its delayed phase, and a superseded attempt ──────────

test("a fatal hls.js error drops the attempt (retried), never a webrtc verdict", async () => {
  const undoHls = installFakeHls();
  const video = new FakeVideo();
  const { calls, cb } = makeCallbacks();
  try {
    startPlaybackAttempt(video as unknown as HTMLVideoElement, { method: "hls", url: "/video/p/index.m3u8" }, cb);
    await flush();
    FakeHls.last!.raise({ fatal: true, details: "manifestLoadError", type: "networkError" });
    assert.deepEqual(calls.filter((c) => c.fn !== "onPhase"), [{ fn: "onDropped", arg: "hls.js: manifestLoadError" }]);
    assert.equal(FakeHls.last!.calls.at(-1), "destroy", "the failed hls.js instance must be destroyed");
  } finally {
    undoHls();
  }
});

test("the <video> element's own error drops a native HLS attempt", async () => {
  const video = new FakeVideo();
  const { calls, cb } = makeCallbacks();
  startPlaybackAttempt(video as unknown as HTMLVideoElement, { method: "hls", url: "/video/p/index.m3u8" }, cb);
  await flush();
  assert.equal(video.src, "/video/p/index.m3u8", "expected the native branch (Node has no MediaSource)");
  video.fireError();
  assert.deepEqual(calls.filter((c) => c.fn !== "onPhase"), [{ fn: "onDropped", arg: "the <video> element reported an error" }]);
  assert.equal(video.src, "", "the native source must be detached");
});

test("an HLS frame is the delayed phase, with hls.js's latency rounded for the badge", async () => {
  const undoHls = installFakeHls();
  mock.timers.enable({ apis: ["setInterval"] });
  const video = new FakeVideo();
  const { calls, cb } = makeCallbacks();
  try {
    const attempt = startPlaybackAttempt(video as unknown as HTMLVideoElement, { method: "hls", url: "/video/p/index.m3u8" }, cb);
    await flush();
    video.fireFrame();
    assert.deepEqual(calls, [
      { fn: "onPhase", arg: "connecting" },
      { fn: "onPhase", arg: "delayed" },
      { fn: "onLatency", arg: "3" },
    ]);
    FakeHls.last!.latency = 5.6;
    mock.timers.tick(1000);
    assert.deepEqual(calls.at(-1), { fn: "onLatency", arg: "6" }, "the badge follows hls.js's latency every second");
    attempt.stop();
  } finally {
    mock.timers.reset();
    undoHls();
  }
});

test("a WHEP attempt stopped while its answer is applied still DELETEs the session it created", async () => {
  const g = stubGlobals("succeed");
  const video = new FakeVideo();
  const { calls, cb } = makeCallbacks();
  try {
    let attempt: ReturnType<typeof startPlaybackAttempt> | undefined;
    // The caller moves on (a new feed, the widget off screen) after the relay
    // answered 201 but before the answer was applied: the session exists on
    // the relay, and the attempt that owns it has already ended.
    FakePeerConnection.onSetRemoteDescription = () => attempt?.stop();
    attempt = startPlaybackAttempt(video as unknown as HTMLVideoElement, { method: "webrtc", url: "/video/p/whep", relayManaged: true }, cb);
    await flush();
    await flush();
    assert.equal(g.calls.filter((c) => c.method === "DELETE").length, 1, "the superseded session was left on the relay");
    assert.equal(FakePeerConnection.instances[0]!.closed, true);
    assert.deepEqual(calls.filter((c) => c.fn !== "onPhase"), [], "a superseded attempt reports nothing");
  } finally {
    g.restore();
  }
});

test("an HLS attempt stopped while hls.js is still loading destroys the instance it then builds", async () => {
  let loaded!: () => void;
  const gate = new Promise<void>((resolve) => (loaded = resolve));
  const undoHls = installFakeHls(async () => {
    await gate;
    return { default: FakeHls };
  });
  const video = new FakeVideo();
  const { calls, cb } = makeCallbacks();
  try {
    const attempt = startPlaybackAttempt(video as unknown as HTMLVideoElement, { method: "hls", url: "/video/p/index.m3u8" }, cb);
    attempt.stop();
    loaded();
    await flush();
    assert.deepEqual(FakeHls.last?.calls, ["loadSource /video/p/index.m3u8", "attachMedia", "destroy"]);
    assert.deepEqual(calls.filter((c) => c.fn !== "onPhase"), []);
  } finally {
    undoHls();
  }
});

// ── sample(): the hook's own stats report ─────────────────────────────────
//
// Whichever session the WIDGET is showing, never a probe's — a probe plays
// into an element nobody mounts and never fires AttemptCallbacks.onSession at
// all, so it never installs a sampler in the first place. Proven below by
// driving the same probe/adopt sequence the tests above use and checking
// `sample()`'s `via` through it, not by asserting anything about probeWebrtc
// directly.

test("sample() resolves null before any session exists yet", async () => {
  const g = stubGlobals("hang");
  const video = new FakeVideo();
  try {
    const { result } = renderHook(() =>
      useVideoSession({ active: true, feed: EXTERNAL_WHEP, feedDeleted: false, video: video as unknown as HTMLVideoElement, allowHls: true, relayRunning: true }),
    );
    assert.equal(await result.current.sample(), null, "the handshake has not even been sent yet");
  } finally {
    cleanup();
    g.restore();
  }
});

test("sample() reports a live webrtc session's stats: feedId, via, deltas and current frame size", async () => {
  const g = stubGlobals("succeed");
  const video = new FakeVideo();
  try {
    const { result } = renderHook(() =>
      useVideoSession({ active: true, feed: EXTERNAL_WHEP, feedDeleted: false, video: video as unknown as HTMLVideoElement, allowHls: true, relayRunning: true }),
    );
    await act(async () => {
      await flush();
    });
    const pc = FakePeerConnection.instances.at(-1)!;
    act(() => {
      pc.setConnectionState("connected");
      video.fireFrame();
    });
    assert.equal(result.current.phase, "live");

    pc.framesDecoded = 30;
    pc.framesDropped = 1;
    pc.frameWidth = 1280;
    pc.frameHeight = 720;
    const first = await result.current.sample();
    assert.deepEqual(first, { feedId: "cam", via: "webrtc", decoded: 30, dropped: 1, stalls: 0, width: 1280, height: 720 });

    pc.framesDecoded = 90;
    pc.framesDropped = 2;
    const second = await result.current.sample();
    assert.deepEqual(
      second,
      { feedId: "cam", via: "webrtc", decoded: 60, dropped: 1, stalls: 0, width: 1280, height: 720 },
      "expected the delta since the FIRST sample, not the running total",
    );
  } finally {
    cleanup();
    g.restore();
  }
});

test("a probe beside a live HLS picture is never sampled: sample() stays via 'hls' through the whole probing window, and flips to 'webrtc' with fresh counters only once adopted", async () => {
  const g = stubGlobals(refuseFirstThen("succeed")); // the first POST refuses (falls back to HLS); the probe's own POST must succeed to be adoptable
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const undoHls = allowNativeHls();
  const probeStream = { id: "probe-stream" };
  const video = new FakeVideo();
  const logs: string[] = [];
  try {
    const { result } = renderRelaySession(video, logs);
    await act(async () => {
      await flush();
    });
    act(() => video.fireFrame()); // HLS live: "delayed"
    assert.equal(result.current.phase, "delayed");

    // HLS's own sampler is installed; give it something to report so a
    // regression that stops sampling HLS entirely would also show here.
    video.decodedFrames = 12;
    const beforeProbe = await result.current.sample();
    assert.equal(beforeProbe?.via, "hls");
    assert.equal(beforeProbe?.decoded, 12);

    FakePeerConnection.trackStream = probeStream;
    await act(async () => {
      mock.timers.tick(WEBRTC_RETRY_AFTER_MS); // starts the probe
      await flush();
    });
    const probe = FakePeerConnection.instances.at(-1)!;
    // The probe's own peer connection reports frames a webrtc sampler would
    // read as huge counts — proof, if `sample()` ever reads THIS pc while it
    // is still only a probe, that the guard failed.
    probe.framesDecoded = 9999;
    probe.framesDropped = 500;
    assert.equal((await result.current.sample())?.via, "hls", "a running probe must not be sampled");
    assert.equal((await result.current.sample())?.decoded, 0, "the probe's huge counters must not leak into the HLS report");

    // The probe's frames arrive: it is adopted, and the picture moves to it.
    probe.framesReceived = 4;
    await act(async () => {
      mock.timers.tick(PROBE_POLL_MS);
      await flush();
      await flush();
    });
    assert.equal(video.srcObject, probeStream, "expected the picture moved onto the probe's stream");

    // The adopted session is a NEW attempt: a fresh sampler, counters at
    // zero — not the huge numbers the probe was already carrying. `9999` is
    // an exaggerated stand-in to make the mechanism obvious here; in
    // production the real backlog at adoption is bounded by the probe's own
    // poll (PROBE_POLL_MS = 500ms — it adopts the instant that poll sees any
    // frame at all), so it is on the order of half a second of frames, not
    // this test's magnitude.
    const afterAdopt = await result.current.sample();
    assert.equal(afterAdopt?.via, "webrtc", "expected the swap to webrtc reflected in the report");
    assert.equal(afterAdopt?.decoded, 9999, "the first read of a NEW sampler is its own baseline, not a delta against nothing");
    const nextSample = await result.current.sample();
    assert.equal(nextSample?.decoded, 0, "expected the SECOND read to be a delta since the first, not the running total again");
  } finally {
    cleanup();
    undoHls();
    mock.timers.reset();
    g.restore();
  }
});
