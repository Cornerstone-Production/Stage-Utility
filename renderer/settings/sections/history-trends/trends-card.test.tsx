// The Trends card's own behaviour: the sparkline's flat case, the percentage
// spelling, and what it says when the milestone list will not load.
//
// WHAT IS NOT ASSERTED HERE, AND WHY. jsdom lays nothing out and loads no
// stylesheet: the tile grid's wrap, the chart's measured width (every
// offsetWidth is 0, so it draws at its 640px default), and whether a milestone
// label collides with its neighbour are all invisible to it, and were driven in
// Chrome at 1280 and 600 in both themes against a real three-month archive. The
// arithmetic behind the tiles is in trends.test.ts.

import assert from "node:assert/strict";
import { after, afterEach, describe, test } from "node:test";

import { installRenderDom } from "../../../test-dom.js";

const teardown = installRenderDom();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { render, cleanup, act } = await import("@testing-library/react");
const React = (await import("react")).default;
const { Sparkline } = await import("./sparkline.js");
const { TrendsCard, pct } = await import("./trends-card.js");
const { TooltipProvider } = await import("../../../components/ui/index.js");
type TrendRecording = import("./trends.js").TrendRecording;

afterEach(() => {
  cleanup();
  // The series toggle is a localStorage preference; one test's untick would
  // otherwise be the next test's starting state.
  try { localStorage.clear(); } catch { /* jsdom always has one */ }
});
after(() => {
  cleanup();
  teardown();
});

/** The y of each point in a sparkline's `d`, in order. */
function ys(container: HTMLElement): number[] {
  const d = container.querySelector("[data-sparkline]")?.getAttribute("d") ?? "";
  return [...d.matchAll(/[ML][\d.]+,([\d.]+)/g)].map((m) => Number(m[1]));
}

describe("a sparkline that does not move", () => {
  test("one value draws down the middle", () => {
    const r = render(React.createElement(Sparkline, { values: [900], height: 28, label: "one" }));
    assert.deepEqual(ys(r.container), [14, 14], "a single reading is a flat rule at the middle");
    r.unmount();
  });

  test("eight identical values draw down the middle too", () => {
    // `span = hi - lo || 1` put a flat series on the FLOOR of the box, which
    // reads as the worst eight weeks on record rather than as eight weeks that
    // did not move. The comment already promised the middle; only the
    // single-value branch did it.
    const r = render(React.createElement(Sparkline, { values: Array(8).fill(1200), height: 28, label: "flat" }));
    assert.deepEqual(ys(r.container), Array(8).fill(14), "a flat series must not sit on the floor");
    r.unmount();
  });

  test("a series that DOES move still spans the box", () => {
    // The positive half: the fix must not flatten a real series to the middle.
    const r = render(React.createElement(Sparkline, { values: [100, 200, 300], height: 28, label: "rising" }));
    const seen = ys(r.container);
    assert.equal(seen[0], 26, "the lowest reading sits at the bottom, inside the 2px inset");
    assert.equal(seen[2], 2, "the highest sits at the top");
    r.unmount();
  });
});

describe("how a change reads", () => {
  test("a change that rounds to nothing is 0%, with no sign in front of it", () => {
    // A sign in front of zero claims a direction the number denies, and which
    // of "+0%" and "−0%" you got depended on the sign of a difference too small
    // to print. One case per line, so two branches adding different ones merge
    // cleanly.
    assert.deepEqual(
      [0, 0.001, -0.001, 0.004, -0.004, 0.006, -0.006, 0.12, -0.12, 1].map((c) => [c, pct(c)]),
      [
        [0, "0%"],
        [0.001, "0%"],
        [-0.001, "0%"],
        [0.004, "0%"],
        [-0.004, "0%"],
        [0.006, "+1%"],
        [-0.006, "−1%"],
        [0.12, "+12%"],
        [-0.12, "−12%"],
        [1, "+100%"],
      ],
    );
  });

  test("the percentage is the one the tile's own two numbers give", async () => {
    // Derived from the UNROUNDED means it printed "+1%" beside two numbers that
    // were equal on screen. Sixteen Sundays: eight at 1000/1001 alternating,
    // eight at 1000 — both windows round to 1000, so the tile must read 0%.
    const recs = alternating();
    const view = await renderCard(recs);
    const tile = view.container.querySelector("[data-trend-tile]")!;
    const avg = tile.querySelector("[data-trend-average]")!.textContent;
    const change = tile.querySelector("[data-trend-change]")!.textContent ?? "";
    assert.equal(avg, "1,000");
    assert.ok(
      change.startsWith("0%"),
      `two windows that both round to 1,000 must read 0%, not "${change}"`,
    );
  });
});

describe("a milestone's scope, from the store to the drawn mark", () => {
  test("the card hands the chart the service type the milestone was scoped to", () => {
    // The one leg neither trends.test.ts nor the chart's own tests can see:
    // `serviceTypeId` survives the derivation and the chart honours `seriesId`,
    // and between them sits this component, which dropped the field on the way
    // across. Both halves were green while a milestone scoped to the Youth
    // service drew across the Weekend line.
    return withCard(async (view) => {
      const marks = [...view.container.querySelectorAll("[data-milestone]")];
      assert.ok(marks.length > 0, "no marks drawn at all, so this asserts nothing");
      const scoped = marks.find((g) => g.querySelector("title")?.textContent === "Youth moved");
      assert.ok(scoped, `the scoped milestone was not drawn: ${marks.map((g) => g.querySelector("title")?.textContent).join(", ")}`);
      assert.equal(
        scoped.getAttribute("data-milestone-series"),
        "weekend",
        "the scope was dropped between the store and the chart",
      );
    });
  });
});

describe("switching a service type off", () => {
  test("takes its scoped milestone with it, and leaves the unscoped one", () => {
    // The rule lives in the chart and is proved there; what this proves is that
    // it is REACHABLE. The Trends chart shipped with a plain legend and no
    // toggle, so a milestone scoped to one type could never be seen scoping
    // anything — the behaviour was correct and unusable.
    return withCard(async (view) => {
      const toggle = view.container.querySelector<HTMLButtonElement>('[data-series-toggle="weekend"]');
      assert.ok(toggle, "the legend is not a toggle, so the scope rule is unreachable");
      assert.ok(
        [...view.container.querySelectorAll("[data-milestone]")].some(
          (g) => g.getAttribute("data-milestone-series") === "weekend",
        ),
        "the scoped mark was not drawn to begin with",
      );
      await act(async () => {
        toggle.click();
        await new Promise((r) => setTimeout(r, 0));
      });
      assert.deepEqual(
        [...view.container.querySelectorAll("[data-milestone]")].map((g) => g.getAttribute("data-milestone-series")),
        [],
        "the scoped mark stayed after its series went",
      );
    });
  });
});

describe("the measure switch", () => {
  const click = async (view: ReturnType<typeof render>, measure: string) => {
    const b = view.container.querySelector<HTMLButtonElement>(`[data-trend-measure="${measure}"]`);
    assert.ok(b, `no ${measure} button`);
    await act(async () => {
      b.click();
      await new Promise((r) => setTimeout(r, 0));
    });
  };

  test("defaults to attendance, and the tiles read as counts", async () => {
    const view = await renderCard(alternating());
    assert.equal(
      view.container.querySelector('[data-trend-measure="attendance"]')?.getAttribute("aria-pressed"),
      "true",
    );
    assert.equal(view.container.querySelector("[data-trend-average]")?.textContent, "1,000");
  });

  test("switching to sound puts the tiles in decibels", async () => {
    const view = await renderCard(alternating());
    await click(view, "sound");
    const avg = view.container.querySelector("[data-trend-average]")?.textContent ?? "";
    assert.match(avg, /^\d+ dB$/, `the tile did not switch to decibels: "${avg}"`);
    assert.equal(
      view.container.querySelector('[data-trend-measure="sound"]')?.getAttribute("aria-pressed"),
      "true",
    );
  });

  test("the choice is remembered across a remount", async () => {
    const first = await renderCard(alternating());
    await click(first, "sound");
    assert.equal(localStorage.getItem("history:trendMeasure"), "sound");
    cleanup();
    const second = await renderCard(alternating());
    assert.equal(
      second.container.querySelector('[data-trend-measure="sound"]')?.getAttribute("aria-pressed"),
      "true",
      "the card came back on attendance after the operator chose sound",
    );
    assert.match(second.container.querySelector("[data-trend-average]")?.textContent ?? "", /dB$/);
  });

  test("the axis is a dB band, never anchored at zero", async () => {
    // A count axis floors at 0 and a dB axis must not: 0 dB is not a floor a
    // sound chart has, and a plot from 0 to 100 flattens the ~20 dB band a
    // service actually lives in to nothing.
    const view = await renderCard(alternating());
    const labels = () =>
      [...view.container.querySelectorAll("text")]
        .map((n) => n.textContent ?? "")
        .filter((t) => /^[\d,]+$/.test(t));
    assert.ok(labels().includes("0"), `the attendance axis should floor at 0: ${labels().join(",")}`);
    await click(view, "sound");
    const dbLabels = labels().map(Number);
    assert.ok(dbLabels.length >= 2, `no dB axis labels at all: ${labels().join(",")}`);
    assert.equal(dbLabels.includes(0), false, `a dB axis anchored at zero: ${dbLabels.join(",")}`);
    assert.ok(Math.min(...dbLabels) > 50, `the dB band is not framing the levels: ${dbLabels.join(",")}`);
  });

  test("a type with no SPL records says so rather than vanishing", async () => {
    // Dropping the tile would read as the service type having disappeared the
    // moment you switched measure.
    const withSilent = [...alternating(), ...silentType()];
    const view = await renderCard(withSilent);
    const names = () => [...view.container.querySelectorAll("[data-trend-tile]")].map((t) => t.getAttribute("data-trend-tile"));
    assert.deepEqual(names().sort(), ["evening", "weekend"], "both types before the switch");
    await click(view, "sound");
    assert.deepEqual(names().sort(), ["evening", "weekend"], "a type went missing when the measure changed");
    const evening = view.container.querySelector('[data-trend-tile="evening"]')!;
    assert.equal(evening.querySelector("[data-trend-average]")?.textContent, "—");
    assert.equal(evening.querySelector("[data-trend-change]")?.textContent, "no sound recorded");
  });
});

/** A service type that recorded attendance and never any sound. */
function silentType(): TrendRecording[] {
  const start = Date.parse("2026-01-04T19:00:00Z");
  const DAY = 24 * 60 * 60_000;
  return Array.from({ length: 4 }, (_, i) => ({
    serviceKey: `evening:${i}`,
    serviceTypeId: "evening",
    serviceTypeName: "Evening",
    serviceDate: new Date(start + i * 7 * DAY).toISOString().slice(0, 10),
    t: start + i * 7 * DAY,
    seriesTitle: null,
    peakOccupancy: 200 + i,
    peakDb: null,
  }));
}

describe("when the milestone list will not load", () => {
  test("the card says so, and the reason is logged", async () => {
    // Swallowed, the chart drew the derived series-change marks and simply
    // lacked the operator's own — indistinguishable from having none, so
    // somebody who had just added one was looking at a chart that silently
    // disagreed with Settings.
    const warned: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(" ")); };
    try {
      const view = await renderCard(alternating(), { milestones: "fail" });
      assert.ok(
        view.container.querySelector("[data-milestones-failed]"),
        "the card must say the marks are missing, not just be missing them",
      );
      assert.ok(
        warned.some((l) => l.startsWith("[history] could not read the milestone list") && l.includes("nope")),
        `no tagged line carrying the reason: ${warned.join(" | ")}`,
      );
    } finally {
      console.warn = realWarn;
    }
  });

  test("a list that loads fine says nothing", async () => {
    const view = await renderCard(alternating());
    assert.equal(view.container.querySelector("[data-milestones-failed]"), null);
  });
});

/** Sixteen Sundays: eight alternating 1000/1001, then eight at 1000. Both
 *  windows round to 1,000. */
function alternating(): TrendRecording[] {
  const start = Date.parse("2026-01-04T15:00:00Z");
  const DAY = 24 * 60 * 60_000;
  return Array.from({ length: 16 }, (_, i) => ({
    serviceKey: `weekend:${i}`,
    serviceTypeId: "weekend",
    serviceTypeName: "Weekend",
    serviceDate: new Date(start + i * 7 * DAY).toISOString().slice(0, 10),
    t: start + i * 7 * DAY,
    seriesTitle: null,
    peakOccupancy: i < 8 ? (i % 2 === 0 ? 1000 : 1001) : 1000,
    // A level on every recording but the last two, so the sound measure has
    // something to plot and one type-less gap to step over.
    peakDb: i < 14 ? 94 + (i % 4) : null,
  }));
}

async function renderCard(recordings: TrendRecording[], opts: { milestones?: "fail" } = {}) {
  (globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown) => {
    if (String(input) === "/api/history/milestones") {
      if (opts.milestones === "fail") throw new Error("nope");
      return { ok: true, status: 200, json: async () => [], text: async () => "[]" };
    }
    return { ok: true, status: 200, json: async () => null, text: async () => "null" };
  };
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      React.createElement(TooltipProvider, null, React.createElement(TrendsCard, { recordings })),
    );
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
  });
  return view;
}

/** Renders the card with one milestone scoped to the only service type in the
 *  fixture, then hands the view to `check`. */
async function withCard(check: (view: ReturnType<typeof render>) => void | Promise<void>) {
  const recs = alternating();
  (globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown) => {
    const body =
      String(input) === "/api/history/milestones"
        ? [{ id: "m1", date: recs[10].serviceDate, label: "Youth moved", serviceTypeId: "weekend" }]
        : null;
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      React.createElement(TooltipProvider, null, React.createElement(TrendsCard, { recordings: recs })),
    );
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
  });
  try {
    await check(view);
  } finally {
    view.unmount();
  }
}
