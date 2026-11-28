// The scrollable transcript feed (the Transcription page) keeps following the
// newest line, and lets an operator scroll up to read back.
//
// THE BUG. "Following" used to be recomputed from live layout on every scroll
// event (`scrollHeight - scrollTop - clientHeight < 48`). A scroll event is
// delivered a frame after the scroll that caused it, and under real caption
// traffic React has often committed more lines (or a line has wrapped further)
// by then: the handler read the feed as off the bottom, following turned off,
// and nothing turned it back on. The page then sat still while captions went on
// arriving below it, in Chrome and in WebKit, until a reload.
//
// WHAT THIS CHECKS, AND HOW. jsdom does no layout, so each test gives the
// scroller a small fake one (`fakeLayout` below): a height per row, a fixed
// viewport, a scrollTop the browser clamps, and a scrollIntoView that scrolls
// the feed to its end as a browser would. Scroll events are dispatched by hand,
// where a browser would deliver them. What the browser decides on its own —
// scroll anchoring, when a scroll event is actually dispatched, how a line
// rewraps when a font loads — is not modelled here; it was driven in Playwright
// Chromium and WebKit against a fake ProdCom. See the commit.
//
// Proven red: the race and rewrap cases fail against the previous follow logic
// (follow recomputed from layout in onScroll, scrollIntoView in a passive
// effect); the scroll-up case fails with the "user scrolled up" branch removed,
// with the overflow-anchor toggle removed,
// and again with the "back at the bottom" branch removed; the wheel, up-key and
// scrollbar cases fail with the release at the pin removed, and the scrollbar
// case also fails when that release needs recent wheel, touch or key input; the
// shrink case fails when the release does not check for the bottom; and the
// scrolls-nothing case fails when input alone ends following.
//
// Driven through a real server fed by a fake ProdCom, from a full 100-line buffer
// with 5-line bursts of varied heights, in Chromium (headless shell 1243) and
// WebKit (2359), both older builds than playwright-core's pins: 3 minutes of
// following read 0 px from the bottom on all 360 samples in each; a scrollTop
// change with no input event, standing in for a scrollbar drag, and a wheel up
// each held the reader's line still through 15 s of bursts; scrolling back to the
// bottom followed again. Touch and the keyboard were not driven, and neither was a
// real scrollbar thumb. A scroll-up by any means ends following through the
// "moved up" rule, at the pin or at its scroll event, with no input event needed.

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installRenderDom, unmountAndTeardown } from "../test-dom.js";

const teardown = installRenderDom();
const { render, cleanup, act } = await import("@testing-library/react");
const { createRoot } = await import("react-dom/client");
const { TranscriptFeed } = await import("./transcript-feed.js");

after(() => unmountAndTeardown(cleanup, teardown));

const VIEWPORT = 1000;
let rowHeight = 50;
let roCallbacks: (() => void)[] = [];
const g = globalThis as unknown as Record<string, unknown>;
// installDom copies jsdom's window globals onto globalThis, which is where the
// component reads ResizeObserver from.
const savedRO = g.ResizeObserver;
const savedIntoView = (g.Element as { prototype: Record<string, unknown> }).prototype.scrollIntoView;

beforeEach(() => {
  rowHeight = 50;
  roCallbacks = [];
  // A ResizeObserver the test can fire, to stand in for a line rewrapping.
  g.ResizeObserver = class {
    private cb: () => void;
    constructor(cb: () => void) {
      this.cb = cb;
      roCallbacks.push(() => this.cb());
    }
    observe() {}
    unobserve() {}
    disconnect() {
      roCallbacks = roCallbacks.filter((f) => f !== this.cb);
    }
  };
});
afterEach(() => {
  cleanup();
  g.ResizeObserver = savedRO;
  (g.Element as { prototype: Record<string, unknown> }).prototype.scrollIntoView = savedIntoView;
});

/** Lines from 100 on are long enough to wrap to three rows, so a new line is
 *  taller than the one it evicts and the content really grows: with every line
 *  the same height, an append plus an eviction leaves the layout unchanged and
 *  nothing here could tell following from not. */
function makeLine(i: number): TranscriptLineDTO {
  const text = i >= 100 ? `line ${i} ${"and the words keep coming ".repeat(4)}` : `line ${i}`;
  return { id: `L${i}`, channel: "1", channelName: "Pastor", color: null, text, isFinal: true, at: "2026-01-01T00:00:00.000Z" };
}
/** The server's 100-line window ending at line `last`. */
function windowEndingAt(last: number): TranscriptLineDTO[] {
  return Array.from({ length: 100 }, (_, k) => makeLine(last - 99 + k));
}

/** A layout for the scroller: every row `rowHeight` tall per 40 characters
 *  (a long line wraps), a VIEWPORT-high box,
 *  and a scrollTop held in [0, max] the way a browser clamps it. */
function fakeLayout(scroller: HTMLElement) {
  let top = 0;
  const height = () =>
    [...scroller.querySelectorAll("p")].reduce((h, p) => h + rowHeight * Math.ceil((p.textContent ?? "").length / 40), 0);
  const max = () => Math.max(0, height() - VIEWPORT);
  Object.defineProperty(scroller, "scrollHeight", { get: height, configurable: true });
  Object.defineProperty(scroller, "clientHeight", { get: () => VIEWPORT, configurable: true });
  Object.defineProperty(scroller, "scrollTop", {
    get: () => Math.min(top, max()),
    set: (v: number) => {
      top = Math.max(0, Math.min(v, max()));
    },
    configurable: true,
  });
  // block: "end" on the feed's end marker scrolls the feed to its bottom.
  (g.Element as { prototype: Record<string, unknown> }).prototype.scrollIntoView = function (this: Element) {
    if (scroller.contains(this)) scroller.scrollTop = height();
  };
  return {
    distance: () => height() - Math.min(top, max()) - VIEWPORT,
    max,
    /** A scroll event, delivered when a browser would deliver it. */
    scrollEvent: () => scroller.dispatchEvent(new (g.Event as typeof Event)("scroll")),
  };
}

function mount(lines: TranscriptLineDTO[]) {
  const view = render(<TranscriptFeed lines={lines} scrollable />);
  const scroller = view.container.firstElementChild as HTMLElement;
  const layout = fakeLayout(scroller);
  // The layout above did not exist for the first commit; re-render once with it.
  view.rerender(<TranscriptFeed lines={[...lines]} scrollable />);
  return { ...view, scroller, layout };
}

describe("the scrollable transcript feed keeps following the newest line", () => {
  test("a scroll event delivered after a later commit, mid-burst, does not stop it following", async () => {
    // Its own root rather than render(): the race needs a commit made OUTSIDE
    // act, so React schedules the commit's passive effects as a later task the
    // way it does in a browser, instead of flushing them before act returns.
    const doc = g.document as Document;
    const host = doc.createElement("div");
    doc.body.append(host);
    const root = createRoot(host);
    act(() => root.render(<TranscriptFeed lines={windowEndingAt(99)} scrollable />));
    const scroller = host.firstElementChild as HTMLElement;
    const layout = fakeLayout(scroller);
    act(() => root.render(<TranscriptFeed lines={windowEndingAt(99)} scrollable />));
    assert.equal(layout.distance(), 0, "the feed opens at its newest line");

    // A five-line burst from a full buffer, so each new line also evicts one at
    // the top. In a browser a scroll event can land between a commit and
    // anything that runs after paint: the event from the previous follow, or,
    // as measured in WebKit, the one from scroll anchoring moving scrollTop up
    // for the evicted line. Either sees the new, taller content before it has
    // been followed. A MutationObserver fires in exactly that window: after the
    // commit, before React's passive effects.
    const prevAct = g.IS_REACT_ACT_ENVIRONMENT;
    g.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      for (let last = 100; last <= 104; last++) {
        await new Promise<void>((resolve) => {
          const mo = new (g.MutationObserver as typeof MutationObserver)(() => {
            mo.disconnect();
            layout.scrollEvent();
            resolve();
          });
          mo.observe(scroller, { childList: true, subtree: true });
          root.render(<TranscriptFeed lines={windowEndingAt(last)} scrollable />);
        });
        // Let the commit's passive effects run, as the frame would.
        await new Promise((r) => setTimeout(r, 20));
      }
    } finally {
      g.IS_REACT_ACT_ENVIRONMENT = prevAct;
    }
    // One more ordinary line after the burst.
    act(() => root.render(<TranscriptFeed lines={windowEndingAt(105)} scrollable />));
    const distance = layout.distance();
    act(() => root.unmount());
    host.remove();

    assert.equal(distance, 0, "after a burst the feed must still be on its newest line");
  });

  test("a line wrapping taller, with no new line, keeps the feed on its newest line", () => {
    const { rerender, layout } = mount(windowEndingAt(99));
    assert.equal(layout.distance(), 0);

    // Every row rewraps taller (a font arriving, a narrower box). The browser
    // delivers a scroll event while the content is taller than when it was
    // last pinned; nobody scrolled.
    rowHeight = 60;
    act(() => {
      for (const cb of roCallbacks) cb();
    });
    layout.scrollEvent();
    assert.equal(layout.distance(), 0, "a rewrap must not leave the newest line out of sight");

    rerender(<TranscriptFeed lines={windowEndingAt(100)} scrollable />);
    assert.equal(layout.distance(), 0, "and the next line is still followed");
  });

  test("an operator who scrolls up is left there, and scrolling back to the bottom follows again", () => {
    const { rerender, scroller, layout } = mount(windowEndingAt(99));
    assert.equal(layout.distance(), 0);

    // Scroll anchoring stays out of the way while following: its adjustment for
    // a line evicted at the top is a scroll nobody asked for.
    assert.equal(scroller.style.overflowAnchor, "none", "anchoring is off while following");

    // The operator scrolls up 600px to read back.
    scroller.scrollTop = layout.max() - 600;
    layout.scrollEvent();
    const held = scroller.scrollTop;
    assert.equal(scroller.style.overflowAnchor, "", "anchoring holds a reader's line still, so it is back on");

    for (let last = 100; last <= 104; last++) {
      rerender(<TranscriptFeed lines={windowEndingAt(last)} scrollable />);
      layout.scrollEvent();
    }
    assert.equal(scroller.scrollTop, held, "new lines must not yank an operator who scrolled up");
    assert.ok(layout.distance() >= 600, "the operator is still reading back");

    // Back to the bottom: following resumes.
    scroller.scrollTop = layout.max();
    layout.scrollEvent();
    rerender(<TranscriptFeed lines={windowEndingAt(105)} scrollable />);
    assert.equal(layout.distance(), 0, "back at the bottom, the next line is followed");
    assert.equal(scroller.style.overflowAnchor, "none");
  });

  test("a wheel up stops following before its scroll event arrives", () => {
    const { rerender, scroller, layout } = mount(windowEndingAt(99));
    assert.equal(layout.distance(), 0);

    // The wheel event comes first; the browser scrolls; and a push is committed
    // before the scroll event from that scroll is delivered.
    scroller.dispatchEvent(new ((g.window as { WheelEvent: typeof WheelEvent }).WheelEvent)("wheel", { deltaY: -100 }));
    scroller.scrollTop = layout.max() - 100;
    const held = scroller.scrollTop;
    rerender(<TranscriptFeed lines={windowEndingAt(100)} scrollable />);

    assert.equal(scroller.scrollTop, held, "the push must not pull the operator back down mid-scroll");
  });

  test("input that scrolls nothing (a pinch, a tap, a key something else took) leaves it following", () => {
    const { rerender, scroller, layout } = mount(windowEndingAt(99));
    const W = g.window as { WheelEvent: typeof WheelEvent; Event: typeof Event; KeyboardEvent: typeof KeyboardEvent };

    // A pinch-zoom is a wheel event with ctrlKey and a negative deltaY.
    scroller.dispatchEvent(new W.WheelEvent("wheel", { deltaY: -100, ctrlKey: true }));
    rerender(<TranscriptFeed lines={windowEndingAt(100)} scrollable />);
    assert.equal(layout.distance(), 0, "a wheel that moved nothing must not leave the feed behind");

    scroller.dispatchEvent(new W.Event("touchmove"));
    rerender(<TranscriptFeed lines={windowEndingAt(101)} scrollable />);
    assert.equal(layout.distance(), 0, "a touch that moved nothing must not leave the feed behind");

    (g.document as Document).body.dispatchEvent(new W.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    rerender(<TranscriptFeed lines={windowEndingAt(102)} scrollable />);
    assert.equal(layout.distance(), 0, "a key that moved nothing must not leave the feed behind");
  });

  test("a scrollbar drag up, which sends no wheel, touch or key event, is not undone by the next push", () => {
    const { rerender, scroller, layout } = mount(windowEndingAt(99));
    assert.equal(layout.distance(), 0);

    // The thumb is dragged (or touch momentum carries on after the finger lifts):
    // the browser scrolls with no input event on the feed, and a push is committed
    // before the scroll event from that scroll is delivered.
    scroller.scrollTop = layout.max() - 300;
    const held = scroller.scrollTop;
    rerender(<TranscriptFeed lines={windowEndingAt(100)} scrollable />);
    assert.equal(scroller.scrollTop, held, "the push pulled the operator back down mid-drag");
    layout.scrollEvent();
    rerender(<TranscriptFeed lines={windowEndingAt(101)} scrollable />);
    assert.equal(scroller.scrollTop, held, "a second push pulled the operator back down");
  });

  test("a push that shrinks the content while following, which the browser clamps, keeps following", () => {
    // Every line long, then the oldest long line evicted for a short one: the
    // content shrinks by two rows and the browser clamps scrollTop to the new
    // bottom, which is above where the last pin left it. Nobody scrolled.
    const long = (i: number) => makeLine(100 + i);
    const short = (i: number): TranscriptLineDTO => ({ ...makeLine(i), id: `S${i}`, text: `short ${i}` });
    const first = Array.from({ length: 100 }, (_, k) => long(k));
    const { rerender, layout } = mount(first);
    assert.equal(layout.distance(), 0);

    const shrunk = [...first.slice(1), short(1)];
    rerender(<TranscriptFeed lines={shrunk} scrollable />);
    assert.equal(layout.distance(), 0, "the clamp left the feed off its newest line");

    // The next line lands before the clamp's scroll event is delivered, so
    // nothing but the pin's own decision says whether it is followed.
    rerender(<TranscriptFeed lines={[...shrunk, long(200)]} scrollable />);
    assert.equal(layout.distance(), 0, "the clamp turned following off, so the next line was not followed");
    layout.scrollEvent();
    assert.equal(layout.distance(), 0);
  });

  test("an up key, with focus anywhere on the page, is not undone by the next push", () => {
    const { rerender, scroller, layout } = mount(windowEndingAt(99));
    const W = g.window as { KeyboardEvent: typeof KeyboardEvent };

    // The feed takes no focus, so the key goes to the body; the browser still
    // scrolls the feed, and a push lands before the scroll event.
    (g.document as Document).body.dispatchEvent(new W.KeyboardEvent("keydown", { key: "PageUp", bubbles: true }));
    scroller.scrollTop = layout.max() - 900;
    const held = scroller.scrollTop;
    rerender(<TranscriptFeed lines={windowEndingAt(100)} scrollable />);

    assert.equal(scroller.scrollTop, held, "the push must not pull the operator back down");
  });
});
