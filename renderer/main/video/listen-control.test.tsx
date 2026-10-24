// renderer/main/video/listen-control.test.tsx — the Listen button, driven through
// the REAL Video widget with a stubbed fetch, RTCPeerConnection, IntersectionObserver
// and media element.
//
// NOT covered here, and why: jsdom loads no stylesheet and measures every box as
// zero, so where the cluster sits on the picture, the clamp()ed sizes, the bar
// heights and whether the control overlaps the name tag cannot be seen from this
// file. Whether a browser lets the stream play with sound after a real tap, and
// whether the meter reads a level off a real WebRTC stream, are checked in
// Chromium instead (docs/integrations/video-feeds.md, "Listening"). What is
// asserted here is what is rendered, when, and what a tap sends.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, mock, test } from "node:test";

import { act } from "react";

import { installRenderDom, settle, unmountAndTeardown } from "../../test-dom.js";
import { FAKE_SDP, FakePeerConnection, installFakePeerConnection } from "../../test-fixtures/fake-peer-connection.js";
import { FakeEventSource } from "../../test-fixtures/fake-event-source.js";
import { installFakeHls } from "../../test-fixtures/fake-hls.js";
import { DEFAULT_VIDEO_PORTS } from "@main/types/video";

const teardown = installRenderDom();

const { render, screen, cleanup, fireEvent } = await import("@testing-library/react");
const React = await import("react");
const { VideoObject } = await import("./video-object.js");
const { ListenControl } = await import("./listen-control.js");
const { ObjectContent } = await import("../layout-renderer.js");
const { makeRenderCtx } = await import("../test-render-ctx.js");
const { __resetReplayCacheForTests } = await import("../../lib/api.js");
const { __resetPlaybackRegistryForTests } = await import("./playback-reports.js");
const { claimListen, listenOwner, VOLUME_KEY } = await import("./listen.js");

type VideoState = import("@main/types/video").VideoState;
type VideoFeedView = import("@main/types/video").VideoFeedView;
type FeedAudioStatus = import("@main/types/video").FeedAudioStatus;
type VideoConfig = Extract<LayoutObjectConfig, { type: "video" }>;

after(() => unmountAndTeardown(cleanup, teardown));

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeFeed(id: string, name: string, audio: FeedAudioStatus | undefined, overrides: Partial<VideoFeedView> = {}): VideoFeedView {
  return {
    id,
    name,
    kind: "pull",
    sourceLine: "rtsp://192.0.2.21:8554/stream2",
    source: { kind: "pull", url: "rtsp://192.0.2.21:8554/stream2", username: "" },
    play: { via: "relay", whep: `/video/${id}/whep`, hls: `/video/${id}/index.m3u8` },
    status: { state: "live" },
    audio,
    ...overrides,
  };
}

const CONVERTED = (id: string): FeedAudioStatus => ({ state: "converted", listenPath: `${id}-listen` });

function makeState(feeds: VideoFeedView[]): VideoState {
  return {
    rev: 1,
    relay: { state: "running", version: "1.21.1", ports: DEFAULT_VIDEO_PORTS },
    kinds: ["pull", "push", "embed", "external"],
    ports: DEFAULT_VIDEO_PORTS,
    binaryPresent: true,
    archivePresent: true,
    feeds,
    screens: [],
  };
}

function makeObject(feedId: string, objectId = "obj"): { o: LayoutObject; config: VideoConfig } {
  const config: VideoConfig = { type: "video", feedId };
  return { o: { id: objectId, x: 0, y: 0, w: 1, h: 1, z: 0, config }, config };
}

class StubObserver {
  static instances: StubObserver[] = [];
  readonly cb: (entries: { isIntersecting: boolean }[]) => void;
  constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
    this.cb = cb;
    StubObserver.instances.push(this);
  }
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}
const everyoneOnScreen = (on = true) => act(() => StubObserver.instances.forEach((o) => o.cb([{ isIntersecting: on }])));

/** What the relay is asked: every call, in order. `refuse` answers a WHEP POST to a matching path with that status. */
function stubGlobals(state: VideoState, refuse?: { path: string; status: number }) {
  const calls: { method: string; url: string }[] = [];
  const realFetch = globalThis.fetch;
  const realIo = (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
  const realAbortController = globalThis.AbortController;
  const realAbortSignal = globalThis.AbortSignal;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const url = String(input);
    calls.push({ method, url });
    if (url.endsWith("/api/video/state")) return { ok: true, status: 200, json: async () => state, text: async () => "" } as unknown as Response;
    if (method === "POST" && url.includes("/whep")) {
      if (refuse && url.includes(refuse.path)) return { ok: false, status: refuse.status, headers: { get: () => null }, text: async () => "" } as unknown as Response;
      return { ok: true, status: 201, headers: { get: (h: string) => (h === "Location" ? `${url}/1f2e3d4c` : null) }, text: async () => FAKE_SDP, json: async () => ({}) } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" } as unknown as Response;
  }) as typeof fetch;
  const restorePc = installFakePeerConnection();
  const realEventSource = (globalThis as unknown as { EventSource?: unknown }).EventSource;
  (globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = StubObserver;
  // jsdom's own AbortController: see video-object.test.tsx.
  globalThis.AbortController = window.AbortController;
  globalThis.AbortSignal = window.AbortSignal;
  return {
    calls,
    posts: () => calls.filter((c) => c.method === "POST" && c.url.includes("/video/")).map((c) => new URL(c.url, "http://x").pathname),
    deletes: () => calls.filter((c) => c.method === "DELETE").map((c) => new URL(c.url, "http://x").pathname),
    restore() {
      globalThis.fetch = realFetch;
      restorePc();
      (globalThis as unknown as { EventSource: unknown }).EventSource = realEventSource;
      (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = realIo;
      globalThis.AbortController = realAbortController;
      globalThis.AbortSignal = realAbortSignal;
    },
  };
}

/** jsdom plays nothing: a play() that records the element's `muted` at the moment it is asked. */
const plays: { muted: boolean }[] = [];
const mediaProto = window.HTMLMediaElement.prototype as unknown as { play: () => Promise<void> };
const realPlay = mediaProto.play;

/** jsdom's <video> has no requestVideoFrameCallback: this hands each registration back, so a test can deliver "a frame". */
function captureFrames(): { fire: () => void; restore: () => void } {
  const proto = window.HTMLVideoElement.prototype as unknown as { requestVideoFrameCallback?: (cb: () => void) => number; cancelVideoFrameCallback?: (h: number) => void };
  const pending: (() => void)[] = [];
  proto.requestVideoFrameCallback = (cb) => pending.push(cb);
  proto.cancelVideoFrameCallback = () => {};
  return {
    fire: () => {
      for (const cb of pending.splice(0)) cb();
    },
    restore: () => {
      delete proto.requestVideoFrameCallback;
      delete proto.cancelVideoFrameCallback;
    },
  };
}

beforeEach(() => {
  cleanup();
  __resetReplayCacheForTests();
  __resetPlaybackRegistryForTests();
  StubObserver.instances = [];
  FakePeerConnection.reset();
  claimListen(null);
  plays.length = 0;
  mediaProto.play = function (this: HTMLMediaElement) {
    plays.push({ muted: this.muted });
    return Promise.resolve();
  };
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  mediaProto.play = realPlay;
});

async function renderFeeds(
  feeds: VideoFeedView[],
  opts: { listen?: boolean; refuse?: { path: string; status: number } } = {},
) {
  const g = stubGlobals(makeState(feeds), opts.refuse);
  const utils = render(
    React.createElement(
      "div",
      null,
      ...feeds.map((f, i) =>
        React.createElement(VideoObject, { key: f.id, ...makeObject(f.id, `obj-${i}`), appLogo: null, appLogoMonochrome: false, allowHls: true, listen: opts.listen ?? true }),
      ),
    ),
  );
  await settle();
  await settle();
  everyoneOnScreen();
  await settle();
  await settle();
  return { ...utils, g };
}

const buttonFor = (name: string, listening = false) =>
  screen.getByRole("button", { name: listening ? `Stop listening to ${name}` : `Listen to ${name}` }) as HTMLButtonElement;
const press = async (el: HTMLElement) => {
  act(() => void fireEvent.click(el));
  await settle();
  await settle();
};
const statusText = () => document.querySelector("[data-listen-status]")?.textContent ?? "";

// ── The states ───────────────────────────────────────────────────────────────

test("a feed with audio offers an enabled Listen button, muted and uncaptioned until it is tapped", async () => {
  const { g } = await renderFeeds([makeFeed("a", "Program", CONVERTED("a"))]);
  try {
    const b = buttonFor("Program");
    assert.equal(b.disabled, false);
    assert.equal(b.getAttribute("aria-pressed"), "false");
    assert.equal(statusText(), "", "a muted feed carries no caption");
    assert.equal(document.querySelector("video")!.muted, true, "nothing may play sound before a tap");
  } finally {
    g.restore();
  }
});

test("a feed with no audio reads 'This feed has no audio' and its button is disabled", async () => {
  const { g } = await renderFeeds([makeFeed("a", "Program", { state: "none" })]);
  try {
    assert.equal(buttonFor("Program").disabled, true);
    assert.equal(statusText(), "This feed has no audio");
  } finally {
    g.restore();
  }
});

test("a converter that cannot run is disabled with the server's reason, as it gave it", async () => {
  const { g } = await renderFeeds([makeFeed("a", "Program", { state: "unavailable", reason: "ffmpeg is not installed on this server" })]);
  try {
    assert.equal(buttonFor("Program").disabled, true);
    assert.equal(statusText(), "Audio isn't available on this server: ffmpeg is not installed on this server");
  } finally {
    g.restore();
  }
});

test("a feed not seen yet is disabled, and says why", async () => {
  const { g } = await renderFeeds([makeFeed("a", "Program", { state: "unknown" })]);
  try {
    assert.equal(buttonFor("Program").disabled, true);
    assert.match(statusText(), /not known/);
  } finally {
    g.restore();
  }
});

test("a feed with no audio report (external, embed) offers no Listen at all", async () => {
  const external = makeFeed("x", "Ext", undefined, {
    kind: "external",
    source: { kind: "external", url: "http://192.0.2.60/obs/index.m3u8" },
    play: { via: "external", url: "http://192.0.2.60/obs/index.m3u8", protocol: "hls" },
    status: { state: null },
  });
  const { g } = await renderFeeds([external]);
  try {
    assert.equal(document.querySelector("[data-listen-control]"), null);
  } finally {
    g.restore();
  }
});

// ── Where it appears ─────────────────────────────────────────────────────────

test("a Video widget not told to offer Listen has no control, whatever its feed's audio", async () => {
  const { g } = await renderFeeds([makeFeed("a", "Program", CONVERTED("a"))], { listen: false });
  try {
    assert.equal(document.querySelector("[data-listen-control]"), null);
  } finally {
    g.restore();
  }
});

test("the layout renderer offers Listen on Home and nowhere else: not a wall, a kiosk, an editor preview or a console", async () => {
  const g = stubGlobals(makeState([makeFeed("a", "Program", CONVERTED("a"))]));
  try {
    const o: LayoutObject = { ...makeObject("a").o };
    const cases: { home: boolean; interactive: boolean; shows: boolean; why: string }[] = [
      { home: true, interactive: true, shows: true, why: "a Home card" },
      { home: true, interactive: false, shows: false, why: "Home in the layout editor's preview" },
      { home: false, interactive: true, shows: false, why: "an interactive console" },
      { home: false, interactive: false, shows: false, why: "a wall or kiosk" },
    ];
    for (const c of cases) {
      cleanup();
      render(React.createElement(ObjectContent, { o, ctx: makeRenderCtx({ home: c.home, interactive: c.interactive }) }));
      await settle();
      await settle();
      everyoneOnScreen();
      await settle();
      assert.equal(document.querySelector("[data-listen-control]") !== null, c.shows, c.why);
    }
  } finally {
    g.restore();
  }
});

// ── The tap ──────────────────────────────────────────────────────────────────

test("the control's tap unmutes and starts the element before it hands over the claim, in the handler itself", () => {
  const order: string[] = [];
  const el = {
    muted: true,
    volume: 0,
    play: () => {
      order.push(`play(muted=${String(el.muted)}, volume=${el.volume})`);
      return Promise.resolve();
    },
  } as unknown as HTMLVideoElement;
  const view = { disabled: false, on: false, playing: false, text: "", tone: "muted" as const };
  render(
    React.createElement(ListenControl, {
      view,
      name: "Program",
      videoEl: el,
      wanted: false,
      onToggle: (next: boolean) => order.push(`claim(${String(next)})`),
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Listen to Program" }));
  // Read at once, with no settle: an effect after the tap would not have run.
  assert.deepEqual(order, ["play(muted=false, volume=0.8)", "claim(true)"]);
});

test("tapping a converted feed plays its -listen path with audio, unmuted, and shows Listening with a slider once a frame arrives", async () => {
  const frames = captureFrames();
  const { g } = await renderFeeds([makeFeed("a", "Program", CONVERTED("a"))]);
  try {
    assert.deepEqual(g.posts(), ["/video/a/whep"], "the picture-only session first");
    await press(buttonFor("Program"));
    assert.deepEqual(g.posts(), ["/video/a/whep", "/video/a-listen/whep"], "the picture moves to the listening session");
    assert.deepEqual(FakePeerConnection.instances.at(-1)?.transceivers, ["video", "audio"], "the listening session must ask for audio");
    assert.equal(document.querySelector("video")!.muted, false);
    assert.equal(statusText(), "Starting audio…");
    assert.equal(buttonFor("Program", true).getAttribute("aria-pressed"), "true");
    assert.equal(screen.queryByRole("slider"), null, "the slider waits for the sound");

    act(() => frames.fire());
    await settle();
    assert.equal(statusText(), "Listening");
    assert.ok(screen.getByRole("slider", { name: "Volume for Program" }));
    assert.ok(plays.some((p) => !p.muted), "no play() ran with the element unmuted");
  } finally {
    frames.restore();
    g.restore();
  }
});

test("a feed already in Opus or G.711 is listened to on its own path, with audio asked for", async () => {
  const { g } = await renderFeeds([makeFeed("a", "Program", { state: "direct", listenPath: "a" })]);
  try {
    await press(buttonFor("Program"));
    assert.deepEqual(g.posts().slice(-1), ["/video/a/whep"]);
    assert.deepEqual(FakePeerConnection.instances.at(-1)?.transceivers, ["video", "audio"]);
    assert.equal(g.posts().filter((p) => p.endsWith("-listen/whep")).length, 0);
  } finally {
    g.restore();
  }
});

test("stopping puts the tile back on its video-only session and mutes it", async () => {
  const { g } = await renderFeeds([makeFeed("a", "Program", CONVERTED("a"))]);
  try {
    await press(buttonFor("Program"));
    await press(buttonFor("Program", true));
    assert.deepEqual(g.posts(), ["/video/a/whep", "/video/a-listen/whep", "/video/a/whep"]);
    assert.deepEqual(FakePeerConnection.instances.at(-1)?.transceivers, ["video"]);
    assert.deepEqual(g.deletes().filter((p) => p.startsWith("/video/a-listen/")).length, 1, "the listening session was ended");
    assert.equal(document.querySelector("video")!.muted, true);
    assert.equal(listenOwner(), null);
  } finally {
    g.restore();
  }
});

// ── One feed per page ────────────────────────────────────────────────────────

test("tapping another feed moves the sound: the first goes back to muted and to its own session", async () => {
  const { g } = await renderFeeds([makeFeed("a", "Alpha", CONVERTED("a")), makeFeed("b", "Bravo", CONVERTED("b"))]);
  try {
    await press(buttonFor("Alpha"));
    assert.equal(buttonFor("Alpha", true).getAttribute("aria-pressed"), "true");
    await press(buttonFor("Bravo"));

    assert.equal(buttonFor("Alpha").getAttribute("aria-pressed"), "false", "the first feed kept listening");
    assert.equal(buttonFor("Bravo", true).getAttribute("aria-pressed"), "true");
    const [alpha, bravo] = Array.from(document.querySelectorAll("video"));
    assert.equal(alpha!.muted, true, "two rooms in your ears");
    assert.equal(bravo!.muted, false);
    const last = (id: string) => g.posts().filter((p) => p.startsWith(`/video/${id}`)).at(-1);
    assert.equal(last("a"), "/video/a/whep", "the first feed's picture did not return to its own session");
    assert.equal(last("b"), "/video/b-listen/whep");
  } finally {
    g.restore();
  }
});

test("a control that is gone gives up the sound", async () => {
  const { g, unmount } = await renderFeeds([makeFeed("a", "Alpha", CONVERTED("a"))]);
  try {
    await press(buttonFor("Alpha"));
    assert.notEqual(listenOwner(), null);
    unmount();
    assert.equal(listenOwner(), null, "an unmounted control still holds the page's sound");
  } finally {
    g.restore();
  }
});

// ── Leaving the page ─────────────────────────────────────────────────────────

test("a hidden or scrolled-away tile stops listening once it tears down", async () => {
  const { g } = await renderFeeds([makeFeed("a", "Alpha", CONVERTED("a"))]);
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    // settle() waits on a real setTimeout, which the mocked clock would never fire.
    const settleFake = () => act(async () => void (await new Promise((r) => setImmediate(r))));
    act(() => void fireEvent.click(buttonFor("Alpha")));
    await settleFake();
    await settleFake();
    assert.notEqual(listenOwner(), null);
    everyoneOnScreen(false);
    act(() => mock.timers.tick(3000));
    await settleFake();
    assert.equal(listenOwner(), null);
    assert.equal(buttonFor("Alpha").getAttribute("aria-pressed"), "false");
    assert.equal(document.querySelector("video")!.muted, true);
  } finally {
    mock.timers.reset();
    g.restore();
  }
});

test("a feed that loses its audio while it is listened to is no longer listened to", async () => {
  const { g } = await renderFeeds([makeFeed("a", "Alpha", CONVERTED("a"))]);
  try {
    await press(buttonFor("Alpha"));
    assert.notEqual(listenOwner(), null);
    act(() => FakeEventSource.last!.push("video:state", makeState([makeFeed("a", "Alpha", { state: "none" })])));
    await settle();
    await settle();
    assert.equal(listenOwner(), null, "the page is still listening to a feed with no audio");
    assert.equal(statusText(), "This feed has no audio");
    assert.equal(document.querySelector("video")!.muted, true);
  } finally {
    g.restore();
  }
});

// ── A drop, and HLS ──────────────────────────────────────────────────────────

test("a listening session the relay refuses reads 'Audio stopped, retrying'", async () => {
  const { g } = await renderFeeds([makeFeed("a", "Alpha", CONVERTED("a"))], { refuse: { path: "/video/a-listen/whep", status: 503 } });
  try {
    await press(buttonFor("Alpha"));
    await settle();
    assert.equal(statusText(), "Audio stopped, retrying");
  } finally {
    g.restore();
  }
});

test("a feed that plays over HLS, or in a browser with no HLS player, says audio needs WebRTC and opens no listening session", async () => {
  const bframes = makeFeed("a", "Alpha", CONVERTED("a"), { status: { state: "delayed", delayedBecause: "b-frames" } });
  for (const withHlsPlayer of [true, false]) {
    cleanup();
    const undoHls = withHlsPlayer ? installFakeHls() : () => {};
    const { g } = await renderFeeds([bframes]);
    try {
      await press(buttonFor("Alpha"));
      assert.match(statusText(), /needs WebRTC/, withHlsPlayer ? "HLS player" : "no player");
      assert.equal(g.posts().filter((p) => p.includes("-listen")).length, 0);
    } finally {
      g.restore();
      undoHls();
    }
  }
});

// ── Volume ───────────────────────────────────────────────────────────────────

test("the volume slider moves the element and is kept for the next visit", async () => {
  const frames = captureFrames();
  const { g } = await renderFeeds([makeFeed("a", "Alpha", CONVERTED("a"))]);
  try {
    await press(buttonFor("Alpha"));
    act(() => frames.fire());
    await settle();
    const slider = screen.getByRole("slider", { name: "Volume for Alpha" }) as HTMLInputElement;
    assert.equal(slider.value, "80");
    act(() => void fireEvent.change(slider, { target: { value: "35" } }));
    await settle();
    assert.equal(document.querySelector("video")!.volume, 0.35);
    assert.equal(window.localStorage.getItem(VOLUME_KEY), "0.35");
  } finally {
    frames.restore();
    g.restore();
  }
});

test("a browser whose storage throws still listens, and the slider still moves the sound", async () => {
  const frames = captureFrames();
  const { g } = await renderFeeds([makeFeed("a", "Alpha", CONVERTED("a"))]);
  const proto = Object.getPrototypeOf(window.localStorage) as { setItem: unknown; getItem: unknown };
  const realSet = proto.setItem;
  const realGet = proto.getItem;
  try {
    await press(buttonFor("Alpha"));
    act(() => frames.fire());
    await settle();
    proto.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    proto.getItem = () => {
      throw new Error("SecurityError");
    };
    const slider = screen.getByRole("slider", { name: "Volume for Alpha" }) as HTMLInputElement;
    act(() => void fireEvent.change(slider, { target: { value: "20" } }));
    await settle();
    assert.equal(document.querySelector("video")!.volume, 0.2, "the level did not apply for this visit");
  } finally {
    proto.setItem = realSet;
    proto.getItem = realGet;
    frames.restore();
    g.restore();
  }
});
