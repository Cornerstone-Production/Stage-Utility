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

// jsdom's getBoundingClientRect is all zeros, and the chart REFUSES to map a
// pointer against a zero-width box — it would map every x to NaN. Give every
// element a box so a pointer move over the plot means an instant. The chart's
// own WIDTH still comes from `clientWidth`, which jsdom leaves at 0, so it
// draws at its 640px default: SVG_W matches that on purpose.
const SVG_W = 640;
Object.defineProperty(Element.prototype, "getBoundingClientRect", {
  configurable: true,
  value() {
    return { left: 0, top: 0, right: SVG_W, bottom: 217, width: SVG_W, height: 217, x: 0, y: 0, toJSON() {} };
  },
});

const { render, cleanup, act, fireEvent } = await import("@testing-library/react");
const React = (await import("react")).default;
const { Sparkline } = await import("./sparkline.js");
const { TrendsCard, absChange } = await import("./trends-card.js");
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
  test("it is an ABSOLUTE difference, and a zero carries no sign", () => {
    // Absolute, not a percentage: "seventy more people" is a van, "+6%" is a
    // conversation. A sign in front of zero claims a direction the number
    // denies, and which of "+0" and "−0" you got depended on the sign of a
    // difference too small to print.
    // One case per line, so two branches adding different ones merge cleanly.
    assert.deepEqual(
      [
        [0, 0, ""],
        [0.4, 0, ""],
        [-0.4, 0, ""],
        [71, 0, ""],
        [-71, 0, ""],
        [1234, 0, ""],
        [1.24, 1, " dB"],
        [-1.24, 1, " dB"],
        [0.04, 1, " dB"],
      ].map(([d, dp, unit]) => [d, absChange(d as number, dp as number, unit as string)]),
      [
        [0, "0"],
        [0.4, "0"],
        [-0.4, "0"],
        [71, "+71"],
        [-71, "−71"],
        // Counts read with separators; a decibel does not.
        [1234, "+1,234"],
        [1.24, "+1.2 dB"],
        [-1.24, "−1.2 dB"],
        [0.04, "0.0 dB"],
      ],
    );
  });

  test("the change is the difference of the tile's own two numbers", async () => {
    // Taken from the UNROUNDED figures it prints a change beside two numbers
    // that are equal on screen. The fixture is built so the two rules disagree:
    // the prior window means 1000.43 and the latest day is 1,000, so both round
    // to 1,000 — a change of 0 — while the raw difference rounds to "−0". The
    // tile must read 0.
    const view = await renderCard(straddlingRound());
    const tile = view.container.querySelector("[data-trend-tile]")!;
    const headline = tile.querySelector("[data-trend-latest]")!.textContent;
    const change = tile.querySelector("[data-trend-change]")!.textContent ?? "";
    view.unmount();
    assert.equal(headline, "1,000");
    assert.ok(
      change.startsWith("0 "),
      `two figures that both round to 1,000 must read 0, not "${change}"`,
    );
  });

  test("up is green and down is red — not the series colour", async () => {
    // The direction is the thing being read. The series colour is already on
    // the sparkline beside it, and spending it twice on one tile left the
    // direction with no colour at all.
    const up = await renderCard(longRun("weekend", 1000));
    const upClass = up.container.querySelector("[data-trend-change]")?.className ?? "";
    up.unmount();
    try { localStorage.clear(); } catch { /* jsdom always has one */ }

    // The same fixture reversed: sixteen weeks falling.
    const falling = longRun("weekend", 1000).map((r, i, a) => ({
      ...r,
      peakOccupancy: a[a.length - 1 - i].peakOccupancy,
    }));
    const down = await renderCard(falling);
    const downText = down.container.querySelector("[data-trend-change]")?.textContent ?? "";
    const downClass = down.container.querySelector("[data-trend-change]")?.className ?? "";
    down.unmount();

    assert.ok(upClass.includes("text-ok-11"), `a rise is not green: ${upClass}`);
    assert.ok(downText.startsWith("−"), `the fixture did not fall: ${downText}`);
    assert.ok(downClass.includes("text-danger-11"), `a fall is not red: ${downClass}`);
  });
});

describe("a day with three services", () => {
  /** The number of points a drawn line carries — one `M` or `L` each. */
  function nodesOn(view: ReturnType<typeof render>, id: string): number {
    const d = view.container.querySelector(`[data-series-line="${id}"]`)?.getAttribute("d") ?? "";
    return [...d.matchAll(/[ML]/g)].length;
  }

  /** The chart's y-axis labels, as numbers. */
  function axis(view: ReturnType<typeof render>): number[] {
    return [...view.container.querySelectorAll("text")]
      .map((n) => (n.textContent ?? "").replace(/,/g, ""))
      .filter((t) => /^\d+$/.test(t))
      .map(Number);
  }

  test("adds up into one point, on the tile AND on the line", async () => {
    // A church running a 9, an 11 and a 6 at 1,400 / 700 / 1,100 had 3,200
    // people that Sunday. The card used to print 1,400 — the busiest of the
    // three — on the tile and plot the same, so a day's second and third
    // services were nowhere on the page.
    //
    // WHAT THIS CANNOT SEE: the drawn pixels. jsdom loads no stylesheet, so the
    // chart falls back to its 640px default and the plot's real shape is
    // invisible. What it CAN read is what was handed to the SVG — how many
    // points the path carries and how high the axis had to reach — and those
    // are what a summed day changes. Driven in Chrome at 1440 as well.
    const view = await renderCard(threeServicesADay());
    const tile = view.container.querySelector('[data-trend-tile="weekend"]')!;
    assert.equal(
      tile.querySelector("[data-trend-latest]")?.textContent,
      "3,200",
      "the tile is still showing one service of the day",
    );
    assert.equal(nodesOn(view, "weekend"), 5, "the line drew a node per recording, not per day");
    // The axis had to make room for a summed day. A plot of the busiest service
    // alone tops out around 1,400 and could never reach here.
    assert.ok(
      Math.max(...axis(view)) >= 3200,
      `the line is not plotting day totals — the axis only reaches ${Math.max(...axis(view))}`,
    );
    view.unmount();
  });

  test("but its LEVEL is one recording's, on the tile and on the line", async () => {
    // Decibels do not add. Three services at 96, 99 and 104 are a 104 dB day,
    // and summing them would put 299 dB on the card and an axis to match.
    const view = await renderCard(threeServicesADay());
    await act(async () => {
      view.container.querySelector<HTMLButtonElement>('[data-trend-measure="sound"]')!.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    assert.equal(
      view.container.querySelector('[data-trend-tile="weekend"] [data-trend-latest]')?.textContent,
      "104.0 dB",
    );
    assert.equal(nodesOn(view, "weekend"), 5, "the line drew a node per recording, not per day");
    assert.deepEqual(
      axis(view).filter((v) => v > 120),
      [],
      `the sound axis is framing summed levels: ${axis(view).join(", ")}`,
    );
    view.unmount();
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
    assert.equal(view.container.querySelector("[data-trend-latest]")?.textContent, "1,000");
  });

  test("switching to sound puts the tiles in decibels", async () => {
    const view = await renderCard(alternating());
    await click(view, "sound");
    const avg = view.container.querySelector("[data-trend-latest]")?.textContent ?? "";
    assert.match(avg, /^[\d.]+ dB$/, `the tile did not switch to decibels: "${avg}"`);
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
    assert.match(second.container.querySelector("[data-trend-latest]")?.textContent ?? "", /dB$/);
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
    assert.equal(evening.querySelector("[data-trend-latest]")?.textContent, "—");
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


describe("the hover readout", () => {
  /** The CHART's svg. `querySelector("svg")` finds the first tile's sparkline —
   *  every tile has one, and they come first in the DOM. */
  function plotOf(view: ReturnType<typeof render>): SVGSVGElement {
    const svg = view.container.querySelector("[data-series-line]")?.closest("svg");
    assert.ok(svg, "the chart drew no line, so there is nothing to hover");
    return svg as SVGSVGElement;
  }

  /** The readout the subtitle row becomes under the pointer. Asserted rather
   *  than dereferenced, so a card that reports nothing fails with a sentence
   *  instead of a TypeError from the line after it. */
  function readoutIn(row: HTMLElement): HTMLElement {
    const readout = row.querySelector("[data-trends-readout]");
    assert.ok(readout, `hovering the plot said nothing: "${row.textContent}"`);
    return readout as HTMLElement;
  }

  /** Point at the middle of the plot, then hand back the card's subtitle row. */
  async function hoverPlot(view: ReturnType<typeof render>): Promise<HTMLElement> {
    const svg = plotOf(view);
    await act(async () => {
      fireEvent.pointerMove(svg, { clientX: SVG_W / 2, clientY: 60 });
      await new Promise((r) => setTimeout(r, 0));
    });
    return view.container.querySelector("[data-trends-subtitle]") as HTMLElement;
  }

  test("nothing is drawn over the plot at all — the chart has no strip", async () => {
    // The readout was a box laid over the top-left of the plot. Narrowed to its
    // text and made see-through it was still in FRONT of the line, and the
    // top-left is where a rising line ends up — the part a pointer there is
    // asking about.
    //
    // WHAT THIS CANNOT SEE: what covers what. jsdom loads no stylesheet, paints
    // nothing and measures every box as 0, so no assertion here can tell whether
    // one element is on top of another. What it CAN do is deny the structure
    // that made it possible: there is no strip, and nothing inside the card is
    // taken out of flow to sit over the plot. Driven in Chrome at 1440.
    const view = await renderCard(twoTypes());
    // Counted, not compared. `assert.equal(<a DOM node>, null)` puts the node
    // in the AssertionError, and serialising a jsdom element graph for the diff
    // takes the whole heap: the run is SIGKILLed with no message at all, which
    // is a guard that cannot report the bug it caught.
    assert.equal(
      view.container.querySelectorAll("[data-history-strip]").length,
      0,
      "the chart is still drawing a strip; the card is drawing the readout too",
    );
    // THE PLOT'S OWN WRAPPER, not the whole card. The overlay was positioned
    // against the chart's flex column — the element that held both the strip and
    // the svg — so that is the only subtree where "out of flow" can mean "over
    // the line". Scanning the card caught it, but it would also have caught a
    // popover or a tooltip somebody added to the tiles for a reason that has
    // nothing to do with covering the plot.
    const chart = plotOf(view).parentElement as HTMLElement;
    assert.ok(chart, "the plot has no wrapper, so this asserts nothing");
    const overlaid = [chart, ...chart.querySelectorAll("[class]")]
      .map((el) => el.className)
      .filter((c) => typeof c === "string" && /\babsolute\b/.test(c));
    assert.deepEqual(overlaid, [], `something is still laid over the plot: ${overlaid.join(" | ")}`);
    view.unmount();
  });

  test("hovering replaces the card's subtitle, and adds no row to do it", async () => {
    const view = await renderCard(twoTypes());
    const before = view.container.querySelector("[data-trends-subtitle]") as HTMLElement;
    assert.match(before.textContent ?? "", /per service type/, "the subtitle is not the at-rest sentence");
    assert.ok(!before.querySelector("[data-trends-readout]"), "a readout at rest");

    const after = await hoverPlot(view);
    // THE SAME ELEMENT. A second row appearing under the subtitle is a row of
    // height added, which pushes the plot down under the cursor.
    assert.ok(after === before, "the readout is a new element, not the subtitle's own row");
    assert.equal(view.container.querySelectorAll("[data-trends-subtitle]").length, 1);
    readoutIn(after);
    assert.doesNotMatch(after.textContent ?? "", /per service type/, "the subtitle is still there beside the readout");
    // One line in both states, so the row cannot grow when the readout is
    // longer than the sentence it replaced.
    assert.ok(/\btruncate\b/.test(after.className), `the readout row can wrap: ${after.className}`);
    // And still ANNOUNCED. The strip this replaced was a polite live region;
    // a row that changes under the pointer and never says so leaves a screen
    // reader on the at-rest sentence forever.
    assert.deepEqual(
      [after.getAttribute("role"), after.getAttribute("aria-live")],
      ["status", "polite"],
      "the readout is not a live region any more",
    );
    view.unmount();
  });

  test("it names the day and every VISIBLE type's value, each in its own colour", async () => {
    const view = await renderCard(twoTypes());
    const readout = readoutIn(await hoverPlot(view));
    const text = (readout.textContent ?? "").replace(/\s+/g, " ");
    // A date, not a time of day: the axis under the pointer is dates, and this
    // answered "2:32 pm" on sixteen weeks of Sundays.
    assert.match(text, /^[A-Z][a-z]{2} \d+ /, `the readout does not lead with the day: "${text}"`);
    for (const id of ["weekend", "evening"]) {
      assert.match(text, new RegExp(id), `${id} is not in the readout: "${text}"`);
    }
    // Each type's figure in the SAME colour as its line — which is what tells
    // you which of several lines you are reading.
    const colored = [...readout.querySelectorAll("[data-readout-series]")].map((el) => [
      el.getAttribute("data-readout-series"),
      (el as HTMLElement).style.color,
    ]);
    assert.deepEqual(
      colored.sort(),
      [
        ["evening", view.container.querySelector('[data-series-line="evening"]')!.getAttribute("stroke")],
        ["weekend", view.container.querySelector('[data-series-line="weekend"]')!.getAttribute("stroke")],
      ].sort(),
      "a type's value is not in its line's colour",
    );
    view.unmount();
  });

  test("a type switched off is not in it", async () => {
    // The readout reports what is DRAWN. A hidden type reporting a value is a
    // figure for a line that is not on the chart.
    await withTwoTypes(async (view, toggle) => {
      await toggle("evening");
      const readout = readoutIn(await hoverPlot(view));
      const text = (readout.textContent ?? "").replace(/\s+/g, " ");
      assert.match(text, /weekend/, `the drawn type is missing: "${text}"`);
      assert.doesNotMatch(text, /evening/, `a hidden type is still in the readout: "${text}"`);
    });
  });

  test("moving off the plot puts the subtitle back", async () => {
    const view = await renderCard(twoTypes());
    const row = await hoverPlot(view);
    readoutIn(row);
    await act(async () => {
      fireEvent.pointerLeave(plotOf(view));
      await new Promise((r) => setTimeout(r, 0));
    });
    assert.ok(!row.querySelector("[data-trends-readout]"), "the readout stayed after the pointer left");
    assert.match(row.textContent ?? "", /per service type/, "the subtitle did not come back");
    view.unmount();
  });
});

describe("a service type's colour", () => {
  /**
   * Every colour the card drew for one type, off what it PUT in the DOM: the
   * tile's sparkline, the chart line and the legend swatch. A colour decided
   * anywhere else cannot satisfy this.
   *
   * NOT the change figure. That is green or red by direction on purpose — the
   * series colour is already on the sparkline beside it, and the direction is
   * the thing being read. See "up is green and down is red".
   */
  const colorsFor = (view: ReturnType<typeof render>, id: string) => {
    const tile = view.container.querySelector(`[data-trend-tile="${id}"]`);
    const line = view.container.querySelector(`[data-series-line="${id}"]`);
    const swatch = view.container.querySelector(`[data-series-toggle="${id}"] span`) as HTMLElement | null;
    return {
      sparkline: tile?.querySelector("[data-sparkline]")?.getAttribute("stroke") ?? null,
      line: line?.getAttribute("stroke") ?? null,
      swatch: swatch?.style.borderColor || null,
    };
  };

  test("the BUSIEST type takes the lead colour, not whichever id sorts first", async () => {
    // Assigned over ids sorted alphabetically, a church got its midweek service
    // in green and its weekend — the line anyone opens this tab to read — in
    // the third colour. "evening" sorts before "weekend" and is the quieter of
    // the two, so this fixture fails on the old rule and passes on the new one.
    const view = await renderCard(twoTypes());
    const lead = view.container.querySelector('[data-series-line="weekend"]')?.getAttribute("stroke");
    const second = view.container.querySelector('[data-series-line="evening"]')?.getAttribute("stroke");
    view.unmount();
    assert.equal(lead, "var(--color-green-9)", "the busiest type did not get the lead colour");
    assert.equal(second, "var(--color-accent)", "the second-busiest did not get the second colour");
  });

  test("is the same on Attendance and on Sound", () => {
    // THE BUG Henry reported. Colours were the palette indexed by the tile
    // sort, and the sort is busiest-first, so switching measure re-sorted and
    // The Salt Company was blue on one and green on the other.
    return withTwoTypes(async (view) => {
      const before = colorsFor(view, "evening");
      assert.ok(before.line, "the evening line was not drawn, so this asserts nothing");
      await act(async () => {
        view.container.querySelector<HTMLButtonElement>('[data-trend-measure="sound"]')!.click();
        await new Promise((r) => setTimeout(r, 0));
      });
      assert.deepEqual(colorsFor(view, "evening"), before, "the colour moved when the measure did");
    });
  });

  test("is the same colour in the tile, the line and the legend", async () => {
    // Three surfaces, one entry. A tile drawn in a colour its own line does not
    // use is a tile that belongs to nothing.
    const view = await renderCard([...longRun("weekend", 1000), ...longRun("evening", 200)]);
    try {
      for (const id of ["weekend", "evening"]) {
        const c = colorsFor(view, id);
        assert.ok(c.line, `no line for ${id}`);
        assert.deepEqual(
          [c.sparkline, c.swatch],
          [c.line, c.line],
          `${id} is drawn in more than one colour: ${JSON.stringify(c)}`,
        );
      }
    } finally {
      view.unmount();
    }
  });

  test("is persisted, so a reload draws the same picture", async () => {
    // Derived fresh each visit it would follow whatever order the history
    // happened to be in that week.
    const recs = twoTypes();
    const first = await renderCard(recs);
    const before = colorsFor(first, "evening").line;
    assert.ok(before, "the evening line was not drawn");
    assert.match(localStorage.getItem("history:trendColors") ?? "", /"evening"/, "nothing was persisted");
    cleanup();

    // A SECOND type list, in a different order and with a new type in front of
    // the old ones — the shape that used to renumber everybody.
    const second = await renderCard([...twoTypes("midweek", 500), ...recs]);
    assert.equal(colorsFor(second, "evening").line, before, "the colour changed across a reload");
    second.unmount();
  });
});

describe("right-clicking to hide a service type", () => {
  const menuLabels = () =>
    [...document.querySelectorAll("[role='menu'] button")].map((b) => (b.textContent ?? "").trim());

  const rightClick = async (el: Element) => {
    await act(async () => {
      el.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }));
      await new Promise((r) => setTimeout(r, 0));
    });
  };

  /** Click a menu entry by its label. Returns false when there is none, so a
   *  missing entry is an assertion rather than a throw inside `act`. */
  const pickMenu = async (label: string) => {
    const button = [...document.querySelectorAll("[role='menu'] button")]
      .find((b) => b.textContent?.trim() === label);
    if (!button) return false;
    await act(async () => {
      button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    return true;
  };

  test("a tile's menu hides it from the tiles AND the chart", async () => {
    // Hidden used to mean "off the plot". The tile stayed, so half the type was
    // still on screen under a control that says Hide.
    //
    // Everything is READ, then the view is unmounted, THEN asserted. An
    // assertion thrown while the menu is mounted leaves its window listeners
    // behind and the file hangs instead of printing which assertion failed.
    const view = await renderCard(twoTypes());
    await rightClick(view.container.querySelector('[data-trend-tile="weekend"]')!);
    const offered = menuLabels();
    const clicked = await pickMenu("Hide weekend");
    const after = {
      tile: view.container.querySelector('[data-trend-tile="weekend"]') != null,
      line: view.container.querySelector('[data-series-line="weekend"]') != null,
      legendPressed: view.container
        .querySelector('[data-series-toggle="weekend"]')
        ?.getAttribute("aria-pressed") ?? null,
    };
    view.unmount();

    assert.ok(offered.includes("Hide weekend"), `no Hide entry: ${offered.join(", ")}`);
    assert.ok(clicked, "the Hide entry could not be clicked");
    assert.equal(after.tile, false, "the tile stayed after Hide");
    assert.equal(after.line, false, "the line stayed after Hide");
    // The legend keeps it, dimmed, so it can come back.
    assert.equal(after.legendPressed, "false", "the legend dropped the hidden type, so there is no way back");
  });

  test("Show all brings back EVERY hidden type, not just one of them", async () => {
    // A loop of toggles all read the same stale list, so the last write won and
    // the others were silently dropped.
    const view = await renderCard(twoTypes());
    const toggle = async (id: string) => {
      await act(async () => {
        view.container.querySelector<HTMLButtonElement>(`[data-series-toggle="${id}"]`)!.click();
        await new Promise((r) => setTimeout(r, 0));
      });
    };
    await toggle("weekend");
    await toggle("evening");
    const hiddenTiles = view.container.querySelectorAll("[data-trend-tile]").length;
    // With every series off the plot is gone, so the LEGEND is the only surface
    // left to right-click. It used to be gone too, which left an empty note and
    // no control anywhere on the page that could undo it.
    const entry = view.container.querySelector('[data-series-toggle="weekend"]');
    if (entry) await rightClick(entry);
    const restored = entry && (await pickMenu("Show all"))
      ? view.container.querySelectorAll("[data-trend-tile]").length
      : -1;
    view.unmount();

    assert.equal(hiddenTiles, 0, "both types should have been hidden");
    assert.ok(entry, "hiding everything left no way back on the page at all");
    assert.equal(restored, 2, "Show all brought back only some of them");
  });
});

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


/**
 * Sixteen Sundays whose two windows round to the SAME number while their raw
 * means differ by three quarters of a person.
 *
 * Prior eight: three 999s and five 1000s = 999.625 → 1,000.
 * Recent eight: three 1001s and five 1000s = 1000.375 → 1,000.
 *
 * So the change taken from the two rounded means is 0, and the change taken
 * from the raw ones is +1. Only one of those is the difference between the
 * numbers on screen.
 */
function straddlingRound(): TrendRecording[] {
  const peaks = [
    999, 999, 999, 1000, 1000, 1000, 1000, 1000,
    1001, 1001, 1001, 1000, 1000, 1000, 1000, 1000,
  ];
  const start = Date.parse("2026-01-04T15:00:00Z");
  const DAY = 24 * 60 * 60_000;
  return peaks.map((p, i) => ({
    serviceKey: `weekend:${i}`,
    serviceTypeId: "weekend",
    serviceTypeName: "Weekend",
    serviceDate: new Date(start + i * 7 * DAY).toISOString().slice(0, 10),
    t: start + i * 7 * DAY,
    seriesTitle: null,
    peakOccupancy: p,
    peakDb: null,
  }));
}

/** Five Sundays, each running a 9, an 11 and a 6 at 1,400 / 700 / 1,100 people
 *  and 96 / 99 / 104 dB — the shape of a church the day figure has to get
 *  right: 3,200 in the room across the day, and a 104 dB day. */
function threeServicesADay(): TrendRecording[] {
  const DAY = 24 * 60 * 60_000;
  const start = Date.parse("2026-01-04T15:00:00Z");
  const out: TrendRecording[] = [];
  for (let w = 0; w < 5; w++) {
    const day = start + w * 7 * DAY;
    [[1400, 96], [700, 99], [1100, 104]].forEach(([people, db], i) => {
      out.push({
        serviceKey: `weekend:${w}:${i}`,
        serviceTypeId: "weekend",
        serviceTypeName: "Weekend",
        serviceDate: new Date(day).toISOString().slice(0, 10),
        t: day + i * 2 * 60 * 60_000,
        seriesTitle: null,
        peakOccupancy: people,
        peakDb: db,
      });
    });
  }
  return out;
}

/** Sixteen days of one service type, so a tile has a prior window and prints a
 *  real change figure. `peak` drifts by a point a week so the two windows are
 *  not equal and the change is not "0". */
function longRun(typeId: string, peak: number): TrendRecording[] {
  const DAY = 24 * 60 * 60_000;
  const start = Date.parse("2026-01-04T15:00:00Z");
  return Array.from({ length: 16 }, (_, i) => ({
    serviceKey: `${typeId}:${i}`,
    serviceTypeId: typeId,
    serviceTypeName: typeId,
    serviceDate: new Date(start + i * 7 * DAY).toISOString().slice(0, 10),
    t: start + i * 7 * DAY,
    seriesTitle: null,
    peakOccupancy: peak + i,
    peakDb: 90 + (i % 5),
  }));
}

/** Ten days of one service type. Defaults to the weekend/evening pair the
 *  hide and colour tests use. */
function twoTypes(typeId?: string, peak?: number): TrendRecording[] {
  const DAY = 24 * 60 * 60_000;
  const start = Date.parse("2026-01-04T15:00:00Z");
  const of = (id: string, p: number): TrendRecording[] =>
    Array.from({ length: 10 }, (_, i) => ({
      serviceKey: `${id}:${i}`,
      serviceTypeId: id,
      serviceTypeName: id,
      serviceDate: new Date(start + i * 7 * DAY).toISOString().slice(0, 10),
      t: start + i * 7 * DAY,
      seriesTitle: null,
      peakOccupancy: p,
      peakDb: 95,
    }));
  if (typeId != null) return of(typeId, peak ?? 100);
  return [...of("weekend", 1000), ...of("evening", 200)];
}

/** Two service types, ten days each, and a way to switch one off. */
async function withTwoTypes(
  check: (view: ReturnType<typeof render>, toggle: (id: string) => Promise<void>) => void | Promise<void>,
) {
  const view = await renderCard(twoTypes());
  const toggle = async (id: string) => {
    await act(async () => {
      view.container.querySelector<HTMLButtonElement>(`[data-series-toggle="${id}"]`)!.click();
      await new Promise((r) => setTimeout(r, 0));
    });
  };
  try {
    await check(view, toggle);
  } finally {
    view.unmount();
  }
}
