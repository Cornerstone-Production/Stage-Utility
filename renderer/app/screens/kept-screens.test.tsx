// kept-screens.test.tsx — the Screens page outlives a trip away, for ten minutes,
// and only on the shared event stream.
//
// The check is node identity: the very same <iframe> element must be in the
// document after the operator leaves and comes back. A new element is a reload,
// whatever it looks like.
//
// What jsdom cannot show, and was driven in Chromium, Firefox and WebKit against
// a real server instead: that a browser really does not reload an iframe that
// <Activity> hides (jsdom never navigates one), that the preview does not fade in
// again on return (jsdom loads no stylesheet, so nothing transitions), and that the
// shell draws this page beside its <Outlet/> (the shell cannot be rendered here:
// its live wiring's reconnect loop never settles, see page-scroll-reset.test.tsx).
//
// Nothing below passes a DOM node as an assert operand: node:assert inspects
// `actual` to build its failure message, and a live jsdom element does not finish.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, mock, test } from "node:test";

import { installRenderDom, unmountAndTeardown } from "../../test-dom.js";

const teardown = installRenderDom();

const { render, cleanup, act } = await import("@testing-library/react");
const React = await import("react");
const { KeptScreens, KEEP_MS, __keptScreens } = await import("./kept-screens.js");
const { __sseFallback } = await import("../../lib/api.js");
const { PREVIEW_MSG } = await import("../../main/preview-messages.js");
const { PAGE_SCROLLER_ID } = await import("../route-reset.js");

after(() => unmountAndTeardown(cleanup, teardown));

/** Bodies posted to /api/log/client, which is where logToServer sends a line. */
let logged: string[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  logged = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).includes("/api/log/client")) {
      const { tag, message } = JSON.parse(String(init?.body)) as { tag: string; message: string };
      logged.push(`[${tag}] ${message}`);
    }
    return new Response("{}");
  }) as typeof fetch;
  mock.method(console, "warn", () => {});
  __keptScreens.reset();
  __sseFallback.setShared(true);
});

afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
  globalThis.fetch = realFetch;
  cleanup();
  __sseFallback.setShared(false, "no SharedWorker in this browser");
});

/** The page under test: one iframe, which is what a Screens card's preview is. */
function page(path: string, resetKey = 0) {
  return React.createElement(KeptScreens, {
    pathname: path,
    resetKey,
    children: React.createElement("iframe", { title: "View preview", src: "about:blank" }),
  });
}

function frame(): HTMLIFrameElement | null {
  return document.querySelector('iframe[title="View preview"]');
}

/** Render at Screens and take the iframe; `go` then moves the operator. */
function visitScreens() {
  return visitScreensAt("/screens");
}

function visitScreensAt(path: string) {
  const view = render(page(path));
  const first = frame();
  assert.ok(first, "the page did not render its preview");
  return {
    first,
    go: (path: string, resetKey = 0) => act(() => view.rerender(page(path, resetKey))),
  };
}

test("away to Home and back: the same iframe, never a new one", async () => {
  const { first, go } = visitScreens();
  await go("/");
  assert.ok(frame() === first, "leaving removed the preview's iframe");
  assert.equal(frame()?.closest("[style*='display: none']") !== null, true, "the kept page is not hidden while away");
  await go("/screens");
  assert.ok(frame() === first, "coming back made a new iframe: that is a reload");
});

test("the keep runs out KEEP_MS after leaving, and the next visit is cold", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const { first, go } = visitScreens();
  await go("/");
  await act(async () => mock.timers.tick(KEEP_MS - 1));
  assert.ok(frame() === first, "dropped before the keep ran out");
  await act(async () => mock.timers.tick(1));
  assert.ok(frame() === null, "still kept after the keep ran out");
  await go("/screens");
  assert.ok(frame() && frame() !== first, "the visit after the keep ran out reused the old iframe");
});

test("coming back cancels the keep, and the next leave starts it again", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const { first, go } = visitScreens();
  await go("/");
  await act(async () => mock.timers.tick(KEEP_MS - 1000));
  await go("/screens");
  await go("/");
  // Past the FIRST leave's deadline, inside the second's.
  await act(async () => mock.timers.tick(KEEP_MS - 1000));
  assert.ok(frame() === first, "the first leave's timer still dropped the page");
  await act(async () => mock.timers.tick(1000));
  assert.ok(frame() === null, "the second leave did not start a keep of its own");
});

test("off the shared stream, leaving drops the page as it always did, and says why once", async () => {
  __sseFallback.setShared(false, "poll transport");
  const { first, go } = visitScreens();
  await go("/");
  assert.ok(frame() === null, "kept a page whose previews would each hold a connection");
  await go("/screens");
  assert.ok(frame() && frame() !== first, "came back to the old iframe off the shared stream");
  await go("/");
  assert.deepEqual(logged, ["[preview] not keeping the Screens previews while away: poll transport"]);
});

test("losing the shared stream while away drops the kept page at once", async () => {
  const { go } = visitScreens();
  await go("/");
  assert.ok(frame(), "not kept on the shared stream");
  await act(async () => __sseFallback.setShared(false, "worker abandoned: no pong"));
  assert.ok(frame() === null, "kept twelve previews that now each hold an EventSource");
  assert.deepEqual(logged, ["[preview] not keeping the Screens previews while away: worker abandoned: no pong"]);
});

test("re-selecting Screens rebuilds it; re-selecting another page while away does not", async () => {
  const { first, go } = visitScreens();
  await go("/", 0);
  await go("/", 1); // Home re-selected while Screens is hidden
  await go("/screens", 1);
  assert.ok(frame() === first, "a re-select of Home rebuilt the hidden Screens page");
  await go("/screens", 2); // Screens re-selected while on it
  assert.ok(frame() && frame() !== first, "re-selecting Screens did not rebuild it");
});

test("the router's /screens route draws nothing, so the page is never drawn twice", async () => {
  // The shell draws the kept page. A route that drew it too would mount a second
  // Screens page, with a second set of previews, beside the kept one.
  const { DESTINATIONS } = await import("../destinations.js");
  const { ScreensRouteSlot } = await import("./kept-screens.js");
  const screens = DESTINATIONS.find((d) => d.path === "/screens");
  assert.ok(screens?.Component === ScreensRouteSlot, "the /screens route renders a page of its own");
});

test("/screens/ with its trailing slash is the same kept page", async () => {
  const { first, go } = visitScreensAt("/screens/");
  await go("/");
  await go("/screens/");
  assert.ok(frame() === first, "the slashed address reloaded the preview, or drew no page");
});

/**
 * The shell's scrolling <main>, with a scroll offset jsdom will keep: jsdom lays
 * nothing out, so a real element's scrollTop is always 0 (see page-scroll-reset).
 */
function pane(): HTMLElement & { scrollTo: (top: number) => void } {
  const el = document.createElement("main");
  el.setAttribute("data-scroll-restoration-id", PAGE_SCROLLER_ID);
  let top = 0;
  Object.defineProperty(el, "scrollTop", { get: () => top, set: (v: number) => { top = v; } });
  document.body.append(el);
  return Object.assign(el, {
    scrollTo(next: number) {
      top = next;
      el.dispatchEvent(new Event("scroll"));
    },
  });
}

test("coming back restores where the operator was scrolled, so the same cards stay in view", async () => {
  const main = pane();
  try {
    const { go } = visitScreens();
    main.scrollTo(900);
    await go("/");
    // Home is shorter, and the router sends a forward navigation to the top: the
    // pane scrolls while the page is hidden, which is not the operator.
    main.scrollTo(0);
    await go("/screens");
    assert.equal(main.scrollTop, 900, "the kept page came back at the top, so its kept previews went cold");
  } finally {
    main.remove();
  }
});

test("a page dropped by the keep comes back cold, at the top", async () => {
  const main = pane();
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { go } = visitScreens();
    main.scrollTo(900);
    await go("/");
    main.scrollTo(0);
    await act(async () => mock.timers.tick(KEEP_MS));
    await go("/screens");
    assert.equal(main.scrollTop, 0, "a cold page was scrolled to where an old one had been");
  } finally {
    main.remove();
  }
});

test("a preview off the shared stream drops the kept page while away, and says why once", async () => {
  const { go } = visitScreens();
  await go("/");
  assert.ok(frame(), "not kept on the shared stream");
  await act(async () => {
    const event = new MessageEvent("message", {
      data: { type: PREVIEW_MSG.LIVE, viewId: "v1", live: true, since: null, shared: false },
      origin: window.location.origin,
    });
    Object.defineProperty(event, "source", { value: frame()!.contentWindow });
    window.dispatchEvent(event);
  });
  assert.ok(frame() === null, "kept a preview that holds an EventSource of its own");
  assert.deepEqual(logged, ["[preview] not keeping the Screens previews while away: a preview is off the shared event stream"]);
});

test("a preview that falls off the shared stream and comes back does not drop the keep on a later leave", async () => {
  const { first, go } = visitScreens();
  const say = (shared: boolean) =>
    act(async () => {
      const event = new MessageEvent("message", {
        data: { type: PREVIEW_MSG.LIVE, viewId: "v1", live: true, since: null, shared },
        origin: window.location.origin,
      });
      Object.defineProperty(event, "source", { value: frame()!.contentWindow });
      window.dispatchEvent(event);
    });
  await say(false);
  await say(true);
  await go("/");
  assert.ok(frame() === first, "a preview back on the shared stream still dropped the keep");
  assert.deepEqual(logged, []);
});
