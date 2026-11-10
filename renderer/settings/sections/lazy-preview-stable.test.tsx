// lazy-preview-stable.test.tsx — the preview iframe survives the side panel
// opening and closing.
//
// The Screens card passes `following` only while its panel is open. LazyPreview
// once built a different element tree for each case, so React remounted the
// preview and the iframe reloaded on every toggle. The check is node identity:
// the very same <iframe> element must be in the document after `following`
// changes, in both directions.
//
// NOT covered here: the fade (jsdom loads no stylesheet, so opacity and
// transitions are unobservable) and that the iframe really does not re-navigate
// - both were driven in a browser.
//
// Nothing below passes a DOM node as an assert operand: node:assert inspects
// `actual` to build its failure message, and a live jsdom element does not finish.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { eventually, installRenderDom, unmountAndTeardown } from "../../test-dom.js";

const teardown = installRenderDom();

const { render, screen, cleanup } = await import("@testing-library/react");
const React = await import("react");
const { LazyPreview, __previewLimits } = await import("./lazy-preview.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => {
  cleanup();
  __previewLimits.reset();
});

function card(following: { label: string } | undefined) {
  return React.createElement(LazyPreview, {
    viewId: "v1",
    outputId: "o1",
    onExpand: () => {},
    expandLabel: "Edit it",
    following,
  });
}

async function streamingIframe(container: HTMLElement): Promise<HTMLIFrameElement> {
  let el: HTMLIFrameElement | null = null;
  await eventually(() => {
    el = container.querySelector("iframe");
    assert.ok(el, "the preview never started streaming");
  });
  return el as unknown as HTMLIFrameElement;
}

test("opening the side panel keeps the same iframe", async () => {
  const { container, rerender } = render(card(undefined));
  const before = await streamingIframe(container);
  rerender(card({ label: "Show settings for X" }));
  const after = container.querySelector("iframe");
  assert.ok(after === before, "the iframe was remounted when `following` appeared");
  assert.ok(before.isConnected);
  // And the chrome did change: the follow label is on the card now.
  assert.ok(screen.getByRole("button", { name: "Show settings for X" }));
});

test("closing the side panel keeps the same iframe", async () => {
  const { container, rerender } = render(card({ label: "Show settings for X" }));
  const before = await streamingIframe(container);
  rerender(card(undefined));
  const after = container.querySelector("iframe");
  assert.ok(after === before, "the iframe was remounted when `following` went away");
  assert.ok(before.isConnected);
  assert.ok(screen.getByRole("button", { name: "Edit it" }));
});

// ---- Fade in once loaded, fade out on leaving, cap still held -----------------
//
// The opacity classes are asserted, not the pixels: jsdom paints nothing. What is
// pinned is the sequence - hidden until the iframe's load event, hidden again the
// moment the card leaves the screen, and the slot held until the fade has played.

type IoCallback = (entries: { isIntersecting: boolean }[]) => void;

function stubIntersectionObserver() {
  const g = globalThis as unknown as { IntersectionObserver?: unknown };
  const saved = g.IntersectionObserver;
  let cb: IoCallback | null = null;
  g.IntersectionObserver = class {
    constructor(callback: IoCallback) { cb = callback; }
    observe() {}
    disconnect() {}
  };
  return {
    set: (isIntersecting: boolean) => cb!([{ isIntersecting }]),
    restore: () => { g.IntersectionObserver = saved; },
  };
}

function fadeClass(iframe: HTMLIFrameElement): string {
  // iframe -> ViewPreview box -> the fading wrapper.
  return iframe.parentElement!.parentElement!.className;
}

test("fades in on load, fades out on leaving, and holds its slot until gone", async () => {
  const io = stubIntersectionObserver();
  try {
    const { container } = render(card(undefined));
    const { act, fireEvent } = await import("@testing-library/react");
    await act(async () => io.set(true));
    const iframe = await streamingIframe(container);
    assert.equal(__previewLimits.liveCount(), 1);
    assert.match(fadeClass(iframe), /opacity-0/, "visible before its iframe has loaded");

    await act(async () => { fireEvent.load(iframe); });
    assert.match(fadeClass(iframe), /opacity-100/, "did not fade in on load");

    await act(async () => io.set(false));
    assert.match(fadeClass(iframe), /opacity-0/, "did not start fading out on leaving");
    // Well inside the fade: long enough for an immediate release to have happened.
    await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
    assert.ok(iframe.isConnected, "the iframe went before the fade could play");
    assert.equal(__previewLimits.liveCount(), 1, "the slot was released before the iframe went");

    await eventually(() => {
      assert.ok(container.querySelector("iframe") === null, "the iframe never went");
      assert.equal(__previewLimits.liveCount(), 0, "the slot was never released");
    });
  } finally {
    io.restore();
  }
});

test("returning during the fade-out keeps the same iframe", async () => {
  const io = stubIntersectionObserver();
  try {
    const { container } = render(card(undefined));
    const { act, fireEvent } = await import("@testing-library/react");
    await act(async () => io.set(true));
    const iframe = await streamingIframe(container);
    await act(async () => { fireEvent.load(iframe); });
    await act(async () => io.set(false));
    await act(async () => io.set(true));
    assert.ok(container.querySelector("iframe") === iframe, "the iframe was remounted");
    assert.match(fadeClass(iframe), /opacity-100/);
    await new Promise((r) => setTimeout(r, 350));
    assert.ok(container.querySelector("iframe") === iframe, "the cancelled fade-out still unmounted it");
    assert.equal(__previewLimits.liveCount(), 1);
  } finally {
    io.restore();
  }
});
