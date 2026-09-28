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

const teardown = installRenderDom();

import {
  CONNECT_TIMEOUT_MS,
  DROP_GRACE_MS,
  FIRST_FRAME_TIMEOUT_MS,
  RETRY_MIN_MS,
  startPlaybackAttempt,
  useVideoSession,
  WEBRTC_RETRY_AFTER_MS,
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
  /** Simulates the element's own `error` event. */
  fireError(): void {
    this.dispatchEvent(new NodeEvent("error"));
  }
  // What startHls's native branch touches (Node has no MediaSource, so an HLS
  // attempt here always takes it).
  src = "";
  srcObject: unknown = null;
  canPlayType(): string {
    return "maybe";
  }
  removeAttribute(name: string): void {
    if (name === "src") this.src = "";
  }
  load(): void {}
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
function stubGlobals(behavior: FetchBehavior) {
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
      useVideoSession({ active: true, feed, feedDeleted: false, video: video as unknown as HTMLVideoElement, allowHls: true }),
    );
    await act(async () => {
      await flush();
    });
    assert.equal(result.current.phase, "connecting");
    act(() => video.fireFrame());
    assert.equal(result.current.phase, "live");
  } finally {
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
        onLog: (r) => logs.push(r),
      }),
    );
    await act(async () => {
      await flush();
    });

    assert.ok(
      logs.some((l) => l.includes("retrying in")),
      "expected an external feed's refusal to retry — it has no HLS to fall back to",
    );
    assert.equal(
      logs.some((l) => l.includes("unusable")),
      false,
      "an external feed's health cannot be reported, so a refusal there must not be treated as a stream verdict",
    );
  } finally {
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

const EXTERNAL_WHEP: VideoFeedView = {
  id: "cam",
  name: "Cam",
  kind: "external",
  sourceLine: "",
  source: { kind: "external", url: "http://h/cam/whep" },
  play: { via: "external", url: "http://h/cam/whep", protocol: "whep" },
  status: { state: null },
};

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
      useVideoSession({ active: true, feed: EXTERNAL_WHEP, feedDeleted: false, video: video as unknown as HTMLVideoElement, allowHls: true }),
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
    mock.timers.reset();
    g.restore();
  }
});

test("a relay feed on HLS after a WebRTC refusal tries WebRTC again after WEBRTC_RETRY_AFTER_MS", async () => {
  const g = stubGlobals({ status: 415 });
  mock.timers.enable({ apis: ["setTimeout"] });
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
  const whepPosts = () => g.calls.filter((c) => c.method === "POST" && c.url.endsWith("/whep")).length;
  // browserCaps() asks a jsdom <video>, which plays no HLS, and Node has no
  // MediaSource: without this the fallback is "can't play", not HLS.
  const proto = Object.getPrototypeOf(document.createElement("video")) as { canPlayType: (t: string) => string };
  const realCanPlayType = proto.canPlayType;
  proto.canPlayType = () => "maybe";
  try {
    renderHook(() =>
      useVideoSession({ active: true, feed, feedDeleted: false, video: video as unknown as HTMLVideoElement, allowHls: true }),
    );
    await act(async () => {
      await flush();
    });
    assert.equal(whepPosts(), 1);
    assert.equal(video.src, "/video/f/index.m3u8", "expected the refusal to fall back to HLS");

    await act(async () => {
      mock.timers.tick(WEBRTC_RETRY_AFTER_MS - 1);
      await flush();
    });
    assert.equal(whepPosts(), 1, "WebRTC must not be retried before WEBRTC_RETRY_AFTER_MS");

    await act(async () => {
      mock.timers.tick(1);
      await flush();
    });
    assert.equal(whepPosts(), 2, "expected WebRTC tried again once WEBRTC_RETRY_AFTER_MS had passed on HLS");
  } finally {
    proto.canPlayType = realCanPlayType;
    mock.timers.reset();
    g.restore();
  }
});
