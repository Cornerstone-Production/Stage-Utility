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

const { render, cleanup, act } = await import("@testing-library/react");
const { AttendanceTrendChart } = await import("./attendance-trend-chart.js");

/** Records what the component asks to observe. */
const observed: Element[] = [];
const RealRO = globalThis.ResizeObserver;
class SpyResizeObserver {
  constructor(private cb: ResizeObserverCallback) {}
  observe(el: Element) {
    observed.push(el);
    // Answer once with a real width, the way a browser does on observe.
    this.cb(
      [{ contentRect: { width: 1500, height: 200 } } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
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
