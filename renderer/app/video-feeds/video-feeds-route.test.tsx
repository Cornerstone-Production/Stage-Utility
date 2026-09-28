// video-feeds-route.test.tsx — the Video feeds page: the feed list, the
// Source select swapping the editor's fields, and Delete's usage-then-confirm
// gate before video:removeFeed.
//
// Driven through the REAL route component with a stubbed fetch — never a
// unit test of the pill/copy mapping in isolation — because the bug each
// guard here is written for is what the PAGE shows or sends, not what a
// helper returns.
//
// NOT covered here, and why: jsdom loads no stylesheet and reports every
// offsetHeight/getBoundingClientRect as zero, so this file proves no layout,
// spacing or the picture's visual framing — only that the right text and
// controls are in the DOM. The live picture (VideoObject, from Task 5) never
// attempts a real WebRTC/HLS session in this environment: jsdom defines
// neither RTCPeerConnection nor MediaSource, so choose-playback.ts's own
// capability check resolves every fixture feed here to "embed" (no network at
// all) or "cant-play" (verdict never reaches the attempt effect) before any
// request would go out, and IntersectionObserver is stubbed to never report
// "on screen" regardless. The picture renders inertly — exactly what
// video-object.test.tsx already drives and asserts on its own.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, test } from "node:test";

import { installRenderDom, settle, unmountAndTeardown } from "../../test-dom.js";

const teardown = installRenderDom();

const { render, screen, cleanup, fireEvent } = await import("@testing-library/react");
const React = await import("react");
const { ConfirmHost } = await import("../../components/ui/index.js");
const { VideoFeedsRoute } = await import("./video-feeds-route.js");
const { __resetReplayCacheForTests } = await import("../../lib/api.js");

// VideoState/VideoFeedView are NOT ambient globals (unlike LayoutObject and
// LayoutObjectConfig) — see video-object.test.tsx's own note on this.
type VideoState = import("@main/types/video").VideoState;
type VideoFeedView = import("@main/types/video").VideoFeedView;

after(() => unmountAndTeardown(cleanup, teardown));

/** jsdom ships no IntersectionObserver at all; use-on-screen.ts's effect
 *  throws on mount without one. Left permanently non-intersecting on purpose
 *  (never calling its callback) — see the file header on why that is safe. */
class StubIntersectionObserver {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}

function embedFeed(overrides: Partial<VideoFeedView> = {}): VideoFeedView {
  return {
    id: "feed-embed",
    name: "Online stream",
    kind: "embed",
    sourceLine: "YouTube channel",
    source: { kind: "embed", player: "youtube-channel", ref: "UC1234567890123456789012" },
    play: { via: "embed", src: "https://www.youtube.com/embed/live_stream?channel=UC1234567890123456789012" },
    status: { state: "embed" },
    ...overrides,
  };
}

function externalFeed(overrides: Partial<VideoFeedView> = {}): VideoFeedView {
  return {
    id: "feed-external",
    name: "Lobby relay",
    kind: "external",
    sourceLine: "https://relay.example.org/feed.whep",
    source: { kind: "external", url: "https://relay.example.org/feed.whep" },
    play: { via: "external", url: "https://relay.example.org/feed.whep", protocol: "whep" },
    status: { state: null },
    ...overrides,
  };
}

function makeState(feeds: VideoFeedView[]): VideoState {
  return { rev: 1, relay: { state: "off" }, kinds: ["embed", "external"], feeds };
}

interface Call {
  method: string;
  url: string;
}

/** Every request the page makes, matched by method and path — including the
 *  order they happen in, which the delete-ordering test below depends on. */
function stubFetch(state: VideoState) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const url = String(input);
    calls.push({ method, url });
    if (method === "GET" && url.endsWith("/api/video/state")) {
      return { ok: true, status: 200, json: async () => state, text: async () => "" } as unknown as Response;
    }
    if (method === "GET" && /\/api\/video\/feeds\/[^/]+\/usage$/.test(url)) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ layouts: [{ viewId: "v1", name: "Stage confidence" }, { viewId: "v2", name: "Home" }] }),
        text: async () => "",
      } as unknown as Response;
    }
    if (method === "DELETE" && /\/api\/video\/feeds\/[^/]+$/.test(url)) {
      return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => "" } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" } as unknown as Response;
  }) as typeof fetch;
  return { fn, calls };
}

function stubGlobals(state: VideoState) {
  const { fn, calls } = stubFetch(state);
  const realFetch = globalThis.fetch;
  const realIo = (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
  globalThis.fetch = fn;
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = StubIntersectionObserver;
  return {
    calls,
    restore() {
      globalThis.fetch = realFetch;
      (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = realIo;
    },
  };
}

function mount() {
  return render(
    React.createElement(React.Fragment, null, React.createElement(VideoFeedsRoute), React.createElement(ConfirmHost)),
  );
}

beforeEach(() => {
  cleanup();
  __resetReplayCacheForTests();
});
afterEach(() => cleanup());

test("both feeds render, the embed row's pill names its player, the external row has none, and Source swaps the editor's fields", async () => {
  const g = stubGlobals(makeState([embedFeed(), externalFeed()]));
  try {
    const { container } = mount();
    await settle();
    await settle();

    // "Online stream" (the embed feed, selected by default) renders twice —
    // once in the list row, once as the editor's own heading — so this checks
    // presence rather than a single match.
    assert.ok(screen.getAllByText("Online stream").length > 0, "expected the embed feed's name in the list");
    assert.ok(screen.getByText("Lobby relay"), "expected the external feed's name in the list");
    assert.ok(screen.getByText("Live on YouTube"), "expected the embed row's pill to name its player");

    // The external row shows NO pill (main/types/video.ts: an external
    // feed's health is never reported, so its status.state is always null).
    // None of the OTHER pill copy leaked out either — every one of these is a
    // distinct full string from "Live on YouTube", so a false positive here
    // would mean a pill rendered somewhere it should not have.
    for (const text of ["Live", "Live, delayed", "Standby", "Waiting for source", "Offline"]) {
      assert.equal(screen.queryByText(text), null, `did not expect "${text}" to appear anywhere on the page`);
    }

    // The embed feed sorts first (feeds[0]) and is selected by default, so
    // its editor is already showing — the external field must NOT be present
    // yet, or switching would prove nothing.
    assert.equal(
      screen.queryByText("WebRTC (WHEP) or HLS address"),
      null,
      "expected no external field before the Source select is changed",
    );

    const sourceSelect = container.querySelector('select[aria-label="Source"]');
    assert.ok(sourceSelect, "expected a Source select in the editor");
    fireEvent.change(sourceSelect!, { target: { value: "external" } });
    await settle();

    assert.ok(
      screen.getByText("WebRTC (WHEP) or HLS address"),
      "expected the external field to appear once Source is switched to it",
    );
  } finally {
    g.restore();
  }
});

test("Delete calls video:feedUsage BEFORE video:removeFeed, and the confirmation names the layouts", async () => {
  const g = stubGlobals(makeState([embedFeed({ id: "feed-1", name: "Program (IMAG)" })]));
  try {
    mount();
    await settle();
    await settle();

    const del = screen.getByRole("button", { name: "Delete feed" });
    fireEvent.click(del);
    await settle();
    await settle();

    // The usage read must have happened, and the confirm must be open with
    // the layouts named — all BEFORE any DELETE request goes out.
    const usageIndex = g.calls.findIndex((c) => c.method === "GET" && /\/usage$/.test(c.url));
    assert.notEqual(usageIndex, -1, "expected a video:feedUsage request");
    assert.equal(
      g.calls.some((c) => c.method === "DELETE"),
      false,
      "video:removeFeed must not fire before the confirm is answered",
    );
    assert.ok(
      screen.getByText("Used by 2 layouts: Stage confidence, Home."),
      "expected the confirmation to name the layouts video:feedUsage reported",
    );

    const confirmDelete = screen.getByRole("button", { name: "Delete" });
    fireEvent.click(confirmDelete);
    await settle();
    await settle();

    const removeIndex = g.calls.findIndex((c) => c.method === "DELETE");
    assert.notEqual(removeIndex, -1, "expected video:removeFeed to fire once the confirm is answered");
    assert.ok(usageIndex < removeIndex, "video:feedUsage must fire BEFORE video:removeFeed");
  } finally {
    g.restore();
  }
});

test("cancelling the delete confirmation never calls video:removeFeed", async () => {
  const g = stubGlobals(makeState([embedFeed({ id: "feed-1", name: "Program (IMAG)" })]));
  try {
    mount();
    await settle();
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Delete feed" }));
    await settle();
    await settle();

    // Two "Cancel" buttons are on screen at this point — the editor's own,
    // and the confirm dialog's — so this picks the LAST, which is the
    // dialog's: AlertDialogPrimitive.Portal appends its content at the end
    // of <body>, after the app root.
    const cancelButtons = screen.getAllByRole("button", { name: "Cancel" });
    fireEvent.click(cancelButtons[cancelButtons.length - 1]!);
    await settle();
    await settle();

    assert.equal(
      g.calls.some((c) => c.method === "DELETE"),
      false,
      "video:removeFeed must not fire when the confirm is dismissed",
    );
  } finally {
    g.restore();
  }
});
