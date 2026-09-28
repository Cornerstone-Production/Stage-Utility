// renderer/main/video/use-video-session.test.ts — startPlaybackAttempt's state
// machine, driven directly with a fake RTCPeerConnection dispatching a real
// `connectionstatechange` event (it extends the real EventTarget, so
// `{ signal }` listener removal is the real thing, not a simulation of it), a
// fake <video> handing back a stored requestVideoFrameCallback, and
// node:test's fake timers for the connect, first-frame, drop-grace and
// backoff windows — plus one test that renders `useVideoSession` itself (via
// `renderHook`), for the backoff-reset behaviour that only exists at the
// hook layer and cannot be proven against `startPlaybackAttempt` alone.
//
// `NodeEvent` is captured before jsdom is installed below, and used for
// every `dispatchEvent(new NodeEvent(...))` in this file: jsdom's own
// `Event`/`AbortSignal` are DIFFERENT CLASSES from Node's (structurally
// identical, not `instanceof`-equal), and `FakePeerConnection extends
// EventTarget` here is Node's own EventTarget — dispatching jsdom's `Event`
// into it throws "parameter 1 is not of type 'Event'".
const NodeEvent = globalThis.Event;

import { strict as assert } from "node:assert";
import { after, afterEach, mock, test } from "node:test";

import type { VideoFeedView } from "@main/types/video";
import { installRenderDom, unmountAndTeardown } from "../../test-dom.js";

const teardown = installRenderDom();

import {
  CONNECT_TIMEOUT_MS,
  DROP_GRACE_MS,
  FIRST_FRAME_TIMEOUT_MS,
  RETRY_MIN_MS,
  startPlaybackAttempt,
  useVideoSession,
} from "./use-video-session.js";
const { renderHook, act, cleanup } = await import("@testing-library/react");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

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
  getVideoPlaybackQuality(): { totalVideoFrames: number } {
    return { totalVideoFrames: 0 };
  }
  /** Simulates the browser delivering a decoded frame. */
  fireFrame(): void {
    this.frameCb?.();
  }
}

class FakePeerConnection extends EventTarget {
  static instances: FakePeerConnection[] = [];
  iceGatheringState = "complete";
  connectionState: RTCPeerConnectionState = "new";
  localDescription: { sdp: string } | null = null;
  remoteDescription: unknown = null;
  ontrack: unknown = null;
  closed = false;
  constructor() {
    super();
    FakePeerConnection.instances.push(this);
  }
  addTransceiver(): void {}
  async createOffer(): Promise<{ type: "offer"; sdp: string }> {
    return { type: "offer", sdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n" };
  }
  async setLocalDescription(desc: { sdp: string }): Promise<void> {
    this.localDescription = desc;
  }
  async setRemoteDescription(desc: unknown): Promise<void> {
    this.remoteDescription = desc;
  }
  close(): void {
    this.closed = true;
  }
  /** Test helper: flips connectionState and fires the real event. */
  setConnectionState(s: RTCPeerConnectionState): void {
    this.connectionState = s;
    this.dispatchEvent(new NodeEvent("connectionstatechange"));
  }
}

function stubPeerConnection(): void {
  (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection = FakePeerConnection;
}

type FetchBehavior = "succeed" | "reject" | "hang" | { status: number };

/** Every fetch call, and which promises are still pending (never resolved
 *  unless the test settles them) — for proving a hung POST is bounded by the
 *  connect timeout rather than left open forever. `getHangingSignal()` is for
 *  proving the connect timeout actually ABORTS the hung request's own
 *  signal, not merely its own app-level callback. */
function stubFetch(behavior: FetchBehavior) {
  const calls: { method: string; url: string }[] = [];
  let hangingSignal: AbortSignal | undefined;
  const fn = (async (input: string | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url: String(input) });
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
      text: async () => "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n",
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
function stubGlobals(behavior: FetchBehavior) {
  const { fn, calls, getHangingSignal } = stubFetch(behavior);
  const realFetch = globalThis.fetch;
  const realPc = (globalThis as unknown as { RTCPeerConnection?: unknown }).RTCPeerConnection;
  globalThis.fetch = fn;
  stubPeerConnection();
  return {
    calls,
    getHangingSignal,
    restore() {
      globalThis.fetch = realFetch;
      (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection = realPc;
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
  FakePeerConnection.instances.length = 0;
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
    // "maybe"/"probably" takes startHls's NATIVE branch (`video.src = url`):
    // real hls.js is never imported, so there is no internal Hls instance
    // left running past this test that a cleanup would need to reach for.
    // An ABSENT canPlayType is a different case entirely — it throws, since
    // startHls calls it unconditionally.
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

// ── the backoff counter resets on a first frame ──────────────────────────
//
// Only provable through `useVideoSession` itself — the backoff EXPONENT is
// held in the hook's own `attemptCountRef`, across repeated calls to
// `startPlaybackAttempt`, which a test of that function alone cannot see.

test("the backoff counter resets after a first frame, not just after the FIRST drop", async () => {
  const g = stubGlobals("succeed");
  mock.timers.enable({ apis: ["setTimeout"] });
  const logs: string[] = [];
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
  try {
    renderHook(() =>
      useVideoSession({
        active: true,
        feed,
        feedDeleted: false,
        video: video as unknown as HTMLVideoElement,
        allowHls: true,
        onLog: (r) => logs.push(r),
      }),
    );
    // Two full rounds: connect, get a frame (this is what SHOULD reset the
    // counter), then drop. If the reset never happened, the second round's
    // drop would log RETRY_MIN_MS * 2 (2000ms), not RETRY_MIN_MS (1000ms).
    for (let round = 0; round < 2; round++) {
      await act(async () => {
        await flush();
      });
      const pc = FakePeerConnection.instances.at(-1)!;
      act(() => {
        pc.setConnectionState("connected");
        video.fireFrame();
      });
      act(() => {
        pc.setConnectionState("failed");
        mock.timers.tick(DROP_GRACE_MS);
      });
      act(() => {
        mock.timers.tick(RETRY_MIN_MS * 4); // comfortably past either possible delay
      });
    }

    assert.match(logs[0]!, /retrying in 1000ms/, "expected the first drop to retry at RETRY_MIN_MS");
    assert.match(
      logs[1]!,
      /retrying in 1000ms/,
      "a drop after a FRESH first frame must restart the backoff at RETRY_MIN_MS, not carry the previous round's exponent forward",
    );
  } finally {
    mock.timers.reset();
    g.restore();
  }
});

