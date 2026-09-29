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
// controls are in the DOM. The live picture (VideoObject) never
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

const { render, screen, cleanup, fireEvent, within, act } = await import("@testing-library/react");
const React = await import("react");
const { ConfirmHost } = await import("../../components/ui/index.js");
const { VideoFeedsRoute } = await import("./video-feeds-route.js");
const { __resetReplayCacheForTests } = await import("../../lib/api.js");
const { COPIED_LABEL_MS } = await import("./feed-editor.js");
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import("@tanstack/react-router");

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
    sourceLine: "YouTube or Resi · UC1234567890123456789012",
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
    sourceLine: "Other address · https://relay.example.org/feed.whep",
    source: { kind: "external", url: "https://relay.example.org/feed.whep" },
    play: { via: "external", url: "https://relay.example.org/feed.whep", protocol: "whep" },
    status: { state: null },
    ...overrides,
  };
}

function pullFeed(overrides: Partial<VideoFeedView> = {}): VideoFeedView {
  return {
    id: "feed-pull",
    name: "Program (IMAG)",
    kind: "pull",
    sourceLine: "Pulled from a device · rtsp://192.0.2.21:8554/stream2",
    source: { kind: "pull", url: "rtsp://192.0.2.21:8554/stream2", username: "" },
    play: { via: "relay", whep: "/video/feed-pull/whep", hls: "/video/feed-pull/index.m3u8" },
    status: { state: "waiting" },
    ...overrides,
  };
}

function pushFeed(overrides: Partial<VideoFeedView> = {}): VideoFeedView {
  return {
    id: "feed-push",
    name: "Stage PTZ",
    kind: "push",
    sourceLine: "The device pushes · SRT",
    source: { kind: "push", protocol: "srt" },
    play: { via: "relay", whep: "/video/feed-push/whep", hls: "/video/feed-push/index.m3u8" },
    status: { state: "waiting" },
    ...overrides,
  };
}

const TEST_PORTS = { rtmp: 1935, srt: 8890, webrtcUdp: 8189, webrtcHttp: 8889, hls: 8888, api: 9997 };

function makeState(feeds: VideoFeedView[]): VideoState {
  return { rev: 1, relay: { state: "off" }, kinds: ["embed", "external"], ports: TEST_PORTS, binaryPresent: true, feeds };
}

interface Call {
  method: string;
  url: string;
  /** The parsed JSON body a POST/PATCH sent, for asserting exactly what
   *  Save's request carried — undefined for a body-less request. */
  body?: unknown;
}

interface FeedResponse {
  status: number;
  body: unknown;
}

interface FetchStubOptions {
  /** Answers a video:addFeed POST. Default: a bare 201 with an empty feed —
   *  fine for tests that only check ORDERING, not the response shape. */
  onAddFeed?: (body: unknown) => FeedResponse;
  /** Answers a video:updateFeed PATCH. Same default reasoning. */
  onUpdateFeed?: (id: string, body: unknown) => FeedResponse;
  /** Answers a video:removeFeed DELETE. Default: 200. */
  onRemoveFeed?: () => FeedResponse;
  /** What video:feedUsage reports. Default: two layouts. "fail" rejects. */
  usage?: { viewId: string; name: string }[] | "fail";
  /** Answers a video:pushAddress GET, keyed by feed id and the `?protocol=`
   *  query param the client sends (R14g-a's preview) — undefined when the
   *  request carried none. Default: a plain SRT address carrying "testpw".
   *  May return a Promise instead — R14 round 2 item 6's stale-response
   *  tests hold one call open on purpose, to prove a LATER request's answer
   *  landing first is not clobbered once the held one finally resolves. */
  onPushAddress?: (id: string, protocol: string | undefined) => FeedResponse | Promise<FeedResponse>;
  /** Answers a video:newPushPassword POST, keyed by feed id. Default: the
   *  same address with "rotatedpw" in place of "testpw". May also return a
   *  Promise — same reason as onPushAddress above. */
  onNewPushPassword?: (id: string) => FeedResponse | Promise<FeedResponse>;
}

/** Every request the page makes, matched by method and path — including the
 *  order they happen in, which the delete-ordering test below depends on. */
function stubFetch(state: VideoState, opts: FetchStubOptions = {}) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const url = String(input);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, url, body });
    if (method === "GET" && url.endsWith("/api/video/state")) {
      return { ok: true, status: 200, json: async () => state, text: async () => "" } as unknown as Response;
    }
    if (method === "GET" && /\/api\/video\/feeds\/[^/]+\/usage$/.test(url)) {
      if (opts.usage === "fail") throw new TypeError("fetch failed");
      return {
        ok: true,
        status: 200,
        json: async () => ({ layouts: (opts.usage as { viewId: string; name: string }[] | undefined) ?? [{ viewId: "v1", name: "Stage confidence" }, { viewId: "v2", name: "Home" }] }),
        text: async () => "",
      } as unknown as Response;
    }
    if (method === "POST" && url.endsWith("/api/video/feeds")) {
      const r = opts.onAddFeed?.(body) ?? { status: 201, body: { feed: {} } };
      return { ok: r.status < 400, status: r.status, json: async () => r.body, text: async () => "" } as unknown as Response;
    }
    // `(?:\?.*)?` — R14g-a's client now appends `?protocol=<draft protocol>`
    // to every push-address GET, previewing another protocol before Save.
    const push = url.match(/\/api\/video\/feeds\/([^/?]+)\/push(?:\?.*)?$/);
    if (method === "GET" && push) {
      const id = decodeURIComponent(push[1]!);
      const requestedProtocol = new URL(url, "http://localhost").searchParams.get("protocol") ?? undefined;
      const r = await (opts.onPushAddress?.(id, requestedProtocol) ?? {
        status: 200,
        body: {
          protocol: requestedProtocol ?? "srt",
          address: `srt://192.168.1.50:8890?streamid=publish:${id}:video:testpw`,
          password: "testpw",
        },
      });
      return { ok: r.status < 400, status: r.status, json: async () => r.body, text: async () => "" } as unknown as Response;
    }
    const newPassword = url.match(/\/api\/video\/feeds\/([^/]+)\/push\/new-password$/);
    if (method === "POST" && newPassword) {
      const id = decodeURIComponent(newPassword[1]!);
      const r = await (opts.onNewPushPassword?.(id) ?? {
        status: 200,
        body: {
          protocol: "srt",
          address: `srt://192.168.1.50:8890?streamid=publish:${id}:video:rotatedpw`,
          password: "rotatedpw",
          applied: true,
          kicked: "none",
        },
      });
      return { ok: r.status < 400, status: r.status, json: async () => r.body, text: async () => "" } as unknown as Response;
    }
    const one = url.match(/\/api\/video\/feeds\/([^/]+)$/);
    if (method === "PATCH" && one) {
      const r = opts.onUpdateFeed?.(decodeURIComponent(one[1]!), body) ?? { status: 200, body: { feed: {} } };
      return { ok: r.status < 400, status: r.status, json: async () => r.body, text: async () => "" } as unknown as Response;
    }
    if (method === "DELETE" && one) {
      const r = opts.onRemoveFeed?.() ?? { status: 200, body: { ok: true } };
      return { ok: r.status < 400, status: r.status, json: async () => r.body, text: async () => "" } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" } as unknown as Response;
  }) as typeof fetch;
  return { fn, calls };
}

function stubGlobals(state: VideoState, opts: FetchStubOptions = {}) {
  const { fn, calls } = stubFetch(state, opts);
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

/** A real router, one root route rendering the page directly — the page's
 *  own "Change ports in Advanced" link uses `useRouter().navigate()`, which
 *  only WARNS with no provider (unlike `<Link>`, which throws), but a clean
 *  test run has none of these warnings either. */
function mount() {
  const rootRoute = createRootRoute({
    component: () => React.createElement(React.Fragment, null, React.createElement(VideoFeedsRoute), React.createElement(ConfirmHost)),
  });
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: ["/"] }) });
  return render(React.createElement(RouterProvider, { router } as never));
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
    // The editor reads usage once on its own, for its used-by line. What is
    // asserted here is the read Delete makes, after the click.
    const before = g.calls.length;
    fireEvent.click(del);
    await settle();
    await settle();

    // The usage read must have happened, and the confirm must be open with
    // the layouts named — all BEFORE any DELETE request goes out.
    const usageIndex = g.calls.findIndex((c, i) => i >= before && c.method === "GET" && /\/usage$/.test(c.url));
    assert.notEqual(usageIndex, -1, "expected Delete to make a video:feedUsage request");
    assert.equal(
      g.calls.some((c) => c.method === "DELETE"),
      false,
      "video:removeFeed must not fire before the confirm is answered",
    );
    assert.ok(
      within(screen.getByRole("alertdialog")).getByText("Used by 2 layouts: Stage confidence, Home."),
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

test("a refused save shows the server's error text under the buttons, and nothing reads as saved", async () => {
  const g = stubGlobals(makeState([embedFeed({ id: "feed-1", name: "Program (IMAG)" })]), {
    onUpdateFeed: () => ({ status: 400, body: { error: "Name must be 1–60 characters." } }),
  });
  try {
    const { container } = mount();
    await settle();
    await settle();

    const nameInput = container.querySelector('input[aria-label="Name"]') as HTMLInputElement;
    assert.ok(nameInput, "expected a Name input");
    fireEvent.change(nameInput, { target: { value: "" } });

    const saveButton = screen.getByRole("button", { name: "Save" });
    fireEvent.click(saveButton);
    await settle();
    await settle();

    const errorEl = screen.getByText("Name must be 1–60 characters.");
    assert.ok(errorEl, "expected the server's refusal text on the page");
    assert.ok(
      saveButton.compareDocumentPosition(errorEl) & Node.DOCUMENT_POSITION_FOLLOWING,
      "expected the error to render AFTER (below) the Save/Cancel/Delete row",
    );

    // Nothing reads as saved: video:state was never re-read (no push in this
    // environment either — EventSource is a no-op stub), so the list still
    // shows the feed's ORIGINAL, unsaved-over name.
    // "Program (IMAG)" renders twice — the list row, and the editor's own
    // heading (which reads the ORIGINAL feed prop, never the local draft) —
    // so this checks presence rather than a single match.
    assert.ok(
      screen.getAllByText("Program (IMAG)").length > 0,
      "expected the list to still show the feed's original name",
    );
    assert.equal(
      screen.getByRole("button", { name: "Save" }).textContent,
      "Save",
      'expected Save to have settled back from "Saving…", not stay stuck',
    );
    assert.equal(
      g.calls.some((c) => c.method === "POST" && c.url.endsWith("/api/video/feeds")),
      false,
      "expected video:updateFeed (a PATCH), not video:addFeed — this feed already exists",
    );
  } finally {
    g.restore();
  }
});

test("Add feed then Save calls video:addFeed with the form's name and source", async () => {
  const g = stubGlobals(makeState([embedFeed({ id: "feed-1", name: "Program (IMAG)" })]), {
    onAddFeed: () => ({
      status: 201,
      body: {
        feed: embedFeed({
          id: "feed-new",
          name: "New feed",
          source: { kind: "embed", player: "youtube-channel", ref: "UC1234567890123456789012" },
        }),
      },
    }),
  });
  try {
    const { container } = mount();
    await settle();
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Add feed" }));
    await settle();

    const channelInput = container.querySelector('input[aria-label="Channel"]') as HTMLInputElement;
    assert.ok(channelInput, "expected the embed Channel field on a fresh draft (kinds[0] is \"embed\")");
    fireEvent.change(channelInput, { target: { value: "UC1234567890123456789012" } });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await settle();
    await settle();

    const addCall = g.calls.find((c) => c.method === "POST" && c.url.endsWith("/api/video/feeds"));
    assert.ok(addCall, "expected a video:addFeed request");
    assert.deepEqual(
      addCall!.body,
      { name: "New feed", source: { kind: "embed", player: "youtube-channel", ref: "UC1234567890123456789012" } },
      "expected the request body to carry the form's own name and source, not a placeholder",
    );
  } finally {
    g.restore();
  }
});

test("the just-saved feed stays selected until the pushed list contains it — the editor never flips to another feed", async () => {
  const g = stubGlobals(makeState([embedFeed({ id: "feed-1", name: "Program (IMAG)" })]), {
    onAddFeed: () => ({
      status: 201,
      body: {
        feed: embedFeed({
          id: "feed-new",
          name: "Online stream",
          source: { kind: "embed", player: "youtube-channel", ref: "UC9876543210987654321098" },
        }),
      },
    }),
  });
  try {
    const { container } = mount();
    await settle();
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Add feed" }));
    await settle();

    const channelInput = container.querySelector('input[aria-label="Channel"]') as HTMLInputElement;
    fireEvent.change(channelInput, { target: { value: "UC9876543210987654321098" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await settle();
    await settle();

    // The stub's video:state NEVER includes "feed-new" — there is no real SSE
    // push in this environment (EventSource is a no-op stub) — so this is the
    // strongest form of the regression: the list truly never catches up
    // during the test, and the editor must still show the feed Save's own
    // response returned, never fall back to feeds[0] ("Program (IMAG)").
    const nameInput = container.querySelector('input[aria-label="Name"]') as HTMLInputElement;
    assert.equal(nameInput.value, "Online stream", "expected the editor to keep showing the just-saved feed");
  } finally {
    g.restore();
  }
});

test("Cancel while creating a new feed returns to the previously selected feed", async () => {
  const g = stubGlobals(
    makeState([embedFeed({ id: "feed-1", name: "Program (IMAG)" }), externalFeed({ id: "feed-2", name: "Lobby relay" })]),
  );
  try {
    const { container } = mount();
    await settle();
    await settle();

    // feed-1 is selected by default (feeds[0]) — explicitly select feed-2 so
    // this proves Cancel restores the ACTUAL previous selection, not just a
    // fallback to whichever feed happens to be first in the list.
    fireEvent.click(screen.getByText("Lobby relay"));
    await settle();
    let nameInput = container.querySelector('input[aria-label="Name"]') as HTMLInputElement;
    assert.equal(nameInput.value, "Lobby relay", "expected feed-2 selected before starting a new feed");

    fireEvent.click(screen.getByRole("button", { name: "Add feed" }));
    await settle();
    nameInput = container.querySelector('input[aria-label="Name"]') as HTMLInputElement;
    assert.equal(nameInput.value, "New feed", "expected a blank draft after Add feed");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await settle();

    nameInput = container.querySelector('input[aria-label="Name"]') as HTMLInputElement;
    assert.equal(
      nameInput.value,
      "Lobby relay",
      "expected Cancel to return to feed-2 (exiting new-feed mode), not stay on a blank draft or fall back to feed-1",
    );
  } finally {
    g.restore();
  }
});

test("a Delete the server refuses shows its error, and the feed stays", async () => {
  const g = stubGlobals(makeState([embedFeed({ id: "feed-1", name: "Program (IMAG)" })]), {
    onRemoveFeed: () => ({ status: 500, body: { error: "The feed store could not be written." } }),
  });
  try {
    mount();
    await settle();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Delete feed" }));
    await settle();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await settle();
    await settle();
    assert.equal(!!screen.queryByText("The feed store could not be written."), true, "a refused delete must say why");
    assert.equal(screen.getAllByText("Program (IMAG)").length > 0, true);
  } finally {
    g.restore();
  }
});

test("the Source dropdown offers exactly the kinds video:state reports", async () => {
  for (const kinds of [["embed", "external"], ["external"]] as const) {
    const g = stubGlobals({ ...makeState([externalFeed()]), kinds: [...kinds] });
    try {
      const { container } = mount();
      await settle();
      await settle();
      const select = container.querySelector('select[aria-label="Source"]') as HTMLSelectElement | null;
      assert.equal(!!select, true, "expected a Source select");
      const offered = [...select!.querySelectorAll("option")].map((o) => o.getAttribute("value"));
      assert.deepEqual(offered, [...kinds], `kinds ${kinds.join(",")}`);
    } finally {
      g.restore();
      cleanup();
      __resetReplayCacheForTests();
    }
  }
});

test("one layout is \"1 layout\", not \"1 layouts\"", async () => {
  const g = stubGlobals(makeState([embedFeed({ id: "feed-1", name: "Program (IMAG)" })]), {
    usage: [{ viewId: "v1", name: "Stage confidence" }],
  });
  try {
    mount();
    await settle();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Delete feed" }));
    await settle();
    await settle();
    assert.equal(!!within(screen.getByRole("alertdialog")).queryByText("Used by 1 layout: Stage confidence."), true);
  } finally {
    g.restore();
  }
});

test("after a rename the editor's heading shows the new name before any push arrives", async () => {
  const g = stubGlobals(makeState([embedFeed({ id: "feed-1", name: "Program (IMAG)" })]), {
    onUpdateFeed: (id, body) => ({
      status: 200,
      body: { feed: embedFeed({ id, name: (body as { patch: { name: string } }).patch?.name ?? (body as { name: string }).name }) },
    }),
  });
  try {
    const { container } = mount();
    await settle();
    await settle();
    const nameInput = container.querySelector('input[aria-label="Name"]') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Main program" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await settle();
    await settle();
    // No push arrives in this environment (EventSource is a no-op stub), so
    // the list still carries the old name: the heading must not.
    assert.equal(!!screen.queryByRole("heading", { name: "Main program" }), true, "the heading still shows the name from before the save");
  } finally {
    g.restore();
  }
});

test("the embed callout names the player: YouTube's delay for YouTube, Resi's own sentence for Resi", async () => {
  const g = stubGlobals(makeState([embedFeed({ id: "feed-1", name: "Program (IMAG)" })]));
  try {
    const { container } = mount();
    await settle();
    await settle();
    const editor = within(screen.getByRole("complementary", { name: "Feed settings" }));
    assert.equal(!!editor.queryByText(/Plays in YouTube's own player, 5 to 15 seconds behind/), true);

    const player = container.querySelector('select[aria-label="Player"]') as HTMLSelectElement;
    fireEvent.change(player, { target: { value: "resi" } });
    await settle();
    assert.equal(!!editor.queryByText("Plays in Resi's own player. Good for a lobby, not for the stage."), true);
    assert.equal(!!editor.queryByText(/YouTube's own player/), false, "a Resi player must not be described as YouTube's");
  } finally {
    g.restore();
  }
});

// ── the layout the approved design specifies, as far as text can show it ────
//
// Widths, stacking and the pane proportions are CSS, and jsdom loads no
// stylesheet: those were checked in Chromium against the approved design
// (the one-card, wide-list, narrow-editor layout). What follows is what the
// DOM can prove.

test("each row says how its feed plays", async () => {
  const g = stubGlobals(makeState([embedFeed(), embedFeed({ id: "resi", name: "Resi lobby", source: { kind: "embed", player: "resi", ref: "https://control.resi.io/webplayer/video.html?id=1" } }), externalFeed()]));
  try {
    mount();
    await settle();
    await settle();
    assert.equal(!!screen.queryByText("Plays in YouTube's own player · 5 to 15 s behind"), true);
    assert.equal(!!screen.queryByText("Plays in Resi's own player"), true);
    assert.equal(!!screen.queryByText("WebRTC, played as given"), true);
    assert.equal(!!screen.queryByText("Stage Utility cannot see its health"), true);
    assert.equal(!!screen.queryByText("Other address · https://relay.example.org/feed.whep"), true, "the source line is shown as the server built it");
  } finally {
    g.restore();
  }
});

test("R14 round 3 item 4: a delayed relay row's meta line says \"a few seconds behind\", never a figure nothing computes; a live row still says \"under 1 s behind\"", async () => {
  const g = stubGlobals({
    ...makeState([
      pushFeed({ id: "feed-live", name: "Live push", status: { state: "live", width: 1920, height: 1080 } }),
      pullFeed({ id: "feed-delayed", name: "Delayed pull", status: { state: "delayed", delayedBecause: "b-frames" } }),
    ]),
    kinds: ALL_KINDS,
  });
  try {
    mount();
    await settle();
    await settle();
    assert.equal(!!screen.queryByText("WebRTC · under 1 s behind"), true, "expected the design's own live text, unchanged");
    assert.equal(!!screen.queryByText("HLS · a few seconds behind"), true);
    assert.equal(!!screen.queryByText(/about 4 s/), false, "a specific figure nothing in this pipeline computes must never appear");
  } finally {
    g.restore();
  }
});

test("the editor says which layouts use the selected feed", async () => {
  const g = stubGlobals(makeState([embedFeed({ id: "feed-1", name: "Program (IMAG)" })]));
  try {
    mount();
    await settle();
    await settle();
    const editor = within(screen.getByRole("complementary", { name: "Feed settings" }));
    assert.equal(!!editor.queryByText("Used by 2 layouts: Stage confidence, Home."), true);
  } finally {
    g.restore();
  }
});

test("a failed usage read says so, never that the feed is unused", async () => {
  const g = stubGlobals(makeState([embedFeed({ id: "feed-1", name: "Program (IMAG)" })]), { usage: "fail" });
  try {
    mount();
    await settle();
    await settle();
    const editor = within(screen.getByRole("complementary", { name: "Feed settings" }));
    assert.equal(!!editor.queryByText("Couldn't read which layouts use this feed."), true);
    assert.equal(!!editor.queryByText(/Not used by any layout/), false);
    assert.equal(
      g.calls.some((c) => c.method === "POST" && c.url.endsWith("/api/log/client")),
      true,
      "the failed read must reach /log",
    );
  } finally {
    g.restore();
  }
});

test("a field's description sits under its control, not beside its label", async () => {
  const g = stubGlobals(makeState([embedFeed()]));
  try {
    const { container } = mount();
    await settle();
    await settle();
    const input = container.querySelector('input[aria-label="Name"]')!;
    const description = screen.getByText("What layouts and Home show. Renaming keeps every layout using it.");
    assert.ok(input.compareDocumentPosition(description) & Node.DOCUMENT_POSITION_FOLLOWING, "the Name description must follow its input");
  } finally {
    g.restore();
  }
});

const ALL_KINDS: VideoState["kinds"] = ["pull", "push", "embed", "external"];

/** A real updateFeed response never carries the PATCH body's own `password`
 *  key back — that field is write-only. Used by the fixture `onUpdateFeed`
 *  callbacks below so a fake response is shaped the same way. */
function echoUpdate(id: string, body: unknown): { feed: VideoFeedView } {
  const { password: _password, ...rest } = body as Record<string, unknown>;
  return { feed: pullFeed({ id, ...(rest as Partial<VideoFeedView>) }) };
}

test("a pull feed's Address, Username and password fields render, the Magewell callout shows, and Save carries the new address/username with no password when untouched", async () => {
  const g = stubGlobals(
    { ...makeState([pullFeed()]), kinds: ALL_KINDS },
    { onUpdateFeed: (id, body) => ({ status: 200, body: echoUpdate(id, body) }) },
  );
  try {
    const { container } = mount();
    await settle();
    await settle();

    const address = container.querySelector('input[aria-label="Address"]') as HTMLInputElement;
    assert.equal(address.value, "rtsp://192.0.2.21:8554/stream2");
    const username = container.querySelector('input[aria-label="Username"]') as HTMLInputElement;
    assert.equal(username.value, "");
    const password = container.querySelector('input[aria-label="Password"]') as HTMLInputElement;
    assert.equal(password.value, "", "a stored password is never sent to the client");
    assert.ok(screen.getByText(/Magewell Ultra Stream/), "expected the Magewell callout for a pull feed");

    fireEvent.change(address, { target: { value: "rtsp://192.0.2.99:8554/stream9" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await settle();
    await settle();

    const patch = g.calls.find((c) => c.method === "PATCH");
    assert.ok(patch, "expected a video:updateFeed request");
    assert.deepEqual(
      patch!.body,
      { name: "Program (IMAG)", source: { kind: "pull", url: "rtsp://192.0.2.99:8554/stream9", username: "" } },
      "an untouched password field must not send a password key at all",
    );
  } finally {
    g.restore();
  }
});

test("typing a pull password then clearing it back to empty still sends password: \"\" — the field is TOUCHED, not merely blank", async () => {
  const g = stubGlobals(
    { ...makeState([pullFeed()]), kinds: ALL_KINDS },
    { onUpdateFeed: (id, body) => ({ status: 200, body: echoUpdate(id, body) }) },
  );
  try {
    const { container } = mount();
    await settle();
    await settle();

    const password = container.querySelector('input[aria-label="Password"]') as HTMLInputElement;
    fireEvent.change(password, { target: { value: "temp" } });
    fireEvent.change(password, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await settle();
    await settle();

    const patch = g.calls.find((c) => c.method === "PATCH");
    assert.ok(patch, "expected a video:updateFeed request");
    assert.equal((patch!.body as { password?: string }).password, "", 'expected password: "" once the field was touched, even though it ends up blank');
  } finally {
    g.restore();
  }
});

test("a push feed's segmented control, address and password load, and New password rotates both", async () => {
  const g = stubGlobals({ ...makeState([pushFeed()]), kinds: ALL_KINDS });
  try {
    mount();
    await settle();
    await settle();

    assert.ok(screen.getByRole("group", { name: "How it connects" }), "expected the protocol segmented control");
    const srtButton = screen.getByRole("button", { name: "SRT" });
    assert.equal(srtButton.getAttribute("aria-pressed"), "true", "expected SRT pressed for this feed's saved protocol");

    assert.ok(await screen.findByText("The password is part of the address. Anything that pushes without it is refused."));
    const addressInput = screen.getByLabelText("Paste this into the device") as HTMLInputElement;
    assert.ok(addressInput.value.includes("testpw"), addressInput.value);
    const passwordInput = screen.getByLabelText("Password") as HTMLInputElement;
    assert.equal(passwordInput.value, "testpw");

    fireEvent.click(screen.getByRole("button", { name: "New password" }));
    await settle();
    await settle();

    const rotatedAddress = screen.getByLabelText("Paste this into the device") as HTMLInputElement;
    assert.ok(rotatedAddress.value.includes("rotatedpw"), rotatedAddress.value);
    const rotatedPassword = screen.getByLabelText("Password") as HTMLInputElement;
    assert.equal(rotatedPassword.value, "rotatedpw");

    const rotateCall = g.calls.find((c) => c.method === "POST" && /\/push\/new-password$/.test(c.url));
    assert.ok(rotateCall, "expected a video:newPushPassword POST");
  } finally {
    g.restore();
  }
});

test("WHIP's description names OBS's Bearer Token, switching from SRT/RTMP's password-in-the-address sentence", async () => {
  const g = stubGlobals(
    {
      ...makeState([pushFeed({ id: "feed-whip", name: "OBS", source: { kind: "push", protocol: "whip" } })]),
      kinds: ALL_KINDS,
    },
    {
      onPushAddress: (id) => ({
        status: 200,
        body: { protocol: "whip", address: `http://192.168.1.50:8788/video/${id}/whip`, password: "video:testpw" },
      }),
    },
  );
  try {
    mount();
    await settle();
    await settle();
    assert.ok(await screen.findByText(/Use the password below as the Bearer Token/));
    assert.equal(screen.queryByText("The password is part of the address. Anything that pushes without it is refused."), null);
  } finally {
    g.restore();
  }
});

test("a brand new push draft shows a note to save first, and never requests a push address for an unsaved feed", async () => {
  const g = stubGlobals({ ...makeState([embedFeed({ id: "feed-1" })]), kinds: ALL_KINDS });
  try {
    const { container } = mount();
    await settle();
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Add feed" }));
    await settle();
    const sourceSelect = container.querySelector('select[aria-label="Source"]') as HTMLSelectElement;
    fireEvent.change(sourceSelect, { target: { value: "push" } });
    await settle();

    assert.ok(screen.getByText("Save this feed to get its address and password."));
    assert.equal(
      g.calls.some((c) => c.method === "GET" && /\/push$/.test(c.url)),
      false,
      "must never ask for a push address before the feed has been saved",
    );
  } finally {
    g.restore();
  }
});

test("Copy falls back to selecting the address and prompting Ctrl+C/Cmd+C — jsdom has no navigator.clipboard, the same as Stage Utility's own plain-HTTP LAN deployment", async () => {
  const g = stubGlobals({ ...makeState([pushFeed()]), kinds: ALL_KINDS });
  try {
    mount();
    await settle();
    await settle();

    const addressInput = (await screen.findByLabelText("Paste this into the device")) as HTMLInputElement;
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await settle();

    assert.ok(screen.getByText("Press Ctrl+C / Cmd+C to copy"));
    assert.equal(addressInput.selectionStart, 0);
    assert.equal(addressInput.selectionEnd, addressInput.value.length, "expected the whole address selected");
  } finally {
    g.restore();
  }
});

// R14k: the shared B-frames sentence (b-frames-copy.ts), verbatim.
const WHIP_HINT = "OBS is sending B-frames, so screens get this feed a few seconds late. Turn them off for under-a-second playback.";
const DEVICE_HINT = "The device is sending B-frames, so screens get this feed a few seconds late. Turn them off on the device for under-a-second playback.";

test("R14k: a push feed set to WHIP shows the OBS-specific callout and list hint; a pull feed (never necessarily OBS) shows the generic device wording instead, in the SAME two places; a live feed shows neither", async () => {
  const g = stubGlobals({
    ...makeState([pushFeed({ id: "feed-whip-delayed", name: "OBS delayed", source: { kind: "push", protocol: "whip" }, status: { state: "delayed", delayedBecause: "b-frames" } })]),
    kinds: ALL_KINDS,
  });
  try {
    mount();
    await settle();
    await settle();
    // Scoped to the editor pane and the list row SEPARATELY — both carry the
    // shared sentence at once here (there is only one feed, selected), so a
    // regression in either location alone must still fail its own assertion.
    const asideText = screen.getByLabelText("Feed settings").textContent ?? "";
    assert.ok(asideText.includes("Delayed a few seconds."), "expected the design's headline");
    assert.ok(asideText.includes(WHIP_HINT), "expected the shared WHIP sentence in the callout");
    assert.ok(asideText.includes("In OBS: Settings, Output, Streaming, set Profile to baseline, or Keyframe interval 1 s with B-frames 0."), "expected the OBS-specific fix sentence");

    // "OBS delayed" names both the list row AND the editor's own <h2> for the
    // selected feed — only the row's own copy has a <button> ancestor.
    const row = screen.getAllByText("OBS delayed").map((el) => el.closest("button")).find((b) => b !== null);
    assert.ok(row);
    const rowText = row!.textContent ?? "";
    assert.ok(rowText.includes(WHIP_HINT), "expected the SAME shared sentence in the list row's own hint");
    assert.equal(rowText.includes("In OBS:"), false, "the list row's hint must not carry the OBS fix instructions — only the callout does");
  } finally {
    g.restore();
  }

  const g2 = stubGlobals({
    ...makeState([pullFeed({ name: "Pull delayed", status: { state: "delayed", delayedBecause: "b-frames" } })]),
    kinds: ALL_KINDS,
  });
  try {
    cleanup();
    __resetReplayCacheForTests();
    mount();
    await settle();
    await settle();
    const asideText = screen.getByLabelText("Feed settings").textContent ?? "";
    assert.ok(asideText.includes(DEVICE_HINT), "expected \"The device\", never OBS, for a pull feed");
    assert.equal(asideText.includes("OBS is sending"), false, "a pull feed must never be called OBS");
    assert.equal(asideText.includes("Keyframe interval"), false, "the OBS-specific Settings path must not appear for a non-WHIP feed");

    const row = screen.getAllByText("Pull delayed").map((el) => el.closest("button")).find((b) => b !== null);
    assert.ok(row);
    assert.ok((row!.textContent ?? "").includes(DEVICE_HINT), "expected the same device sentence in the list row's own hint");
  } finally {
    g2.restore();
  }

  const g3 = stubGlobals({
    ...makeState([pullFeed({ status: { state: "live" } })]),
    kinds: ALL_KINDS,
  });
  try {
    cleanup();
    __resetReplayCacheForTests();
    mount();
    await settle();
    await settle();
    assert.equal(screen.queryByText(/Delayed a few seconds/), null, "a live feed must show no delay warning");
  } finally {
    g3.restore();
  }
});

test("item 12: a pull feed with a stored password shows \"A password is saved\" with a Clear button, which sends password: \"\" immediately", async () => {
  const g = stubGlobals(
    { ...makeState([pullFeed({ hasPassword: true })]), kinds: ALL_KINDS },
    { onUpdateFeed: (id, body) => ({ status: 200, body: echoUpdate(id, body) }) },
  );
  try {
    mount();
    await settle();
    await settle();

    assert.ok(screen.getByText("A password is saved. Type to replace it, or clear it."));
    const clear = screen.getByRole("button", { name: "Clear" });
    fireEvent.click(clear);
    await settle();
    await settle();

    const patch = g.calls.find((c) => c.method === "PATCH");
    assert.ok(patch, "expected Clear to send a PATCH immediately, not wait for Save");
    assert.deepEqual(patch!.body, { password: "" });
  } finally {
    g.restore();
  }
});

test("item 12: typing into the pull Password field hides the \"password is saved\" message and the Clear button", async () => {
  const g = stubGlobals({ ...makeState([pullFeed({ hasPassword: true })]), kinds: ALL_KINDS });
  try {
    const { container } = mount();
    await settle();
    await settle();
    assert.ok(screen.getByText("A password is saved. Type to replace it, or clear it."));

    const password = container.querySelector('input[aria-label="Password"]') as HTMLInputElement;
    fireEvent.change(password, { target: { value: "new-one" } });
    await settle();

    assert.equal(screen.queryByText("A password is saved. Type to replace it, or clear it."), null);
    assert.equal(screen.queryByRole("button", { name: "Clear" }), null);
  } finally {
    g.restore();
  }
});

test("item 12: a pull feed with no stored password shows neither the message nor Clear", async () => {
  const g = stubGlobals({ ...makeState([pullFeed({ hasPassword: false })]), kinds: ALL_KINDS });
  try {
    mount();
    await settle();
    await settle();
    assert.equal(screen.queryByText(/A password is saved/), null);
    assert.equal(screen.queryByRole("button", { name: "Clear" }), null);
  } finally {
    g.restore();
  }
});

test("item 11: a failed rotation keeps the address and password fields visible, shows the error, and New password stays pressable", async () => {
  let attempt = 0;
  const g = stubGlobals(
    { ...makeState([pushFeed()]), kinds: ALL_KINDS },
    {
      onNewPushPassword: () => {
        attempt++;
        if (attempt === 1) return { status: 500, body: { error: "The relay could not be reached." } };
        return { status: 200, body: { protocol: "srt", address: "srt://192.168.1.50:8890?streamid=publish:feed-push:video:secondpw", password: "secondpw", applied: true, kicked: "none" } };
      },
    },
  );
  try {
    mount();
    await settle();
    await settle();

    const before = (await screen.findByLabelText("Paste this into the device")) as HTMLInputElement;
    assert.ok(before.value.includes("testpw"));

    fireEvent.click(screen.getByRole("button", { name: "New password" }));
    await settle();
    await settle();

    assert.ok(screen.getByText("The relay could not be reached."), "expected the error to show");
    const stillThere = screen.getByLabelText("Paste this into the device") as HTMLInputElement;
    assert.ok(stillThere.value.includes("testpw"), "the address must stay visible, unchanged, after a failed rotation");
    const retryButton = screen.getByRole("button", { name: "New password" });
    assert.equal((retryButton as HTMLButtonElement).disabled, false, "New password must be pressable again after a failure");

    // And pressing it again succeeds.
    fireEvent.click(retryButton);
    await settle();
    await settle();
    const after = screen.getByLabelText("Paste this into the device") as HTMLInputElement;
    assert.ok(after.value.includes("secondpw"));
    assert.equal(screen.queryByText("The relay could not be reached."), null, "the error must clear on a later success");
  } finally {
    g.restore();
  }
});

test("R14g-a: flipping the segmented control before Save re-fetches the OTHER protocol's address, without saving", async () => {
  const requested: (string | undefined)[] = [];
  const g = stubGlobals(
    { ...makeState([pushFeed()]), kinds: ALL_KINDS },
    {
      onPushAddress: (id, protocol) => {
        requested.push(protocol);
        return {
          status: 200,
          body:
            protocol === "whip"
              ? { protocol: "whip", address: `http://192.168.1.50:8788/video/${id}/whip`, password: "video:testpw" }
              : { protocol: "srt", address: `srt://192.168.1.50:8890?streamid=publish:${id}:video:testpw`, password: "testpw" },
        };
      },
    },
  );
  try {
    mount();
    await settle();
    await settle();
    assert.ok((await screen.findByLabelText("Paste this into the device") as HTMLInputElement).value.startsWith("srt://"));

    fireEvent.click(screen.getByRole("button", { name: "WHIP (OBS)" }));
    await settle();
    await settle();

    const address = (await screen.findByLabelText("Paste this into the device")) as HTMLInputElement;
    assert.ok(address.value.startsWith("http://"), address.value);
    assert.ok(requested.includes("whip"), "expected a GET carrying ?protocol=whip");

    // Nothing was saved: no PATCH/POST /api/video/feeds went out for this.
    assert.equal(
      g.calls.some((c) => c.method === "PATCH" || (c.method === "POST" && c.url.endsWith("/api/video/feeds"))),
      false,
      "flipping the segmented control alone must never save anything",
    );
  } finally {
    g.restore();
  }
});

test("R14 round 2 item 6: a stale preview response landing late must not clobber a newer one — a request counter drops it", async () => {
  let heldRelease: ((r: { status: number; body: unknown }) => void) | null = null;
  const g = stubGlobals(
    { ...makeState([pushFeed()]), kinds: ALL_KINDS },
    {
      onPushAddress: (id, protocol) => {
        if (protocol === "srt" && !heldRelease) {
          // The INITIAL mount load — held until the test releases it, well
          // after the WHIP preview below has already resolved.
          return new Promise((resolve) => {
            heldRelease = resolve;
          });
        }
        return {
          status: 200,
          body: { protocol: protocol ?? "srt", address: `http://192.168.1.50:8788/video/${id}/${protocol}`, password: `${protocol}pw` },
        };
      },
    },
  );
  try {
    mount();
    await settle();
    await settle();
    // The initial srt load is held — nothing to assert on it yet.

    fireEvent.click(screen.getByRole("button", { name: "WHIP (OBS)" }));
    await settle();
    await settle();
    await screen.findByLabelText("Paste this into the device");
    let password = screen.getByLabelText("Password") as HTMLInputElement;
    assert.equal(password.value, "whippw");

    heldRelease!({
      status: 200,
      body: { protocol: "srt", address: "srt://192.168.1.50:8890?streamid=publish:feed-push:video:initialpw", password: "initialpw" },
    });
    await settle();
    await settle();

    password = screen.getByLabelText("Password") as HTMLInputElement;
    assert.equal(
      password.value,
      "whippw",
      "a stale (older) response landing late must not overwrite the newer preview — under the bug it does",
    );
  } finally {
    g.restore();
  }
});

test("R14 round 2 item 6: New password during an unsaved preview re-fetches the address for the protocol the control shows, rather than flipping to the saved one", async () => {
  let rotated = false;
  const g = stubGlobals(
    { ...makeState([pushFeed()]), kinds: ALL_KINDS },
    {
      onPushAddress: (id, protocol) => ({
        status: 200,
        body: {
          protocol: protocol ?? "srt",
          address: `http://192.168.1.50:8788/video/${id}/${protocol}`,
          password: rotated ? "freshpw" : "oldpw",
        },
      }),
      onNewPushPassword: () => {
        rotated = true;
        return {
          status: 200,
          body: { protocol: "srt", address: "srt://192.168.1.50:8890?streamid=publish:feed-push:video:freshpw", password: "freshpw", applied: true, kicked: "none" },
        };
      },
    },
  );
  try {
    mount();
    await settle();
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "WHIP (OBS)" }));
    await settle();
    await settle();
    await screen.findByLabelText("Paste this into the device");
    let password = screen.getByLabelText("Password") as HTMLInputElement;
    assert.equal(password.value, "oldpw", "sanity: the preview shows the OLD password before any rotation");

    fireEvent.click(screen.getByRole("button", { name: "New password" }));
    await settle();
    await settle();
    await settle();

    const address = screen.getByLabelText("Paste this into the device") as HTMLInputElement;
    password = screen.getByLabelText("Password") as HTMLInputElement;
    assert.ok(address.value.startsWith("http://"), `expected the control's OWN protocol (WHIP), not the saved SRT one: ${address.value}`);
    assert.equal(password.value, "freshpw", "expected the re-preview to carry the freshly rotated password");
    assert.equal(
      screen.getByRole("button", { name: "WHIP (OBS)" }).getAttribute("aria-pressed"),
      "true",
      "the segmented control itself must still show WHIP",
    );
  } finally {
    g.restore();
  }
});

test("R14 round 3 item 1: switching protocol while a rotation is in flight still shows the rotation's own note once it resolves", async () => {
  let releaseRotation: ((r: { status: number; body: unknown }) => void) | null = null;
  const g = stubGlobals(
    { ...makeState([pushFeed()]), kinds: ALL_KINDS, relay: RUNNING_RELAY },
    {
      onNewPushPassword: () =>
        new Promise((resolve) => {
          releaseRotation = resolve;
        }),
      onPushAddress: (id, protocol) => ({
        status: 200,
        body: { protocol: protocol ?? "srt", address: `http://192.168.1.50:8788/video/${id}/${protocol}`, password: `${protocol}pw` },
      }),
    },
  );
  try {
    mount();
    await settle();
    await settle();
    await screen.findByLabelText("Paste this into the device");

    fireEvent.click(screen.getByRole("button", { name: "New password" }));
    await settle();
    await settle();

    // Flip the segmented control WHILE the rotation is still held — this
    // bumps the request counter (via load()'s own re-fetch), which must
    // supersede the DATA the rotation carries but never the rotation's own
    // note about what happened to the previous publisher.
    fireEvent.click(screen.getByRole("button", { name: "WHIP (OBS)" }));
    await settle();
    await settle();

    releaseRotation!({
      status: 200,
      body: {
        protocol: "srt",
        address: "srt://192.168.1.50:8890?streamid=publish:feed-push:video:freshpw",
        password: "freshpw",
        applied: false,
        kicked: "none",
      },
    });
    await settle();
    await settle();

    assert.ok(
      screen.getByText("The relay did not take the new password yet; it will on its next start"),
      "expected the rotation's own note to still show, even though the control was flipped mid-flight",
    );
  } finally {
    g.restore();
  }
});

test("the Copy button reads \"Copy\" before any click, never stale \"Copied\" from an earlier render", async () => {
  // This proves only the button's OWN starting label — the secure-clipboard
  // flip itself needs navigator.clipboard/isSecureContext stubbed, which the
  // dedicated test below does; jsdom's own default (both undefined) is
  // exactly Stage Utility's own plain-HTTP LAN deployment, so this test's
  // scope is real, not a stand-in for the flip.
  const g = stubGlobals({ ...makeState([pushFeed()]), kinds: ALL_KINDS });
  try {
    mount();
    await settle();
    await settle();
    await screen.findByLabelText("Paste this into the device");
    assert.ok(screen.getByRole("button", { name: "Copy" }), "expected the button to read \"Copy\" before any click");
  } finally {
    g.restore();
  }
});

test("R14k item 2: the secure-clipboard Copy path flips the button to \"Copied\" and reverts after COPIED_LABEL_MS — stubbing navigator.clipboard and isSecureContext, which jsdom does not provide on its own", async () => {
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => {} }, configurable: true });
  const g = stubGlobals({ ...makeState([pushFeed()]), kinds: ALL_KINDS });
  try {
    mount();
    await settle();
    await settle();
    await screen.findByLabelText("Paste this into the device");

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await settle();
    await settle();
    assert.ok(screen.getByRole("button", { name: "Copied" }), "expected the label to flip once the secure copy resolves");

    await act(async () => {
      await new Promise((r) => setTimeout(r, COPIED_LABEL_MS + 50));
    });
    assert.ok(screen.getByRole("button", { name: "Copy" }), "expected the label to revert after COPIED_LABEL_MS");
  } finally {
    g.restore();
    delete (window as { isSecureContext?: unknown }).isSecureContext;
    delete (navigator as { clipboard?: unknown }).clipboard;
  }
});

test("R14k item 2: blurring the address field clears the fallback's \"Press Ctrl+C / Cmd+C\" hint", async () => {
  const g = stubGlobals({ ...makeState([pushFeed()]), kinds: ALL_KINDS });
  try {
    mount();
    await settle();
    await settle();
    const addressInput = (await screen.findByLabelText("Paste this into the device")) as HTMLInputElement;
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await settle();
    assert.ok(screen.getByText("Press Ctrl+C / Cmd+C to copy"), "expected the fallback hint to show first");

    fireEvent.blur(addressInput);
    await settle();
    // A boolean, never the raw element: on failure `assert.equal` renders a
    // diff of both operands, and a live DOM node's circular parent/owner
    // references make that diff pathologically slow (tens of seconds, not a
    // bug in the app — a footgun in the assertion itself, discovered by this
    // test's own red proof, and worth calling out rather than only working
    // around it here).
    assert.equal(
      !!screen.queryByText("Press Ctrl+C / Cmd+C to copy"),
      false,
      "expected blurring the address field to clear the fallback hint",
    );
  } finally {
    g.restore();
  }
});

const RUNNING_RELAY = {
  state: "running" as const,
  version: "1.21.1",
  ports: { rtmp: 1935, srt: 8890, webrtcUdp: 8189, webrtcHttp: 8889, hls: 8888, api: 9997 },
};

/** Mounts, rotates once, and returns whether the "could not be dropped" /
 *  "did not take the new password" notes are on screen — shared by the
 *  four R14d scenarios below, which differ only in `relay` and the
 *  rotation response's own `applied`/`kicked`. */
async function rotateAndCheckNotes(relay: VideoState["relay"], applied: boolean, kicked: "dropped" | "none" | "failed") {
  const g = stubGlobals(
    { ...makeState([pushFeed()]), kinds: ALL_KINDS, relay },
    {
      onNewPushPassword: () => ({
        status: 200,
        body: { protocol: "srt", address: "srt://192.168.1.50:8890?streamid=publish:feed-push:video:p2", password: "p2", applied, kicked },
      }),
    },
  );
  try {
    mount();
    await settle();
    await settle();
    await screen.findByLabelText("Paste this into the device");
    fireEvent.click(screen.getByRole("button", { name: "New password" }));
    await settle();
    await settle();
    return {
      appliedNote: !!screen.queryByText("The relay did not take the new password yet; it will on its next start"),
      kickedNote: !!screen.queryByText("The device already sending could not be dropped; it keeps sending until it reconnects"),
    };
  } finally {
    g.restore();
    cleanup();
    __resetReplayCacheForTests();
  }
}

test("R14d: applied:false shows its own note while the relay is running", async () => {
  const notes = await rotateAndCheckNotes(RUNNING_RELAY, false, "none");
  assert.equal(notes.appliedNote, true);
  assert.equal(notes.kickedNote, false);
});

test("R14d: kicked:\"failed\" shows its own note while the relay is running — a publisher really was connected and dropping it did not work", async () => {
  const notes = await rotateAndCheckNotes(RUNNING_RELAY, true, "failed");
  assert.equal(notes.kickedNote, true);
  assert.equal(notes.appliedNote, false);
});

test("R14d: kicked:\"none\" shows NO note while the relay is running — nobody was publishing is not a failure worth flagging", async () => {
  const notes = await rotateAndCheckNotes(RUNNING_RELAY, true, "none");
  assert.equal(notes.kickedNote, false, "\"none\" must never be read as \"could not be dropped\"");
  assert.equal(notes.appliedNote, false);
});

test("R14d: kicked:\"dropped\" shows no note either — a successful kick is not a failure", async () => {
  const notes = await rotateAndCheckNotes(RUNNING_RELAY, true, "dropped");
  assert.equal(notes.kickedNote, false);
  assert.equal(notes.appliedNote, false);
});

test("R14d: with no relay running, neither note fires even for applied:false and kicked:\"failed\"", async () => {
  const notes = await rotateAndCheckNotes({ state: "off" }, false, "failed");
  assert.equal(notes.appliedNote, false, "no relay running — the note must not fire even though applied is false");
  assert.equal(notes.kickedNote, false, "no relay running — the note must not fire even though kicked is \"failed\"");
});
