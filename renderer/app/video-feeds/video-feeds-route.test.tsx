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

const { render, screen, cleanup, fireEvent, within } = await import("@testing-library/react");
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

function makeState(feeds: VideoFeedView[]): VideoState {
  return { rev: 1, relay: { state: "off" }, kinds: ["embed", "external"], feeds };
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
  /** Answers a video:pushAddress GET, keyed by feed id. Default: a plain SRT
   *  address carrying "testpw". */
  onPushAddress?: (id: string) => FeedResponse;
  /** Answers a video:newPushPassword POST, keyed by feed id. Default: the
   *  same address with "rotatedpw" in place of "testpw". */
  onNewPushPassword?: (id: string) => FeedResponse;
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
    const push = url.match(/\/api\/video\/feeds\/([^/]+)\/push$/);
    if (method === "GET" && push) {
      const id = decodeURIComponent(push[1]!);
      const r = opts.onPushAddress?.(id) ?? {
        status: 200,
        body: { protocol: "srt", address: `srt://192.168.1.50:8890?streamid=publish:${id}:video:testpw`, password: "testpw" },
      };
      return { ok: r.status < 400, status: r.status, json: async () => r.body, text: async () => "" } as unknown as Response;
    }
    const newPassword = url.match(/\/api\/video\/feeds\/([^/]+)\/push\/new-password$/);
    if (method === "POST" && newPassword) {
      const id = decodeURIComponent(newPassword[1]!);
      const r = opts.onNewPushPassword?.(id) ?? {
        status: 200,
        body: { protocol: "srt", address: `srt://192.168.1.50:8890?streamid=publish:${id}:video:rotatedpw`, password: "rotatedpw" },
      };
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

test("a feed delayed by B-frames shows the design's warning callout with the OBS fix text; a live feed shows none", async () => {
  const g = stubGlobals({
    ...makeState([pullFeed({ status: { state: "delayed", delayedBecause: "b-frames" } })]),
    kinds: ALL_KINDS,
  });
  try {
    mount();
    await settle();
    await settle();
    assert.ok(screen.getByText(/Keyframe interval 1 s with B-frames 0/), "expected the OBS B-frames fix text");
  } finally {
    g.restore();
  }

  const g2 = stubGlobals({
    ...makeState([pullFeed({ status: { state: "live" } })]),
    kinds: ALL_KINDS,
  });
  try {
    cleanup();
    __resetReplayCacheForTests();
    mount();
    await settle();
    await settle();
    assert.equal(screen.queryByText(/Keyframe interval/), null, "a live feed must show no delay warning");
  } finally {
    g2.restore();
  }
});
