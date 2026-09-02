// The chart has to measure itself even when it did not start as a chart.
//
// Every complaint about this thing — labels two and a half times too wide, an
// endpoint dot drawn as an oval, and later a line stopping at a third of its
// card — was one bug: with fewer than two services to plot it renders a "not
// enough yet" note instead, and that note carries no ref. A mount-effect that
// read the ref once therefore found nothing, returned, and never ran again, so
// no ResizeObserver was ever attached and the width stayed at its initial 640.
//
// It never reproduced anywhere the history was already cached at first paint,
// which is why it took three attempts to find. This is that exact sequence.
//
// Cleanup lives in `t.after()`, never a trailing statement: a `restore()` or
// `cleanup()` written as the LAST line of a test is skipped the moment an
// earlier assertion throws, which leaves `getBoundingClientRect` stubbed (or
// `ResizeObserver` swapped) for whatever test runs next.

import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

const { render, cleanup, act, fireEvent } = await import("@testing-library/react");
const { AttendanceTrendChart } = await import("./attendance-trend-chart.js");

/** Records what the component asks to observe. */
const observed: Element[] = [];
/** What the spy answers for any box it is asked to observe. */
let boxSize = { width: 1500, height: 200 };
/** installDom's own no-op stub (see test-dom.ts) — captured before any test
 *  swaps in the spy below, so "stays invisible when the tooltip is never
 *  measured at all" can put the GENUINE default back rather than a second
 *  hand-rolled no-op that could quietly drift from it. */
const RealRO = globalThis.ResizeObserver;
class SpyResizeObserver {
  constructor(private cb: ResizeObserverCallback) {}
  observe(el: Element) {
    observed.push(el);
    // Answer once with a real width, the way a browser does on observe.
    this.cb([{ contentRect: boxSize } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve() {}
  disconnect() {}
}

/** Whether an observed element is the tooltip rather than the chart's own
 *  box. The tooltip has its own ResizeObserver (see `stubLayout` below), so a
 *  bare `observed.length` is fragile the moment a test in this file starts
 *  hovering as well as measuring. */
const isTipEl = (el: Element) => el instanceof HTMLElement && el.className.includes("z-10");

after(() => {
  globalThis.ResizeObserver = RealRO;
  cleanup();
  teardown();
});

const point = (day: string, value: number) => ({ day, value, live: false });

describe("measuring itself", () => {
  test("attaches the observer when the data arrives AFTER the first render", (t) => {
    globalThis.ResizeObserver = SpyResizeObserver as unknown as typeof ResizeObserver;
    observed.length = 0;

    // First paint with nothing to plot — the note, which has no ref.
    const view = render(<AttendanceTrendChart points={[]} />);
    t.after(() => cleanup());
    assert.equal(observed.length, 0, "nothing to observe yet, correctly");

    // History lands.
    act(() => {
      view.rerender(<AttendanceTrendChart points={[point("2026-07-05", 1810), point("2026-08-16", 2632)]} />);
    });

    assert.equal(
      observed.filter((el) => !isTipEl(el)).length,
      1,
      "the chart never measured itself, so it draws at its fallback width",
    );
  });

  test("the line reaches the width it was told about", (t) => {
    globalThis.ResizeObserver = SpyResizeObserver as unknown as typeof ResizeObserver;
    observed.length = 0;

    const view = render(<AttendanceTrendChart points={[]} />);
    t.after(() => cleanup());
    act(() => {
      view.rerender(<AttendanceTrendChart points={[point("2026-07-05", 1810), point("2026-08-16", 2632)]} />);
    });

    const poly = view.container.querySelector("polyline")!;
    const xs = (poly.getAttribute("points") ?? "")
      .split(" ")
      .map((p) => Number(p.split(",")[0]))
      .filter(Number.isFinite);
    // 1500 wide, 10px of padding a side: the last point sits at 1490, not at
    // 630, which is where the un-measured fallback would put it.
    assert.ok(
      Math.max(...xs) > 1400,
      `the line stops at ${Math.max(...xs)}px of a 1500px box — it is drawing at its fallback width`,
    );
  });
});

// ── The hover ────────────────────────────────────────────────────────────────
//
// jsdom lays nothing out: every box is 0x0 and no stylesheet is loaded. A chart
// that positions its tooltip by MEASURING it therefore cannot be tested at all
// without answering for the two boxes the maths is made of — the chart's own
// width, and the tooltip's. That is what stubLayout does, and it is the only
// thing stubbed: the clamp itself is the component's.
//
// The pre-measurement `opacity: 0` state IS observable here, and is tested
// below ("stays invisible when the tooltip is never measured at all"): with
// the DEFAULT no-op ResizeObserver installDom gives every test, it never
// calls back at all, so `tipW` never leaves 0 and the opacity stays "0"
// permanently rather than for one frame. What jsdom genuinely cannot show is
// the ORDINARY case, where a real ResizeObserver answers a frame later than
// this file's synchronous test double does — `act()` flushes that
// intermediate state through in the same call that mounts it.
//
// Nor is the real thing this fixes — a tooltip the BROWSER clips, which needs a
// stylesheet, a font and a window. Driven in headless Chrome at 1000px instead:
// hovering the last point put the tooltip at 884.6 → 1013.4 before the clamp,
// i.e. 13px past the right edge of the window and 54px past the chart's own, and
// at 825.9 → 954.6 after it, against a chart ending at 959.
const TIP_W = 260;

/**
 * Stub `getBoundingClientRect` for a chart `chart`px wide and a tooltip
 * `tipHeight`px tall (everything else answers 200 tall, chart included —
 * nothing here reads the chart's own stubbed height).
 *
 * `tipHeight` defaults small and realistic (a one-or-two-line tooltip), not to
 * the chart's own 200: the vertical clamp below reads the tooltip's measured
 * height, and a stub answering 200 for it regardless of `chart` would make
 * every point in a 200-tall chart read as "no room", which is not what a real
 * tooltip does.
 */
function stubLayout(chart: number, tipHeight = 20): () => void {
  const real = Object.getOwnPropertyDescriptor(Element.prototype, "getBoundingClientRect")!;
  boxSize = { width: chart, height: 200 };
  Object.defineProperty(Element.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: Element) {
      // The tooltip is the chart's only z-10 overlay; everything else answers as
      // the chart's own box, which is what the pointer maths reads.
      const isTip = this instanceof HTMLElement && this.className.includes("z-10");
      const w = isTip ? TIP_W : chart;
      const h = isTip ? tipHeight : 200;
      return { x: 0, y: 0, left: 0, top: 0, right: w, bottom: h, width: w, height: h, toJSON: () => ({}) } as DOMRect;
    },
  });
  return () => {
    Object.defineProperty(Element.prototype, "getBoundingClientRect", real);
    boxSize = { width: 1500, height: 200 };
    cleanup();
  };
}

/** The hover tooltip — the chart's only z-10 overlay. */
const tooltip = (c: HTMLElement) => c.querySelector<HTMLElement>("div.z-10");

/** Its left offset in PIXELS, whatever unit it was written in. A percentage of
 *  the plot is a position too, and what is being asserted is where the tooltip
 *  sits, not how it was spelled. */
function leftPx(el: HTMLElement, plotW: number): number {
  const raw = el.style.left;
  return raw.endsWith("%") ? (parseFloat(raw) / 100) * plotW : parseFloat(raw);
}

const week = [
  point("2026-07-05", 100),
  point("2026-07-12", 200),
  point("2026-07-19", 150),
  point("2026-07-26", 300),
  point("2026-08-02", 250),
];

describe("the hover tooltip", () => {
  test("is held inside a chart too narrow to centre it on the last point", (t) => {
    // 300px of chart and a 260px tooltip. Centred on the last point — which sits
    // at the right edge, because that is where the last point goes — half of it
    // hangs off the card, and a card near the edge of the window had it clipped
    // by the browser.
    globalThis.ResizeObserver = SpyResizeObserver as unknown as typeof ResizeObserver;
    const restore = stubLayout(300);
    t.after(() => restore());
    const view = render(<AttendanceTrendChart points={week} />);
    fireEvent.pointerMove(view.container.querySelector("svg")!, { clientX: 300, clientY: 50 });

    const tip = tooltip(view.container)!;
    assert.ok(tip, "no tooltip: the pointer never registered, so this asserts nothing");
    assert.match(tip.textContent ?? "", /Aug 2/, "the pointer did not land on the LAST point");
    const left = leftPx(tip, 300);
    assert.ok(
      left + TIP_W / 2 <= 296.01,
      `the tooltip's right edge is at ${left + TIP_W / 2}px of a 300px chart — it hangs off the side`,
    );
    assert.ok(
      left - TIP_W / 2 >= 3.99,
      `the tooltip's left edge is at ${left - TIP_W / 2}px — off the left of the chart`,
    );
    assert.notEqual(tip.style.opacity, "0", "the tooltip was never measured, so it stays invisible");
  });

  test("is left where the point is when there is room for it", (t) => {
    // The clamp must not become a nudge. On a wide chart the tooltip belongs
    // centred on the point it describes, exactly.
    globalThis.ResizeObserver = SpyResizeObserver as unknown as typeof ResizeObserver;
    const restore = stubLayout(1500);
    t.after(() => restore());
    const view = render(<AttendanceTrendChart points={week} />);
    fireEvent.pointerMove(view.container.querySelector("svg")!, { clientX: 750, clientY: 50 });

    const tip = tooltip(view.container)!;
    assert.ok(tip, "no tooltip: the pointer never registered, so this asserts nothing");
    // 1500 wide, 10px of padding a side, 5 points: the middle one is at 750.
    assert.equal(leftPx(tip, 1500), 750, "the tooltip was shifted off its own point on a chart with room to spare");
  });

  test("centres the tooltip when the chart itself is narrower than the tooltip", (t) => {
    // 200px is a realistic phone-width History column — the review's own
    // repro. No position holds a 260px tooltip fully inside a 200px box, so
    // it should overhang evenly (the `tipLo > tipHi` fallback a few lines
    // into the component) rather than sit off toward one edge because the
    // drawing math used a WIDER width than the real box.
    //
    // That mismatch was the bug: the chart's width used to be floored to 240
    // before any measurement was used, so a 200px real container got its
    // tooltip centred as if the box were 240px wide, landing 50px past the
    // REAL right edge instead of overhanging evenly on both sides.
    globalThis.ResizeObserver = SpyResizeObserver as unknown as typeof ResizeObserver;
    const restore = stubLayout(200);
    t.after(() => restore());
    const view = render(<AttendanceTrendChart points={week} />);
    fireEvent.pointerMove(view.container.querySelector("svg")!, { clientX: 200, clientY: 50 });

    const tip = tooltip(view.container)!;
    assert.ok(tip, "no tooltip: the pointer never registered, so this asserts nothing");
    const left = leftPx(tip, 200);
    assert.equal(
      left,
      100,
      `the tooltip centred at ${left}px of a 200px box, not 100 — the drawing math disagreed with the real width`,
    );
  });

  test("stays invisible when the tooltip is never measured at all", (t) => {
    // The DEFAULT no-op ResizeObserver installDom gives every test (see
    // test-dom.ts): it never calls back, so `tipW` never leaves 0 and
    // `opacity: 0` is not a one-frame flicker here — it is permanent. This is
    // the worse of the two failure modes a broken measurement path can have:
    // the tooltip never appears at all, rather than merely sitting wrong.
    globalThis.ResizeObserver = RealRO as unknown as typeof ResizeObserver;
    t.after(() => {
      globalThis.ResizeObserver = SpyResizeObserver as unknown as typeof ResizeObserver;
      cleanup();
    });
    const view = render(<AttendanceTrendChart points={week} />);
    // jsdom's real (unstubbed) getBoundingClientRect answers every box 0x0,
    // so `frac = (clientX - 0) / 0` is +Infinity for any positive clientX,
    // and the hover clamps to the LAST point — the same mechanism
    // overview-blend.test.tsx's right-click test relies on.
    fireEvent.pointerMove(view.container.querySelector("svg")!, { clientX: 400, clientY: 40 });

    const tip = tooltip(view.container);
    assert.ok(tip, "no tooltip at all: the pointer move did not register a hover");
    assert.equal(
      tip!.style.opacity,
      "0",
      "an unmeasured tooltip must stay invisible rather than appear in the wrong place",
    );
  });
});

describe("the tooltip's vertical placement", () => {
  test("flips below the point when there is no room above it", (t) => {
    // Same class of bug as the horizontal one above, on the other axis: `hy`
    // is smallest at the HIGHEST-attendance point, so the point an operator
    // is most likely to hover is exactly the one closest to the chart's own
    // top edge. On History that only drew the tooltip over the card above
    // it. On Home the chart sits inside two `overflow-hidden` ancestors
    // (cards.tsx), so the same negative CSS top does not overhang there —
    // it is cut off outright.
    globalThis.ResizeObserver = SpyResizeObserver as unknown as typeof ResizeObserver;
    const restore = stubLayout(1500);
    t.after(() => restore());
    const view = render(<AttendanceTrendChart points={week} />);
    const svg = view.container.querySelector("svg")!;
    // index 3 -> value 300, the series maximum: y = padTop = 10, closer to
    // the chart's top edge than any other point in `week`.
    fireEvent.pointerMove(svg, { clientX: 1120, clientY: 10 });

    const tip = tooltip(view.container)!;
    assert.ok(tip, "no tooltip: the pointer did not land on the point being tested");
    assert.match(tip.textContent ?? "", /300/, "the pointer did not land on the highest point");
    assert.ok(
      !tip.className.includes("-translate-y-full"),
      "the tooltip still tries to sit above the point with no room for it",
    );
    assert.ok(
      parseFloat(tip.style.top) >= 4,
      `the tooltip's top is ${tip.style.top} — negative, so an overflow-hidden ancestor would clip it`,
    );
  });

  test("still sits above the point, as before, when there is room", (t) => {
    globalThis.ResizeObserver = SpyResizeObserver as unknown as typeof ResizeObserver;
    const restore = stubLayout(1500);
    t.after(() => restore());
    const view = render(<AttendanceTrendChart points={week} />);
    const svg = view.container.querySelector("svg")!;
    // index 4 -> value 250: well clear of the top edge, unlike the max above.
    fireEvent.pointerMove(svg, { clientX: 1490, clientY: 50 });

    const tip = tooltip(view.container)!;
    assert.ok(tip, "no tooltip: the pointer did not land on the point being tested");
    assert.match(tip.textContent ?? "", /250/, "the pointer did not land on the point being tested");
    assert.ok(
      tip.className.includes("-translate-y-full"),
      "a point with room above it flipped to sit below for no reason",
    );
  });

  test("overhangs the SHORTER side when a tall tooltip fits on neither", (t) => {
    // Checking only "is there room above?" flips down the moment the top does
    // not fit — including for a LOW point, where below is the tighter side. That
    // traded a small overflow for a large one, and on Home a small clip for a
    // large one, in a fix whose whole purpose was to stop the tooltip being cut
    // off. Here the point sits near the floor and the tooltip is taller than
    // either gap: above overhangs by 7px, below would overhang by 163.
    globalThis.ResizeObserver = SpyResizeObserver as unknown as typeof ResizeObserver;
    const restore = stubLayout(1500, 175);
    t.after(() => restore());
    const view = render(<AttendanceTrendChart points={week} />);
    const svg = view.container.querySelector("svg")!;
    // index 0 -> value 100, the series minimum: y = 180 of a 200px band, so
    // there are 168px above it and 8px below.
    fireEvent.pointerMove(svg, { clientX: 10, clientY: 180 });

    const tip = tooltip(view.container)!;
    assert.ok(tip, "no tooltip: the pointer did not land on the point being tested");
    assert.match(tip.textContent ?? "", /100/, "the pointer did not land on the lowest point");
    assert.ok(
      tip.className.includes("-translate-y-full"),
      "the tooltip flipped below a point that had far less room below than above, overflowing further than it would have above",
    );
  });
});

describe("hoverSuppressed", () => {
  test("clears a hover it already had, and does not put it back when released", (t) => {
    globalThis.ResizeObserver = SpyResizeObserver as unknown as typeof ResizeObserver;
    const restore = stubLayout(1500);
    t.after(() => restore());
    const view = render(<AttendanceTrendChart points={week} />);
    const svg = view.container.querySelector("svg")!;
    fireEvent.pointerMove(svg, { clientX: 750, clientY: 50 });
    assert.ok(tooltip(view.container), "nothing to suppress: the hover never took");

    act(() => {
      view.rerender(<AttendanceTrendChart points={week} hoverSuppressed />);
    });
    assert.ok(!tooltip(view.container), "the tooltip is still drawn over the menu that suppressed it");
    assert.equal(
      view.container.querySelectorAll("svg line").length,
      1,
      "the crosshair is still drawn under the menu (only the baseline should be left)",
    );
    assert.ok(view.queryByText("250"), "the latest-attendance label did not come back, so the chart shows neither");

    // Released with the pointer where it was. The hover was CLEARED, not hidden,
    // so closing the menu must not pop the old tooltip open again.
    act(() => {
      view.rerender(<AttendanceTrendChart points={week} />);
    });
    assert.ok(!tooltip(view.container), "the old tooltip reappeared as the menu closed");
  });

  test("ignores pointer moves while it is held, and hovers again once it is not", (t) => {
    globalThis.ResizeObserver = SpyResizeObserver as unknown as typeof ResizeObserver;
    const restore = stubLayout(1500);
    t.after(() => restore());
    const view = render(<AttendanceTrendChart points={week} hoverSuppressed />);
    const svg = view.container.querySelector("svg")!;
    fireEvent.pointerMove(svg, { clientX: 750, clientY: 50 });
    assert.ok(!tooltip(view.container), "a move under the menu opened a tooltip anyway");

    // Ignored, not merely hidden: a move made behind the menu must not be sitting
    // there waiting to appear the moment the menu closes.
    act(() => {
      view.rerender(<AttendanceTrendChart points={week} />);
    });
    assert.ok(!tooltip(view.container), "a move made under the menu popped a tooltip open as it closed");

    fireEvent.pointerMove(svg, { clientX: 750, clientY: 50 });
    assert.ok(tooltip(view.container), "hovering never worked again after the menu closed");
  });
});

// ── The SPL endpoint dot and label ──────────────────────────────────────────
//
// The attendance series has always ended in a marked dot and a "latest value"
// label; the SPL series drew neither and its line just stopped. These guard
// the equivalent for SPL: the RIGHT point (the last one with a level, not
// necessarily the chart's own last point), the live/settled look, and a label
// placement that cannot land on top of the attendance one even though the two
// series are scaled independently and can converge.
describe("the SPL endpoint dot and label", () => {
  const sp = (day: string, value: number, spl: number | null, live = false) => ({ day, value, spl, live });
  /** The hollow signature is unambiguous — only the endpoint dot ever draws
   *  it, unlike a plain `su-ok-9` fill, which the lone-reading-between-gaps
   *  dot (splRuns above) also uses. */
  const hollowSplDot = (c: HTMLElement) => c.querySelector('circle[fill="var(--su-bg)"][stroke="var(--su-ok-9)"]');
  const splDbLabel = (c: HTMLElement) => [...c.querySelectorAll("span")].find((s) => /dB/.test(s.textContent ?? ""));

  test("marks the last point that actually carries a level, not necessarily the chart's own last point", (t) => {
    globalThis.ResizeObserver = SpyResizeObserver as unknown as typeof ResizeObserver;
    t.after(() => cleanup());
    // The newest weekend has attendance but no Smaart reading (a gap at the
    // very end) — the endpoint must sit on the PRIOR point, not vanish.
    const points = [sp("2026-06-21", 500, 60), sp("2026-06-28", 400, 70), sp("2026-07-05", 300, null)];
    const view = render(<AttendanceTrendChart points={points} splLabel="LAeq" />);

    // 1500 wide, 3 points, 10px padding a side: index 1 (the last WITH a
    // reading) sits at 10 + (1/2)*(1500-20) = 750; index 2 (the gap) at 1490.
    const dots = [...view.container.querySelectorAll('circle[fill="var(--su-ok-9)"]')];
    const dot = dots.find((c) => Math.abs(Number(c.getAttribute("cx")) - 750) < 0.5);
    assert.ok(dot, `no SPL dot at index 1; saw cx values ${dots.map((c) => c.getAttribute("cx"))}`);
    assert.ok(
      !dots.some((c) => Math.abs(Number(c.getAttribute("cx")) - 1490) < 0.5),
      "an SPL dot was drawn on the gap at the chart's own last point",
    );

    const label = splDbLabel(view.container);
    assert.ok(label, "no SPL label at all");
    assert.match(label!.textContent ?? "", /70\.0\s*dB/, "the label shows the last READING, not the chart's last point");
  });

  test("the endpoint dot is hollow only when it is the chart's FINAL point and that point is live", (t) => {
    globalThis.ResizeObserver = SpyResizeObserver as unknown as typeof ResizeObserver;
    t.after(() => cleanup());

    // The endpoint IS the chart's final point, and it's live: still climbing.
    const live = render(
      <AttendanceTrendChart points={[sp("2026-06-21", 500, 60), sp("2026-06-28", 400, 70, true)]} splLabel="LAeq" />,
    );
    assert.ok(hollowSplDot(live.container), "a live final reading did not draw hollow");
    cleanup();

    // The endpoint IS the final point, but settled: solid.
    const settled = render(
      <AttendanceTrendChart points={[sp("2026-06-21", 500, 60), sp("2026-06-28", 400, 70, false)]} splLabel="LAeq" />,
    );
    assert.ok(!hollowSplDot(settled.container), "a settled final reading drew hollow");
    cleanup();

    // The SERVICE is still live, but its Smaart reading is not the chart's
    // final POINT — a later weekend already has attendance with no level yet.
    // The dot marks a SETTLED past reading and must not borrow the live look.
    const laterGap = render(
      <AttendanceTrendChart points={[sp("2026-06-21", 500, 60, true), sp("2026-06-28", 400, null)]} splLabel="LAeq" />,
    );
    assert.ok(
      !hollowSplDot(laterGap.container),
      "an endpoint that isn't the chart's own final point drew hollow anyway",
    );
  });

  test("draws neither the dot nor the label when no SPL metric is chosen", (t) => {
    globalThis.ResizeObserver = SpyResizeObserver as unknown as typeof ResizeObserver;
    t.after(() => cleanup());
    const points = [sp("2026-06-21", 500, 60), sp("2026-06-28", 400, 70)];
    const view = render(<AttendanceTrendChart points={points} splLabel={null} />);
    assert.equal(
      view.container.querySelectorAll('circle[fill="var(--su-ok-9)"]').length,
      0,
      "drew an SPL dot with no metric chosen",
    );
    assert.ok(!splDbLabel(view.container), "drew an SPL label with no metric chosen");
  });

  test("the SPL label cannot land inside the attendance label's own band, even when the two series converge", (t) => {
    globalThis.ResizeObserver = SpyResizeObserver as unknown as typeof ResizeObserver;
    t.after(() => cleanup());
    // Engineered so the two independently-scaled dots land close together on
    // screen: attendance's last point maps to y=70 of the 200-tall box this
    // file's default ResizeObserver reports; SPL's endpoint — at its OWN
    // series maximum, with enough range that the 30% pad doesn't hit its 1.5
    // floor — maps to yβ‰ˆ41.9. "Above its own dot" for one and "below its own
    // dot" for the other overlap by about 16px without the floor this test
    // guards (confirmed by hand before writing this: naturalSplTop=49.875
    // falls inside the attendance label's own 50-66 band).
    const points = [sp("2026-06-21", 0, 60), sp("2026-06-28", 170, 65), sp("2026-07-05", 110, 95)];
    const view = render(<AttendanceTrendChart points={points} splLabel="LAeq" />);

    const spans = [...view.container.querySelectorAll("span")];
    const attLabel = spans.find((s) => (s.textContent ?? "").trim() === "110");
    const splLabel = splDbLabel(view.container);
    assert.ok(attLabel, "no attendance label to compare against");
    assert.ok(splLabel, "no SPL label to compare against");

    const attTop = parseFloat(attLabel!.style.top);
    const splTop = parseFloat(splLabel!.style.top);
    // The attendance label's own height: caption1's line-height (styles.css).
    const ATT_LABEL_H = 16;
    assert.ok(
      splTop >= attTop + ATT_LABEL_H,
      `the SPL label (top ${splTop}) overlaps the attendance label's own band (top ${attTop}, height ${ATT_LABEL_H})`,
    );
  });
});
