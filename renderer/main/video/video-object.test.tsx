// renderer/main/video/video-object.test.tsx — the widget's gates and states,
// driven through the REAL component with a stubbed fetch, RTCPeerConnection
// and IntersectionObserver — never a unit test of the boolean logic in
// isolation, because the bug each of these guards is what a screen SHOWS or
// SENDS, not what a helper returns.
//
// NOT covered here, and why: jsdom loads no stylesheet and reports every
// offsetHeight/getBoundingClientRect as zero, so the corner name-tag's
// placement, the "N s behind" badge's position, and the connecting pulse's
// animation are unverifiable from this file. Checked in a real browser
// instead (see task-5-report.md) rather than asserted here against numbers
// jsdom cannot produce.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, mock, test } from "node:test";

import { act } from "react";

import { installRenderDom, settle, unmountAndTeardown } from "../../test-dom.js";

const teardown = installRenderDom();

const { render, screen, cleanup } = await import("@testing-library/react");
const React = await import("react");
const { VideoObject } = await import("./video-object.js");
const { __resetReplayCacheForTests } = await import("../../lib/api.js");

// VideoState/VideoFeedView are NOT ambient globals (unlike LayoutObject and
// LayoutObjectConfig, aliased in renderer/types.d.ts from main/types/stage —
// main/types/video.ts is not one of that file's re-exports), so these are
// real imports.
type VideoState = import("@main/types/video").VideoState;
type VideoFeedView = import("@main/types/video").VideoFeedView;

after(() => unmountAndTeardown(cleanup, teardown));

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeFeed(overrides: Partial<VideoFeedView> = {}): VideoFeedView {
  return {
    id: "feed-1",
    name: "Program (IMAG)",
    kind: "pull",
    sourceLine: "rtsp://10.0.40.21:8554/stream2",
    source: { kind: "pull", url: "rtsp://10.0.40.21:8554/stream2", username: "" },
    play: { via: "relay", whep: "/video/feed-1/whep", hls: "/video/feed-1/index.m3u8" },
    status: { state: "live" },
    ...overrides,
  };
}

function makeState(feeds: VideoFeedView[]): VideoState {
  return {
    rev: 1,
    relay: { state: "running", version: "1.21.1", ports: { rtmp: 1935, srt: 8890, webrtcUdp: 8189, webrtcHttp: 8889, hls: 8888, api: 9997 } },
    kinds: ["pull", "push", "embed", "external"],
    feeds,
  };
}

type VideoConfig = Extract<LayoutObjectConfig, { type: "video" }>;

/** Both the LayoutObject and its own already-narrowed config, typed as
 *  VideoObject's props actually want them — no `as` cast at the call site. */
function makeObject(overrides: Partial<VideoConfig> = {}): { o: LayoutObject; config: VideoConfig } {
  const config: VideoConfig = { type: "video", feedId: "feed-1", ...overrides };
  return { o: { id: "obj-1", x: 0, y: 0, w: 1, h: 1, z: 0, config }, config };
}

/** Every call the widget makes, in order, for a test to inspect. */
function stubFetch(state: VideoState) {
  const calls: { method: string; url: string }[] = [];
  const fn = (async (input: string | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const url = String(input);
    calls.push({ method, url });
    if (url.endsWith("/api/video/state")) {
      return { ok: true, status: 200, json: async () => state, text: async () => "" } as unknown as Response;
    }
    if (method === "POST" && url.includes("/whep")) {
      return {
        ok: true,
        status: 201,
        headers: { get: (h: string) => (h === "Location" ? `${url}/1f2e3d4c` : null) },
        text: async () => "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n",
        json: async () => ({}),
      } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" } as unknown as Response;
  }) as typeof fetch;
  return { fn, calls };
}

/** A no-op RTCPeerConnection: enough for startWhep's offer/answer exchange to
 *  complete without ever reaching "connected" — these tests only assert what
 *  was SENT (a POST, a DELETE), never the connection state machine. */
class FakePeerConnection {
  iceGatheringState = "complete";
  connectionState: RTCPeerConnectionState = "new";
  localDescription: { sdp: string } | null = null;
  remoteDescription: unknown = null;
  ontrack: unknown = null;
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
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}

/** The one stubbed IntersectionObserver, handing the test its callback — jsdom
 *  ships no IntersectionObserver at all, so without this useOnScreen's whole
 *  body is skipped and nothing here would ever go on screen. */
class StubObserver {
  static last: StubObserver | null = null;
  readonly cb: (entries: { isIntersecting: boolean }[]) => void;
  constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
    this.cb = cb;
    StubObserver.last = this;
  }
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}

function stubGlobals(state: VideoState) {
  const { fn, calls } = stubFetch(state);
  const realFetch = globalThis.fetch;
  const realPc = (globalThis as unknown as { RTCPeerConnection?: unknown }).RTCPeerConnection;
  const realIo = (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
  globalThis.fetch = fn;
  (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection = FakePeerConnection;
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = StubObserver;
  return {
    calls,
    restore() {
      globalThis.fetch = realFetch;
      (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection = realPc;
      (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = realIo;
    },
  };
}

const whepCalls = (calls: { method: string; url: string }[]) => calls.filter((c) => c.url.includes("/whep") && c.method !== "GET");

/**
 * `settle()` (test-dom.ts) awaits a REAL `setTimeout(…, 0)` to hand off to
 * React's scheduler — which hangs forever once `mock.timers.enable({ apis:
 * ["setTimeout"] })` is active, because a fake timer only fires on an
 * explicit `tick()`. `setImmediate` is a different API, left un-mocked, so
 * this drains the same real macrotask queue without depending on the clock
 * these tests are busy controlling.
 */
async function settleFake(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setImmediate(resolve));
  });
}

beforeEach(() => {
  cleanup();
  __resetReplayCacheForTests();
  StubObserver.last = null;
});
afterEach(() => cleanup());

// ── Tests ────────────────────────────────────────────────────────────────────

test("preview route: paused, and nothing is requested until Play is pressed", async () => {
  const originalPath = window.location.pathname;
  history.pushState({}, "", "/preview-abc");
  const g = stubGlobals(makeState([makeFeed()]));
  try {
    render(React.createElement(VideoObject, { ...makeObject(), appLogo: null, appLogoMonochrome: false }));
    await settle();
    await settle();

    assert.equal(!!screen.queryByText("Video paused in preview"), true, "expected the preview-paused copy");
    assert.deepEqual(whepCalls(g.calls), [], "expected no request to a feed's playback endpoint before Play is pressed");

    const play = screen.getByText("Play");
    act(() => play.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    // Play only lifts the preview gate; the on-screen gate is separate, so this
    // still needs an intersecting observer before a request can go out.
    act(() => StubObserver.last?.cb([{ isIntersecting: true }]));
    await settle();
    await settle();

    assert.ok(whepCalls(g.calls).length > 0, "expected Play to start the session it had withheld");
  } finally {
    g.restore();
    history.pushState({}, "", originalPath);
  }
});

test("off screen: no request; on screen: one POST; off again past the teardown: the session is DELETEd", async () => {
  const g = stubGlobals(makeState([makeFeed()]));
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    render(React.createElement(VideoObject, { ...makeObject(), appLogo: null, appLogoMonochrome: false }));
    await settleFake();
    await settleFake();

    assert.deepEqual(whepCalls(g.calls), [], "expected no request while off screen");

    act(() => StubObserver.last?.cb([{ isIntersecting: true }]));
    await settleFake();
    await settleFake();

    assert.equal(whepCalls(g.calls).filter((c) => c.method === "POST").length, 1, "expected exactly one POST once on screen");

    act(() => StubObserver.last?.cb([{ isIntersecting: false }]));
    act(() => {
      mock.timers.tick(3000);
    });
    await settleFake();
    await settleFake();

    assert.equal(
      whepCalls(g.calls).filter((c) => c.method === "DELETE").length,
      1,
      "expected the session DELETEd once the teardown delay passed off screen",
    );
  } finally {
    mock.timers.reset();
    g.restore();
  }
});

test("a hidden document behaves like off screen", async () => {
  const g = stubGlobals(makeState([makeFeed()]));
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    render(React.createElement(VideoObject, { ...makeObject(), appLogo: null, appLogoMonochrome: false }));
    await settleFake();
    await settleFake();

    act(() => StubObserver.last?.cb([{ isIntersecting: true }]));
    await settleFake();
    await settleFake();
    assert.equal(whepCalls(g.calls).filter((c) => c.method === "POST").length, 1, "expected the on-screen POST first");

    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    act(() => {
      mock.timers.tick(3000);
    });
    await settleFake();
    await settleFake();

    assert.equal(
      whepCalls(g.calls).filter((c) => c.method === "DELETE").length,
      1,
      "expected a hidden document to tear the session down exactly like scrolling off screen",
    );
  } finally {
    mock.timers.reset();
    // `defineProperty` on `document` set an OWN property that shadows the
    // prototype's real getter — restoring a captured prototype descriptor
    // would not have undone that. Deleting the own property does.
    delete (document as unknown as { visibilityState?: unknown }).visibilityState;
    g.restore();
  }
});

test("an embed feed renders an iframe with mute=1 and no <video>", async () => {
  const feed = makeFeed({
    kind: "embed",
    source: { kind: "embed", player: "youtube-channel", ref: "UCabcdefghijklmnopqrstuv" },
    play: { via: "embed", src: "https://www.youtube.com/embed/live_stream?channel=UCabcdefghijklmnopqrstuv&autoplay=1&mute=1&controls=0&playsinline=1" },
    status: { state: "embed" },
  });
  const g = stubGlobals(makeState([feed]));
  try {
    const { container } = render(
      React.createElement(VideoObject, { ...makeObject(), appLogo: null, appLogoMonochrome: false }),
    );
    await settle();
    await settle();

    act(() => StubObserver.last?.cb([{ isIntersecting: true }]));
    await settle();
    await settle();

    const iframe = container.querySelector("iframe");
    assert.ok(iframe, "expected an iframe for an embed feed");
    assert.ok(iframe?.getAttribute("src")?.includes("mute=1"), "expected the embed src to carry mute=1");
    assert.equal(container.querySelector("video"), null, "an embed feed must render no <video> element");
  } finally {
    g.restore();
  }
});

test("a render error inside the player shows the can't-play state, and a sibling still renders", async () => {
  // A deliberately malformed feed: `play` is null, so reading `feed.play.via`
  // during render throws — a REAL render-phase error, not a simulated one.
  const broken = { ...makeFeed(), play: null as unknown as VideoFeedView["play"] };
  const g = stubGlobals(makeState([broken]));
  const consoleError = console.error;
  console.error = () => {}; // React logs the caught error; expected noise, not a failure
  try {
    render(
      React.createElement(
        "div",
        null,
        React.createElement("span", null, "sibling-marker"),
        React.createElement(VideoObject, { ...makeObject(), appLogo: null, appLogoMonochrome: false }),
      ),
    );
    await settle();
    await settle();

    assert.equal(!!screen.queryByText("sibling-marker"), true, "a sibling must keep rendering beside the failed widget");
    assert.equal(!!screen.queryByText("This screen can't play video"), true, "expected the can't-play fallback");
  } finally {
    console.error = consoleError;
    g.restore();
  }
});
