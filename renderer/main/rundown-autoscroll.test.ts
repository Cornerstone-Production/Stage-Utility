// Keeping the live item on screen, without dragging the rest of the layout.
//
// Two defects sit behind this file.
//
// The first: the effect used to depend on `currentItemId` alone. The rundown
// arrives from the server after mount, so a display opened DURING a service had
// the live id already set and unchanged by the time any rows existed. The effect
// had run once against an empty table, found no row, and never fired again — the
// screen sat on the top of the plan for the whole service, which is the one case
// auto-scroll exists for. Fixed by keying on the rows as well; the arithmetic
// below is what runs once a row is actually there.
//
// The second: `scrollIntoView` adjusts EVERY scrollable ancestor. On the
// standalone page nothing above the rundown scrolls, so it never showed. Inside
// a layout object it can drag the whole page — moving objects that have nothing
// to do with the rundown. Hence a computed offset against ONE container.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { rowScrollTop } from "./rundown-table";

// Geometry as the DOM reports it: viewport-relative rects, plus the scroller's
// current scrollTop. `rowTop - scrollerTop` is the row's offset from the top of
// the visible area, so adding scrollTop recovers its offset within the content.
describe("rowScrollTop", () => {
  it("centres a row that is below the fold", () => {
    // Scroller 500 tall at viewport y=100, already scrolled 0. Row is 100 tall,
    // sitting at y=700 — i.e. 600 into the content, well past the bottom.
    const top = rowScrollTop(700, 100, 100, 0, 500);
    // Centred means the row's middle lands at the scroller's middle:
    // offset 600, minus (500 - 100)/2 = 200  ->  400.
    assert.equal(top, 400);
  });

  it("accounts for how far the scroller is already scrolled", () => {
    // Same row, but the scroller has already moved 250px. The row now appears
    // 250px higher on screen, so its offset within the content is unchanged.
    const a = rowScrollTop(700, 100, 100, 0, 500);
    const b = rowScrollTop(450, 100, 100, 250, 500);
    assert.equal(a, b, "the same row must resolve to the same scrollTop");
  });

  it("never asks for a negative scroll", () => {
    // A row near the very top cannot be centred — there is nothing above it to
    // scroll away. Asking for a negative scrollTop would be clamped by the
    // browser, but returning one is a bug waiting to be surfaced elsewhere.
    assert.equal(rowScrollTop(110, 40, 100, 0, 500), 0);
    assert.equal(rowScrollTop(100, 100, 100, 0, 900), 0);
  });

  it("handles a row taller than the visible area", () => {
    // A song with long notes can be taller than a short embed box. Centring then
    // means showing its middle, which puts its top ABOVE the fold — correct, and
    // the max(0, …) must not fight it.
    const top = rowScrollTop(300, 800, 100, 0, 400);
    // offset 200, minus (400 - 800)/2 = -200  ->  200 + 200 = 400.
    assert.equal(top, 400);
  });

  it("is stable once the row is already centred", () => {
    // The effect re-runs on every rundown refresh (60s). If the arithmetic did
    // not land on a fixed point, a display would twitch once a minute for ever.
    const scrollerTop = 100, scrollerH = 500, rowH = 100;
    let scrollTop = rowScrollTop(700, rowH, scrollerTop, 0, scrollerH);
    // After scrolling, the row has moved up by exactly `scrollTop`.
    const rowTopNow = 700 - scrollTop;
    const again = rowScrollTop(rowTopNow, rowH, scrollerTop, scrollTop, scrollerH);
    assert.equal(again, scrollTop, "re-running on a centred row must not move it");
  });
});
