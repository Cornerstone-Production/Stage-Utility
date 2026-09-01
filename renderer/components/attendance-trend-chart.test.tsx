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

after(() => {
  globalThis.ResizeObserver = RealRO;
  cleanup();
  teardown();
});

const point = (day: string, value: number) => ({ day, value, live: false });

describe("measuring itself", () => {
  test("attaches the observer when the data arrives AFTER the first render", () => {
    globalThis.ResizeObserver = SpyResizeObserver as unknown as typeof ResizeObserver;
    observed.length = 0;

    // First paint with nothing to plot — the note, which has no ref.
    const view = render(<AttendanceTrendChart points={[]} />);
    assert.equal(observed.length, 0, "nothing to observe yet, correctly");

    // History lands.
    act(() => {
      view.rerender(<AttendanceTrendChart points={[point("2026-07-05", 1810), point("2026-08-16", 2632)]} />);
    });

    assert.equal(observed.length, 1, "the chart never measured itself, so it draws at its fallback width");
    cleanup();
  });

  test("the line reaches the width it was told about", () => {
    globalThis.ResizeObserver = SpyResizeObserver as unknown as typeof ResizeObserver;
    observed.length = 0;

    const view = render(<AttendanceTrendChart points={[]} />);
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
    cleanup();
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
// What is NOT asserted here, because jsdom cannot see it: that the tooltip is
// invisible for the one frame before it has been measured. `act()` flushes the
// measuring effect inside the same call that mounts it, so the intermediate
// state never exists to be observed.
//
// Nor is the real thing this fixes — a tooltip the BROWSER clips, which needs a
// stylesheet, a font and a window. Driven in headless Chrome at 1000px instead:
// hovering the last point put the tooltip at 884.6 → 1013.4 before the clamp,
// i.e. 13px past the right edge of the window and 54px past the chart's own, and
// at 825.9 → 954.6 after it, against a chart ending at 959.
const TIP_W = 260;

function stubLayout(chart: number): () => void {
  const real = Object.getOwnPropertyDescriptor(Element.prototype, "getBoundingClientRect")!;
  boxSize = { width: chart, height: 200 };
  Object.defineProperty(Element.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: Element) {
      // The tooltip is the chart's only z-10 overlay; everything else answers as
      // the chart's own box, which is what the pointer maths reads.
      const w = this instanceof HTMLElement && this.className.includes("z-10") ? TIP_W : chart;
      return { x: 0, y: 0, left: 0, top: 0, right: w, bottom: 200, width: w, height: 200, toJSON: () => ({}) } as DOMRect;
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
  test("is held inside a chart too narrow to centre it on the last point", () => {
    // 300px of chart and a 260px tooltip. Centred on the last point — which sits
    // at the right edge, because that is where the last point goes — half of it
    // hangs off the card, and a card near the edge of the window had it clipped
    // by the browser.
    globalThis.ResizeObserver = SpyResizeObserver as unknown as typeof ResizeObserver;
    const restore = stubLayout(300);
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
    restore();
  });

  test("is left where the point is when there is room for it", () => {
    // The clamp must not become a nudge. On a wide chart the tooltip belongs
    // centred on the point it describes, exactly.
    globalThis.ResizeObserver = SpyResizeObserver as unknown as typeof ResizeObserver;
    const restore = stubLayout(1500);
    const view = render(<AttendanceTrendChart points={week} />);
    fireEvent.pointerMove(view.container.querySelector("svg")!, { clientX: 750, clientY: 50 });

    const tip = tooltip(view.container)!;
    assert.ok(tip, "no tooltip: the pointer never registered, so this asserts nothing");
    // 1500 wide, 10px of padding a side, 5 points: the middle one is at 750.
    assert.equal(leftPx(tip, 1500), 750, "the tooltip was shifted off its own point on a chart with room to spare");
    restore();
  });
});

describe("hoverSuppressed", () => {
  test("clears a hover it already had, and does not put it back when released", () => {
    globalThis.ResizeObserver = SpyResizeObserver as unknown as typeof ResizeObserver;
    const restore = stubLayout(1500);
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
    restore();
  });

  test("ignores pointer moves while it is held, and hovers again once it is not", () => {
    globalThis.ResizeObserver = SpyResizeObserver as unknown as typeof ResizeObserver;
    const restore = stubLayout(1500);
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
    restore();
  });
});
