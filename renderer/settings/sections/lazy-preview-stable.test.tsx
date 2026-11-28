// lazy-preview-stable.test.tsx — the preview iframe survives the side panel
// opening and closing, fades in once its page says it is live, says so when it
// never does, and is kept for a grace window after it leaves so scrolling straight
// back does not reload it.
//
// The Screens card passes `following` only while its panel is open. LazyPreview
// once built a different element tree for each case, so React remounted the
// preview and the iframe reloaded on every toggle. The check is node identity:
// the very same <iframe> element must be in the document after `following`
// changes, in both directions.
//
// The fade is pinned by its opacity CLASSES and the order they change in, under
// a fake clock. What jsdom cannot show was driven in a browser instead: the
// pixels (it loads no stylesheet, so nothing here paints or transitions), and
// that the kept iframe really does not re-navigate.
//
// Nothing below passes a DOM node as an assert operand: node:assert inspects
// `actual` to build its failure message, and a live jsdom element does not finish.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { after, afterEach, mock, test } from "node:test";

import { installRenderDom, unmountAndTeardown } from "../../test-dom.js";

const teardown = installRenderDom();

const { render, screen, cleanup, act, fireEvent } = await import("@testing-library/react");
const { within } = await import("@testing-library/react");
const React = await import("react");
const { LazyPreview, __previewLimits } = await import("./lazy-preview.js");
const { PREVIEW_MSG } = await import("../../main/preview-messages.js");

const { FADE_MS, LOAD_TIMEOUT_MS } = __previewLimits;

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => {
  mock.timers.reset();
  cleanup();
  restoreIo?.();
  restoreIo = null;
  __previewLimits.reset();
});

function card(following?: { label: string }, viewId = "v1", aspect?: number) {
  return React.createElement(LazyPreview, {
    viewId,
    outputId: "o1",
    name: "Stage Left",
    aspect,
    onExpand: () => {},
    expandLabel: "Edit it",
    following,
  });
}

// jsdom has no IntersectionObserver. This one is driven by hand: `scroll(true)`
// brings every card on screen, `scroll(false)` takes them off.
type IoCallback = (entries: { isIntersecting: boolean }[]) => void;
let restoreIo: (() => void) | null = null;
/** The options the last IntersectionObserver was built with. */
let ioOptions: IntersectionObserverInit | undefined;

function stubIntersectionObserver(): (isIntersecting: boolean) => void {
  const g = globalThis as unknown as { IntersectionObserver?: unknown };
  const saved = g.IntersectionObserver;
  // Every observer built, so a page of several cards scrolls together.
  const cbs: IoCallback[] = [];
  g.IntersectionObserver = class {
    constructor(callback: IoCallback, options?: IntersectionObserverInit) {
      cbs.push(callback);
      ioOptions = options;
    }
    observe() {}
    disconnect() {}
  };
  restoreIo = () => { g.IntersectionObserver = saved; };
  return (isIntersecting) => { for (const cb of cbs) cb([{ isIntersecting }]); };
}

/**
 * Render a card, bring it on screen and let it claim its slot, all inside act:
 * the claim runs on microtasks, and polling for it outside act is what printed
 * "not wrapped in act(...)". The clock is faked from here on, so the fade timer
 * moves only when a test ticks it.
 */
async function mount(element: React.ReactElement = card()) {
  const io = stubIntersectionObserver();
  mock.timers.enable({ apis: ["setTimeout"] });
  let result!: ReturnType<typeof render>;
  await act(async () => { result = render(element); });
  const scroll = (isIntersecting: boolean) => act(async () => { io(isIntersecting); });
  await scroll(true);
  const iframe = result.container.querySelector("iframe");
  assert.ok(iframe, "the preview never started streaming");
  return { ...result, iframe, scroll };
}

const tick = (ms: number) => act(async () => { mock.timers.tick(ms); });
/** The page inside the iframe saying it is live (or not), as stage-view.tsx does. */
const report = (iframe: HTMLIFrameElement, live: boolean, viewId = iframeViewId(iframe)) =>
  act(async () => {
    const event = new MessageEvent("message", {
      data: { type: PREVIEW_MSG.LIVE, viewId, live, since: live ? null : Date.now(), shared: true },
      origin: window.location.origin,
    });
    // jsdom's constructor refuses an iframe's window as `source`; the card matches
    // on it, so it is set on the event instead.
    Object.defineProperty(event, "source", { value: iframe.contentWindow });
    window.dispatchEvent(event);
  });
const goLive = (iframe: HTMLIFrameElement) => report(iframe, true);
/** The view an iframe previews, from its address: `/preview-<viewId>`. */
function iframeViewId(iframe: HTMLIFrameElement): string {
  return decodeURIComponent(new URL(iframe.getAttribute("src")!, "http://x").pathname.slice("/preview-".length));
}

/** The class list of the wrapper that fades, wherever it sits above the iframe. */
function fadeClass(iframe: HTMLIFrameElement): string {
  const wrapper = iframe.closest(".transition-opacity");
  assert.ok(wrapper, "no fading wrapper above the iframe");
  return wrapper.className;
}

test("opening the side panel keeps the same iframe", async () => {
  const { container, rerender, iframe: before } = await mount(card(undefined));
  rerender(card({ label: "Show settings for X" }));
  const after = container.querySelector("iframe");
  assert.ok(after === before, "the iframe was remounted when `following` appeared");
  assert.ok(before.isConnected);
  // And the chrome did change: the follow label is on the card now.
  assert.ok(screen.getByRole("button", { name: "Show settings for X" }));
});

test("closing the side panel keeps the same iframe", async () => {
  const { container, rerender, iframe: before } = await mount(card({ label: "Show settings for X" }));
  rerender(card(undefined));
  const after = container.querySelector("iframe");
  assert.ok(after === before, "the iframe was remounted when `following` went away");
  assert.ok(before.isConnected);
  assert.ok(screen.getByRole("button", { name: "Edit it" }));
});

// ---- Fade in once live, kept for FADE_MS after leaving, cap still held -------
//
// What is pinned is the sequence: hidden until the page says it is live,
// transparent again the moment the card leaves (which is 200px off screen, so
// nobody sees it go), and the iframe and slot kept for FADE_MS, to the
// millisecond.

test("fades in once live, goes transparent on leaving, and holds its slot for FADE_MS", async () => {
  const { container, iframe, scroll } = await mount();
  assert.equal(__previewLimits.liveCount(), 1);
  assert.match(fadeClass(iframe), /opacity-0/, "visible before its page said it was live");

  await goLive(iframe);
  assert.match(fadeClass(iframe), /opacity-100/, "did not fade in once live");

  await scroll(false);
  assert.match(fadeClass(iframe), /opacity-0/, "did not go transparent on leaving");
  await tick(FADE_MS - 1);
  assert.ok(iframe.isConnected, "the iframe went before FADE_MS was up");
  assert.equal(__previewLimits.liveCount(), 1, "the slot was released before the iframe went");

  await tick(1);
  assert.ok(container.querySelector("iframe") === null, "the iframe outlived FADE_MS");
  assert.equal(__previewLimits.liveCount(), 0, "the slot was not released when FADE_MS was up");
});

test("coming back within FADE_MS keeps the same iframe", async () => {
  const { container, iframe, scroll } = await mount();
  await goLive(iframe);
  await scroll(false);
  await tick(FADE_MS - 1);
  await scroll(true);
  assert.ok(container.querySelector("iframe") === iframe, "the iframe was remounted");
  assert.match(fadeClass(iframe), /opacity-100/);
  await tick(FADE_MS);
  assert.ok(container.querySelector("iframe") === iframe, "the cancelled release still unmounted it");
  assert.equal(__previewLimits.liveCount(), 1);
});

// ---- A new iframe starts hidden, whatever came before it ----------------------
//
// `live` describes ONE iframe. Each case below swaps the iframe while the card
// stays mounted, after the old one had gone live and shown.

for (const [what, next] of [
  ["picking a different view", card(undefined, "v2")],
  ["a different aspect", card(undefined, "v1", 4 / 3)],
] as const) {
  test(`${what} hides the new iframe until it is live`, async () => {
    const { container, rerender, iframe: old } = await mount();
    await goLive(old);
    assert.match(fadeClass(old), /opacity-100/);

    rerender(next);
    const fresh = container.querySelector("iframe");
    assert.ok(fresh, "the preview stopped streaming");
    assert.ok(fresh !== old, "ViewPreview kept its iframe, so this case tests nothing");
    assert.match(fadeClass(fresh), /opacity-0/, "the new iframe showed before it was live");

    await goLive(fresh);
    assert.match(fadeClass(fresh), /opacity-100/, "the new iframe never faded in");
  });
}

test("coming back after FADE_MS hides the new iframe until it is live", async () => {
  const { container, iframe: old, scroll } = await mount();
  await goLive(old);
  await scroll(false);
  await tick(FADE_MS);
  assert.ok(container.querySelector("iframe") === null, "FADE_MS passed and the iframe was not released");

  await scroll(true);
  const fresh = container.querySelector("iframe");
  assert.ok(fresh, "the preview did not stream again");
  assert.match(fadeClass(fresh), /opacity-0/, "the returning iframe showed before it was live");
  await goLive(fresh);
  assert.match(fadeClass(fresh), /opacity-100/);
});

// ---- Unmounting gives the slot back -------------------------------------------
//
// Read before afterEach's reset(), which would otherwise hide a slot that leaked:
// the cap is module state, so a card deleted while it streamed would hold its
// slot for the life of the page.

test("unmounting a streaming preview releases its slot", async () => {
  const { iframe, unmount } = await mount();
  await goLive(iframe);
  assert.equal(__previewLimits.liveCount(), 1);
  unmount();
  assert.equal(__previewLimits.liveCount(), 0, "the unmounted preview kept its slot");
});

test("unmounting a preview inside its FADE_MS hold releases its slot", async () => {
  const { iframe, unmount, scroll } = await mount();
  await goLive(iframe);
  await scroll(false);
  await tick(FADE_MS - 1);
  unmount();
  assert.equal(__previewLimits.liveCount(), 0, "the unmounted preview kept its slot");
  // The release timer was cleared with the card, so it cannot release anything later.
  await tick(FADE_MS);
  assert.equal(__previewLimits.liveCount(), 0);
});

// ---- The hold is as long as the transition ------------------------------------
//
// The opacity transition runs at --motion-settled, a CSS token; the iframe and
// slot are held for FADE_MS, a JS constant. Neither can be the source of the other cleanly: an inline
// duration would leave the token system (motion-tokens.test.ts forbids literal
// durations), and reading the token at runtime needs a fallback constant for
// when there is no stylesheet, which is this duplication again. So they are
// tied here, so an iframe is never removed part way through its transition. The
// leaving half of it plays off screen today; the tie is what keeps it whole if
// a card is ever made to leave while it can still be seen.
//
// Read from the DECLARATION at the start of a line, so a comment naming the
// token cannot satisfy it, and from the rendered class, so the wrapper really
// uses that token.

test("FADE_MS is --motion-settled, and the fade runs at --motion-settled", async () => {
  const css = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
  const declared = [...css.matchAll(/^\s*--motion-settled:\s*(\d+)ms\s*;/gm)].map((m) => Number(m[1]));
  assert.deepEqual(declared, [FADE_MS], "FADE_MS and --motion-settled in styles.css disagree");

  const { iframe } = await mount();
  assert.match(fadeClass(iframe), /(^|\s)duration-\(--motion-settled\)(\s|$)/, "the fade does not run at --motion-settled");
});

// ---- The pre-load margin reaches the page's own scroller ----------------------
//
// The Screens page scrolls inside a <main>, not the window. rootMargin only grows
// the observer's ROOT, and every scrolling ancestor still clips at its own edge,
// so with the viewport as root the 200px did nothing: measured in a browser, a
// card 100px below the fold was not live. jsdom computes no layout, so what is
// pinned here is the root the observer is given; the pre-load itself was driven
// in a browser.

test("the observer's root is the nearest scrolling ancestor, so its margin pre-loads", async () => {
  await mount(
    React.createElement("div", { "data-testid": "scroller", style: { overflowY: "auto" } },
      React.createElement("div", null, card())),
  );
  assert.ok(ioOptions?.root === screen.getByTestId("scroller"), "the observer is not rooted on the scroller");
  assert.equal(ioOptions?.rootMargin, "200px");
});

test("with no scrolling ancestor the observer's root is the viewport", async () => {
  await mount();
  assert.ok(ioOptions, "no observer was built");
  assert.ok((ioOptions.root ?? null) === null, "the observer was rooted on an element that does not scroll");
});

// ---- Live is what the page says, not what the iframe's load event says ----------
//
// `load` fires for a browser error page too, and before the page has any state to
// draw. The fade waited on it, so a preview that could not load faded in a picture
// of a failure, and one that loaded and never drew sat black for good.

/** Lines logToServer sent while `run` ran. */
async function logged(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).includes("/api/log/client")) {
      const { tag, message } = JSON.parse(String(init?.body)) as { tag: string; message: string };
      lines.push(`[${tag}] ${message}`);
    }
    return new Response("{}");
  }) as typeof fetch;
  const warn = mock.method(console, "warn", () => {});
  try {
    await run();
  } finally {
    globalThis.fetch = real;
    warn.mock.restore();
  }
  return lines;
}

test("the iframe's load event alone does not fade the preview in", async () => {
  const { iframe } = await mount();
  await act(async () => { fireEvent.load(iframe); });
  assert.match(fadeClass(iframe), /opacity-0/, "faded in on `load`, before the page said it was live");
});

test("a page that never says it is live: the card says so, logs it once, and Retry loads it again", async () => {
  let iframe!: HTMLIFrameElement;
  let container!: HTMLElement;
  const lines = await logged(async () => {
    ({ iframe, container } = await mount());
    await tick(LOAD_TIMEOUT_MS - 1);
    assert.equal(screen.getByRole("status").textContent, "", "gave up before LOAD_TIMEOUT_MS");
    await tick(1);
  });
  assert.equal(screen.getByRole("status").textContent, "Preview didn’t load", "a preview that never went live said nothing");
  assert.match(container.textContent ?? "", /This preview only: the screen’s own status is above\./);
  assert.match(fadeClass(iframe), /opacity-0/, "the failed preview faded in");
  assert.deepEqual(lines, ["[preview] Stage Left: the preview did not go live (no answer in 10 s)"]);

  await act(async () => { fireEvent.click(within(container).getByRole("button", { name: "Retry preview of Stage Left" })); });
  const fresh = container.querySelector("iframe");
  assert.ok(fresh && fresh !== iframe, "Retry did not load a new iframe");
  assert.equal(screen.getByRole("status").textContent, "", "the notice outlived the retry");
  assert.ok(document.activeElement === within(container).getByRole("button", { name: "Edit it" }), "Retry dropped the focus instead of handing it to the new preview");
  await goLive(fresh);
  assert.match(fadeClass(fresh), /opacity-100/, "the retried preview never faded in");
});

test("a report from another card's iframe of the same view does not move this one", async () => {
  const io = stubIntersectionObserver();
  mock.timers.enable({ apis: ["setTimeout"] });
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(React.createElement("div", null, card(undefined, "v1"), card(undefined, "v1")));
  });
  await act(async () => { io(true); });
  const frames = [...view.container.querySelectorAll("iframe")];
  assert.equal(frames.length, 2);
  await goLive(frames[0]);
  assert.match(fadeClass(frames[0]), /opacity-100/);
  assert.match(fadeClass(frames[1]), /opacity-0/, "one page's report faded in the other card's preview");
});

for (const [what, contentWindow] of [
  ["an address it cannot read (a browser error page)", { postMessage() {}, get location(): Location { throw new DOMException("Blocked a frame", "SecurityError"); } }],
  ["an address that is not a preview's", { postMessage() {}, location: { pathname: "/" } }],
] as const) {
  test(`an iframe that loads ${what} says the page did not load, at once`, async () => {
    let iframe!: HTMLIFrameElement;
    const lines = await logged(async () => {
      ({ iframe } = await mount());
      Object.defineProperty(iframe, "contentWindow", { configurable: true, get: () => contentWindow });
      await act(async () => { fireEvent.load(iframe); });
    });
    assert.equal(screen.getByRole("status").textContent, "Preview didn’t load", "an error page was taken for a preview still loading");
    assert.deepEqual(lines, ["[preview] Stage Left: the preview did not go live (the page did not load)"]);
  });
}
