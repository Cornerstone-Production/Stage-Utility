// The clipped transcript feed (the Transcription layout object in Rolling mode)
// is not a scroll container.
//
// The bug: the feed clipped its overflow with `overflow: hidden`, which still
// makes a box a scroll container. In Safari, WebKit makes the overflow above a
// justify-end box reachable (scrollTop goes negative), and on a console its
// scroll anchoring held the lines on screen still while new ones were appended
// below them. Over a service the feed froze on old lines, cut off at the
// bottom, with the newest ones out of sight until a reload. `overflow: clip`
// leaves the box no scroll offset for anything to move.
//
// WHAT THIS CHECKS, AND WHY NOT MORE. jsdom does no layout, loads no stylesheet,
// has no scroll anchoring and reports every scrollTop as 0, so the drift itself
// cannot happen here. What it can see is the invariant that prevents it: the
// clipped feed's own style says `clip`. The drift, and its absence with this
// style, was measured in Playwright WebKit on a console page: scrollTop fell to
// -8148 with the newest line 8148px below the feed before the fix, and stayed 0
// with the newest line at the bottom edge after it. See the commit.
//
// Proven red: with the inline `overflow: "clip"` removed from
// transcript-feed.tsx, the first and third cases fail; with it applied to the
// scrollable feed as well, the second does.

import assert from "node:assert/strict";
import { after, afterEach, describe, test } from "node:test";

import { installRenderDom, unmountAndTeardown } from "../test-dom.js";

const teardown = installRenderDom();
const { render, cleanup } = await import("@testing-library/react");
const React = await import("react");
const { TranscriptFeed } = await import("./transcript-feed.js");
const { ObjectContent } = await import("./layout-renderer.js");
const { makeRenderCtx } = await import("./test-render-ctx.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

function buildBuffer(n: number): TranscriptLineDTO[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `L${i}`,
    channel: "1",
    channelName: "Pastor",
    color: null,
    text: `line number ${i}`,
    isFinal: true,
    at: "2026-01-01T00:00:00.000Z",
  }));
}

/** The feed's root: the element the lines' list sits in. */
function feedOf(container: HTMLElement): HTMLElement {
  const line = [...container.querySelectorAll("p")].find((p) => p.textContent?.includes("line number"));
  assert.ok(line, "no transcript line rendered");
  const feed = line.parentElement?.parentElement;
  assert.ok(feed, "the line has no feed around it");
  return feed;
}

describe("the clipped transcript feed is not a scroll container", () => {
  test("TranscriptFeed without `scrollable` clips with overflow: clip", () => {
    const { container } = render(<TranscriptFeed lines={buildBuffer(30)} />);
    assert.equal(
      getComputedStyle(feedOf(container)).overflow,
      "clip",
      "the clipped feed must not be a scroll container: Safari scrolls an overflow:hidden one",
    );
  });

  test("the scrollable feed (the Captions display) still scrolls", () => {
    const { container } = render(<TranscriptFeed lines={buildBuffer(30)} scrollable />);
    const feed = feedOf(container);
    assert.notEqual(getComputedStyle(feed).overflow, "clip");
    assert.ok(feed.classList.contains("overflow-y-auto"), "the Captions display lost its scrollbar");
  });

  test("the Transcription layout object in Rolling mode clips with overflow: clip", () => {
    const ctx = makeRenderCtx({ transcript: buildBuffer(30) });
    const obj = {
      id: "o1",
      x: 0, y: 0, w: 1, h: 0.8, z: 1,
      config: { type: "transcript-strip", mode: "rolling" },
      style: {},
    } as never;
    const { container } = render(React.createElement(ObjectContent as never, { o: obj, ctx }));
    assert.equal(getComputedStyle(feedOf(container)).overflow, "clip");
  });
});
