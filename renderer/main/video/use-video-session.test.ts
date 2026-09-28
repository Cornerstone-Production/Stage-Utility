// renderer/main/video/use-video-session.test.ts — startPlaybackAttempt's state
// machine, driven directly (no React, no jsdom): a fake RTCPeerConnection
// dispatching real `connectionstatechange`/`error` events (it extends the
// real EventTarget, so `{ signal }` listener removal is the real thing, not a
// simulation of it), a fake <video> handing back a stored
// requestVideoFrameCallback, and node:test's fake timers for the connect,
// first-frame, drop-grace and backoff windows. This is what R-T5a asks the
// structural move into its own file for: none of this needs a DOM to prove.

import { strict as assert } from "node:assert";
import { afterEach, mock, test } from "node:test";

import {
  CONNECT_TIMEOUT_MS,
  DROP_GRACE_MS,
  FIRST_FRAME_TIMEOUT_MS,
  startPlaybackAttempt,
} from "./use-video-session.js";

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
    this.dispatchEvent(new Event("connectionstatechange"));
  }
}

function stubPeerConnection(): void {
  (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection = FakePeerConnection;
}

/** Every fetch call, and which promises are still pending (never resolved
 *  unless the test settles them) — for proving a hung POST is bounded by the
 *  connect timeout rather than left open forever. */
function stubFetch(behavior: "succeed" | "reject" | "hang") {
  const calls: { method: string; url: string }[] = [];
  const fn = (async (input: string | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url: String(input) });
    if (method === "DELETE") return { ok: true, status: 200, headers: { get: () => null }, text: async () => "" } as unknown as Response;
    if (behavior === "reject") throw new Error("fetch failed");
    if (behavior === "hang") {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    return {
      ok: true,
      status: 201,
      headers: { get: (h: string) => (h === "Location" ? "/video/p/whep/abcd" : null) },
      text: async () => "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n",
    } as unknown as Response;
  }) as typeof fetch;
  return { fn, calls };
}

function stubGlobals(behavior: "succeed" | "reject" | "hang") {
  const { fn, calls } = stubFetch(behavior);
  const realFetch = globalThis.fetch;
  const realPc = (globalThis as unknown as { RTCPeerConnection?: unknown }).RTCPeerConnection;
  const realWindow = (globalThis as unknown as { window?: unknown }).window;
  globalThis.fetch = fn;
  stubPeerConnection();
  (globalThis as unknown as { window: unknown }).window = { location: { href: "http://localhost:8788/" } };
  return {
    calls,
    restore() {
      globalThis.fetch = realFetch;
      (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection = realPc;
      (globalThis as unknown as { window: unknown }).window = realWindow;
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
    const attempt = startPlaybackAttempt(video, { method: "webrtc", url: "/video/p/whep" }, cb);
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
    startPlaybackAttempt(video, { method: "webrtc", url: "/video/p/whep" }, cb);
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
    startPlaybackAttempt(video, { method: "webrtc", url: "/video/p/whep" }, cb);
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

test("a POST that never gets a reply is dropped (retried), never marked webrtc-unusable — Important 1", async () => {
  const g = stubGlobals("hang");
  mock.timers.enable({ apis: ["setTimeout"] });
  const video = new FakeVideo() as unknown as HTMLVideoElement & FakeVideo;
  const { calls, cb } = makeCallbacks();
  try {
    startPlaybackAttempt(video, { method: "webrtc", url: "/video/p/whep" }, cb);
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

test("a POST that rejects immediately is dropped (retried) with the real error, not webrtc-unusable — Important 1", async () => {
  const g = stubGlobals("reject");
  const video = new FakeVideo() as unknown as HTMLVideoElement & FakeVideo;
  const { calls, cb } = makeCallbacks();
  try {
    startPlaybackAttempt(video, { method: "webrtc", url: "/video/p/whep" }, cb);
    await flush();

    const dropped = calls.find((c) => c.fn === "onDropped");
    assert.ok(dropped, "expected onDropped, not onWebrtcUnusable, for a rejected POST");
    assert.match(dropped!.arg!, /fetch failed/);
    assert.equal(calls.some((c) => c.fn === "onWebrtcUnusable"), false);
  } finally {
    g.restore();
  }
});

test("disconnected then failed, then a full recovery before the grace period: no spurious drop — Important 5", async () => {
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
    startPlaybackAttempt(video, { method: "webrtc", url: "/video/p/whep" }, cb);
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
    const attempt = startPlaybackAttempt(video, { method: "webrtc", url: "/video/p/whep" }, cb);
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
