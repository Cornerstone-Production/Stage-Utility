// renderer/main/video/video-object.test.tsx — the widget's gates and states,
// driven through the REAL component with a stubbed fetch, RTCPeerConnection
// and IntersectionObserver — never a unit test of the boolean logic in
// isolation, because the bug each of these guards is what a screen SHOWS or
// SENDS, not what a helper returns.
//
// NOT covered here, and why: jsdom loads no stylesheet and reports every
// offsetHeight/getBoundingClientRect as zero, so the corner name-tag's
// placement, the "N s behind" badge's position, and the connecting pulse's
// animation are unverifiable from this file — and were NOT checked in a real
// browser either in this round; that is a real gap, said plainly rather than
// implied to be covered somewhere it is not (see task-5-report.md).

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, mock, test } from "node:test";

import { act } from "react";

import { installRenderDom, settle, unmountAndTeardown } from "../../test-dom.js";
import { FAKE_SDP, FakePeerConnection, installFakePeerConnection } from "../../test-fixtures/fake-peer-connection.js";

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
    sourceLine: "rtsp://192.0.2.21:8554/stream2",
    source: { kind: "pull", url: "rtsp://192.0.2.21:8554/stream2", username: "" },
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
        text: async () => FAKE_SDP,
        json: async () => ({}),
      } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" } as unknown as Response;
  }) as typeof fetch;
  return { fn, calls };
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
  const realIo = (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
  const realAbortController = globalThis.AbortController;
  const realAbortSignal = globalThis.AbortSignal;
  globalThis.fetch = fn;
  const restorePc = installFakePeerConnection();
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = StubObserver;
  // jsdom's OWN AbortController/AbortSignal, not Node's: a jsdom-rendered
  // <video>'s addEventListener validates a `{ signal }` option's realm, and
  // the widget's real playback code builds `new AbortController()` from
  // whatever is on globalThis at the time — Node's version is structurally
  // identical but fails jsdom's `instanceof AbortSignal` check, so every
  // attempt appeared to "drop" instantly with that exact message. Scoped to
  // THIS test file rather than test-dom.ts: swapping it there broke an
  // unrelated clock test elsewhere in the suite in a way this file's narrow
  // fix does not.
  globalThis.AbortController = window.AbortController;
  globalThis.AbortSignal = window.AbortSignal;
  return {
    calls,
    restore() {
      globalThis.fetch = realFetch;
      restorePc();
      (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = realIo;
      globalThis.AbortController = realAbortController;
      globalThis.AbortSignal = realAbortSignal;
    },
  };
}

// Every request to a FEED's playback endpoint — not only a WHEP POST/DELETE,
// so a future HLS or other /video/<id>/... call is caught by the same
// assertion — excluding the state-list read, which legitimately fires
// regardless of the preview/on-screen gates (see use-video-state.ts).
const feedCalls = (calls: { method: string; url: string }[]) =>
  calls.filter((c) => c.url.includes("/video/") && !c.url.includes("/api/video/state"));

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
  FakePeerConnection.reset();
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

    // Fired BEFORE the no-request check, so the on-screen gate is already
    // open — the ONLY thing left withholding a request is the preview gate
    // itself. Checking this with the observer still non-intersecting would
    // pass for the wrong reason: removing the preview gate outright would
    // stay green here, because the on-screen gate alone already blocks it.
    act(() => StubObserver.last?.cb([{ isIntersecting: true }]));
    await settle();
    await settle();

    assert.equal(!!screen.queryByText("Video paused in preview"), true, "expected the preview-paused copy");
    assert.deepEqual(feedCalls(g.calls), [], "expected no request to a feed's playback endpoint before Play is pressed, even on screen");

    const play = screen.getByText("Play");
    act(() => play.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await settle();
    await settle();

    assert.ok(feedCalls(g.calls).length > 0, "expected Play to start the session it had withheld");
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

    assert.deepEqual(feedCalls(g.calls), [], "expected no request while off screen");

    act(() => StubObserver.last?.cb([{ isIntersecting: true }]));
    await settleFake();
    await settleFake();

    assert.equal(feedCalls(g.calls).filter((c) => c.method === "POST").length, 1, "expected exactly one POST once on screen");

    act(() => StubObserver.last?.cb([{ isIntersecting: false }]));
    act(() => {
      mock.timers.tick(3000);
    });
    await settleFake();
    await settleFake();

    assert.equal(
      feedCalls(g.calls).filter((c) => c.method === "DELETE").length,
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
    assert.equal(feedCalls(g.calls).filter((c) => c.method === "POST").length, 1, "expected the on-screen POST first");

    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    act(() => {
      mock.timers.tick(3000);
    });
    await settleFake();
    await settleFake();

    assert.equal(
      feedCalls(g.calls).filter((c) => c.method === "DELETE").length,
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

test("an embed feed renders an iframe with mute=1 and no <video>; off screen removes it", async () => {
  const feed = makeFeed({
    kind: "embed",
    source: { kind: "embed", player: "youtube-channel", ref: "UCabcdefghijklmnopqrstuv" },
    play: { via: "embed", src: "https://www.youtube.com/embed/live_stream?channel=UCabcdefghijklmnopqrstuv&autoplay=1&mute=1&controls=0&playsinline=1" },
    status: { state: "embed" },
  });
  const g = stubGlobals(makeState([feed]));
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { container } = render(
      React.createElement(VideoObject, { ...makeObject(), appLogo: null, appLogoMonochrome: false }),
    );
    await settleFake();
    await settleFake();

    act(() => StubObserver.last?.cb([{ isIntersecting: true }]));
    await settleFake();
    await settleFake();

    // Never a DOM node as an assert operand below — node:assert inspects
    // `actual` to build a failure message, and stringifying a live jsdom
    // element does not terminate in any useful time (a failing assertion
    // like that hung this exact suite for 20+ seconds before every query here
    // was coerced to a boolean first).
    const iframe = container.querySelector("iframe");
    assert.ok(iframe, "expected an iframe for an embed feed");
    assert.ok(iframe?.getAttribute("src")?.includes("mute=1"), "expected the embed src to carry mute=1");
    assert.equal(!!container.querySelector("video"), false, "an embed feed must render no <video> element");

    // An iframe has no on-screen concept of its own: left mounted, it keeps
    // decoding a YouTube/Resi stream off screen and in a hidden tab.
    act(() => StubObserver.last?.cb([{ isIntersecting: false }]));
    act(() => {
      mock.timers.tick(3000);
    });
    await settleFake();
    await settleFake();

    assert.equal(!!container.querySelector("iframe"), false, "expected the iframe removed once off screen past the teardown delay");
  } finally {
    mock.timers.reset();
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

test("whenOffline: logo with no app logo configured shows the message state", async () => {
  const feed = makeFeed({ status: { state: "offline" } });
  const g = stubGlobals(makeState([feed]));
  try {
    render(
      React.createElement(VideoObject, {
        ...makeObject({ whenOffline: "logo" }),
        appLogo: null,
        appLogoMonochrome: false,
      }),
    );
    await settle();
    await settle();

    assert.equal(!!screen.queryByText(`${feed.name} is offline`), true, "expected the message state with no logo to draw from");
  } finally {
    g.restore();
  }
});
