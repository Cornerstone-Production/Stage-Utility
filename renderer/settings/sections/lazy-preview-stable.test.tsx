// lazy-preview-stable.test.tsx — the preview iframe survives the side panel
// opening and closing, and fades in and out without giving up its slot early.
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
import { after, afterEach, mock, test } from "node:test";

import { installRenderDom, unmountAndTeardown } from "../../test-dom.js";

const teardown = installRenderDom();

const { render, screen, cleanup, act, fireEvent } = await import("@testing-library/react");
const React = await import("react");
const { LazyPreview, __previewLimits } = await import("./lazy-preview.js");

const { FADE_MS } = __previewLimits;

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => {
  mock.timers.reset();
  cleanup();
  restoreIo?.();
  restoreIo = null;
  __previewLimits.reset();
});

function card(following?: { label: string }, viewId = "v1") {
  return React.createElement(LazyPreview, {
    viewId,
    outputId: "o1",
    onExpand: () => {},
    expandLabel: "Edit it",
    following,
  });
}

// jsdom has no IntersectionObserver. This one is driven by hand: `scroll(true)`
// brings the card on screen, `scroll(false)` takes it off.
type IoCallback = (entries: { isIntersecting: boolean }[]) => void;
let restoreIo: (() => void) | null = null;

function stubIntersectionObserver(): (isIntersecting: boolean) => void {
  const g = globalThis as unknown as { IntersectionObserver?: unknown };
  const saved = g.IntersectionObserver;
  let cb: IoCallback | null = null;
  g.IntersectionObserver = class {
    constructor(callback: IoCallback) { cb = callback; }
    observe() {}
    disconnect() {}
  };
  restoreIo = () => { g.IntersectionObserver = saved; };
  return (isIntersecting) => cb!([{ isIntersecting }]);
}

/**
 * Render a card, bring it on screen and let it claim its slot, all inside act:
 * the claim runs on microtasks, and polling for it outside act is what printed
 * "not wrapped in act(...)". The clock is faked from here on, so the fade timer
 * moves only when a test ticks it.
 */
async function mount(element = card()) {
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
const load = (iframe: HTMLIFrameElement) => act(async () => { fireEvent.load(iframe); });

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

// ---- Fade in once loaded, fade out on leaving, cap still held -----------------
//
// What is pinned is the sequence: hidden until the iframe's load event, hidden
// again the moment the card leaves the screen, and the slot held until the fade
// has played, to the millisecond.

test("fades in on load, fades out on leaving, and holds its slot until gone", async () => {
  const { container, iframe, scroll } = await mount();
  assert.equal(__previewLimits.liveCount(), 1);
  assert.match(fadeClass(iframe), /opacity-0/, "visible before its iframe has loaded");

  await load(iframe);
  assert.match(fadeClass(iframe), /opacity-100/, "did not fade in on load");

  await scroll(false);
  assert.match(fadeClass(iframe), /opacity-0/, "did not start fading out on leaving");
  await tick(FADE_MS - 1);
  assert.ok(iframe.isConnected, "the iframe went before the fade could play");
  assert.equal(__previewLimits.liveCount(), 1, "the slot was released before the iframe went");

  await tick(1);
  assert.ok(container.querySelector("iframe") === null, "the iframe outlived the fade");
  assert.equal(__previewLimits.liveCount(), 0, "the slot was not released when the fade ended");
});

test("returning during the fade-out keeps the same iframe", async () => {
  const { container, iframe, scroll } = await mount();
  await load(iframe);
  await scroll(false);
  await tick(FADE_MS - 1);
  await scroll(true);
  assert.ok(container.querySelector("iframe") === iframe, "the iframe was remounted");
  assert.match(fadeClass(iframe), /opacity-100/);
  await tick(FADE_MS);
  assert.ok(container.querySelector("iframe") === iframe, "the cancelled fade-out still unmounted it");
  assert.equal(__previewLimits.liveCount(), 1);
});
