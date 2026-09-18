// All services: one row per service, carrying the service's own figures.
//
// The rows used to carry "late", "ran" and a delta computed at the call site
// from a second `summarize()` — three expressions that were the same as the
// service page's on the day they were written and had nothing holding them
// together afterwards. They now come out of `serviceKpis`, PICKED BY KEY, so a
// row and the page it opens cannot quote different numbers for one recording.
//
// That identity is what is asserted: the row's values are compared against
// `serviceKpis`'s own output for the same record rather than against strings
// typed into this file. A test that hard-coded "1,196" would stay green if both
// sides changed together, which is the one thing it exists to prevent — and it
// would go red on a formatting change that broke nothing.
//
// WHAT IS NOT ASSERTED HERE, AND WHY. jsdom loads no stylesheet and lays
// nothing out, so the hairline between figures, the row's wrap to a stacked
// layout below `sm`, and the figure strip becoming a scroller on a narrow
// window are all invisible to it. Those were driven in Chrome at 1280 and 600,
// light and dark.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { installDom } from "../../test-dom.js";

const teardown = installDom();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as unknown as { EventSource: unknown }).EventSource = class {
  readyState = 1;
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
};

const DAY = "2026-09-13";
const iso = (hhmmss: string) => new Date(`${DAY}T${hhmmss}`).toISOString();

/** One recorded service: scheduled `start`, three counted items, ends `end`. */
function timeline(key: string, title: string, start: string, end: string): ServiceTimeline {
  return {
    serviceKey: key,
    serviceTypeId: "weekend",
    serviceTypeName: "Weekend",
    planId: "plan-1",
    planTitle: title,
    seriesTitle: "Rooted",
    serviceDate: DAY,
    serviceTimeId: key,
    serviceTimeStartsAt: iso(start),
    startedAt: iso(start),
    endedAt: iso(end),
    items: [
      { itemId: "a", title: "Welcome", sequence: 0, plannedLengthSec: 300, startedAt: iso(start), endedAt: iso(end), actualDurationSec: 330, counted: true },
      { itemId: "b", title: "Worship", sequence: 1, plannedLengthSec: 600, startedAt: iso(start), endedAt: iso(end), actualDurationSec: 700, counted: true },
    ],
  } as unknown as ServiceTimeline;
}

/** The matching attendance record — the row's Peak attendance is `peakOccupancy`
 *  (people in the room), never `peakAttendance` (the cumulative door count). */
function attendance(key: string, peakOccupancy: number, entries: number): ServiceAttendance {
  return {
    serviceKey: key,
    serviceTypeId: "weekend",
    serviceTypeName: "Weekend",
    planId: "plan-1",
    planTitle: "Sunday",
    seriesTitle: "Rooted",
    serviceDate: DAY,
    serviceTimeId: key,
    serviceTimeStartsAt: iso("09:00:00"),
    startedAt: iso("09:00:00"),
    endedAt: iso("10:30:00"),
    samples: [],
    attendanceBaseline: 0,
    totalAttendance: entries,
    peakAttendance: entries,
    peakOccupancy,
    minOccupancy: 10,
    lastAttendance: entries,
    lastOccupancy: peakOccupancy,
  } as unknown as ServiceAttendance;
}

const NINE = timeline("weekend:plan-1:0900", "Sunday 9:00", "09:00:00", "10:20:00");
const ELEVEN = timeline("weekend:plan-1:1100", "Sunday 11:00", "11:00:00", "12:22:00");
const ATT = [attendance(NINE.serviceKey, 1196, 2061), attendance(ELEVEN.serviceKey, 1402, 2310)];

/**
 * A recording that HAS sound, so the level figure is a real dB number.
 *
 * The guard over the level used to answer null for every SPL fetch, so both
 * sides of the comparison were "—" and it would have passed just as happily on
 * a row that never looked the record up at all. One of the two services carries
 * a record and the other does not, which also keeps the "no sound recorded"
 * case honest.
 */
const SPL = {
  serviceKey: ELEVEN.serviceKey,
  serviceTypeId: "weekend",
  planId: "plan-1",
  planTitle: "Sunday 11:00",
  seriesTitle: "Rooted",
  serviceDate: DAY,
  serviceTimeId: ELEVEN.serviceKey,
  serviceTimeStartsAt: iso("11:00:00"),
  meterId: "meter-1",
  metricKey: "LAeq 10",
  startedAt: iso("11:00:00"),
  endedAt: iso("12:22:00"),
  items: [
    {
      itemId: "a",
      title: "Welcome",
      sequence: 0,
      metrics: { "LAeq 10": { max: 96.4, avg: 90, leq: 91.2, count: 400 } },
      maxSpl: 96.4,
      sampleCount: 400,
      startedAt: iso("11:00:00"),
      endedAt: iso("11:06:00"),
    },
    {
      itemId: "b",
      title: "Worship",
      sequence: 1,
      metrics: { "LAeq 10": { max: 101.8, avg: 94, leq: 95.6, count: 900 } },
      maxSpl: 101.8,
      sampleCount: 900,
      startedAt: iso("11:06:00"),
      endedAt: iso("11:24:00"),
    },
  ],
} as unknown as ServiceSplHistory;

/** The real api.ts, routed by URL — the same approach history-arriving does. */
function installFetch(): void {
  (globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown) => {
    const url = String(input);
    const ok = (b: unknown) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });
    if (url === "/api/service-timeline") return ok([NINE, ELEVEN]);
    if (url === "/api/attendance/history") return ok(ATT);
    if (url === "/api/spl/summary") return ok([]);
    if (url === "/api/spl/trend") return ok({ shown: false, metric: null });
    if (url === "/api/baptism/sessions") return ok([]);
    // The 11 o'clock recorded sound; the 9 did not. One row must print a real
    // dB figure and the other the reason there is none.
    if (url === `/api/spl/history/${encodeURIComponent(ELEVEN.serviceKey)}`) return ok(SPL);
    if (url.startsWith("/api/spl/history/")) return ok(null);
    return ok(null);
  };
}

const { render, cleanup, act } = await import("@testing-library/react");
const React = (await import("react")).default;
const { TooltipProvider } = await import("../../components/ui/index.js");
const { ServiceHistorySection } = await import("./service-history-section.js");
const { serviceKpis, serviceRowFigures } = await import("./history-service-header.js");

afterEach(cleanup);
after(() => {
  cleanup();
  teardown();
});

async function renderList(readOnly = false) {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(ServiceHistorySection as React.ComponentType<{ readOnly: boolean }>, { readOnly }),
      ),
    );
    // Four turns: the list, the attendance list, the day settling, then the
    // per-row SPL fetches the day's rows kick off once it has.
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
  });
  return view;
}

/** `{ "Peak attendance": "1,196", … }` for one row, read off the DOM. */
function figuresOf(row: Element): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of row.querySelectorAll("[data-row-figure]")) {
    const [label, value] = [...f.children].map((c) => (c.textContent ?? "").trim());
    out[label] = value;
  }
  return out;
}

describe("the All services day list", () => {
  test("a two-service day renders two rows, each with the service page's own figures", async () => {
    installFetch();
    const view = await renderList();
    const rows = [...view.container.querySelectorAll("[data-history-row]")];
    assert.deepEqual(
      rows.map((r) => r.getAttribute("data-history-row")),
      // Newest first, which is the order `rows` sorts in and the order an
      // operator looking at today's services wants.
      [ELEVEN.serviceKey, NINE.serviceKey],
      "a day with two services must render two rows, newest first",
    );

    for (const [i, record] of [ELEVEN, NINE].entries()) {
      const att = ATT.find((a) => a.serviceKey === record.serviceKey) ?? null;
      const spl = record === ELEVEN ? SPL : null;
      const kpis = new Map(serviceKpis(record, att, spl).map((k) => [k.key, k]));
      const drawn = figuresOf(rows[i]);
      // The identity, figure by figure: each drawn value is the header's own.
      assert.equal(drawn["Peak attendance"], kpis.get("attendance")!.value, "Peak attendance must be the header's");
      assert.equal(drawn["Ran"], kpis.get("actual")!.value, "Ran must be the header's Actual");
      const levelLabel = kpis.get("level")!.label;
      assert.equal(drawn[levelLabel], kpis.get("level")!.value, "the peak level must be the header's");
      // And the row's own extra: versus plan, which the header carries as a
      // sub-line of Actual.
      const vsPlan = serviceRowFigures(record, att, spl).figures.find((f) => f.key === "vs-plan");
      assert.equal(drawn["vs plan"], vsPlan!.value, "vs plan must come from the same derivation");
      // The one figure that has been wrong before: attendance is people in the
      // ROOM, not the cumulative door count.
      assert.equal(drawn["Peak attendance"], att!.peakOccupancy.toLocaleString());
    }
  });

  test("a row names its plan, its series and how many items ran", async () => {
    installFetch();
    const view = await renderList();
    const first = view.container.querySelector(`[data-history-row="${NINE.serviceKey}"]`)!;
    const text = (first.textContent ?? "").replace(/\s+/g, " ");
    for (const part of ["Sunday 9:00", "Rooted", "2 items", "Weekend"]) {
      assert.ok(text.includes(part), `the row must say "${part}" — it said "${text}"`);
    }
  });

  test("the read-only view offers the same figures and no Delete", async () => {
    // The other half of renderer/app/shared-history-readonly.test.ts, from this
    // side: read-only must remove the destructive control and NOTHING ELSE. A
    // gate written one line too wide would take the figures with it, and the
    // shared /history link would go back to being a list of bare titles.
    installFetch();
    const open = await renderList(false);
    const openFigures = figuresOf(open.container.querySelector(`[data-history-row="${NINE.serviceKey}"]`)!);
    assert.deepEqual(
      [...open.container.querySelectorAll("button[aria-label^='Delete recording']")].length,
      2,
      "the operator's own list keeps a Delete per row",
    );
    cleanup();

    const ro = await renderList(true);
    const roFigures = figuresOf(ro.container.querySelector(`[data-history-row="${NINE.serviceKey}"]`)!);
    assert.deepEqual(roFigures, openFigures, "read-only must change nothing about what a row says");
    assert.deepEqual(
      [...ro.container.querySelectorAll("button[aria-label^='Delete recording']")].map((b) => b.getAttribute("aria-label")),
      [],
      "the shared link must carry nothing that deletes a recording",
    );
  });
});

describe("the level figure on a row", () => {
  test("a service that recorded sound shows a dB number, named after the metric it read", async () => {
    installFetch();
    const view = await renderList();
    const drawn = figuresOf(view.container.querySelector(`[data-history-row="${ELEVEN.serviceKey}"]`)!);
    // The loudest reading on the record, not an energy average and not a dash.
    assert.ok(
      Object.entries(drawn).some(([label, value]) => /^Peak LAeq 10$/.test(label) && value === "102 dB"),
      `the row did not show the recorded peak as a dB figure: ${JSON.stringify(drawn)}`,
    );
  });

  test("a service with no sound says WHY there is no number", async () => {
    // The row stripped the level's note, so a bare "—" sent an operator to look
    // at a meter that was fine. The note is the only thing that tells "nothing
    // was recorded" from "you have this metric hidden in Sound".
    installFetch();
    const view = await renderList();
    const row = view.container.querySelector(`[data-history-row="${NINE.serviceKey}"]`)!;
    const drawn = figuresOf(row);
    assert.equal(drawn["Peak level"], "—", `expected no level for the 9 o'clock: ${JSON.stringify(drawn)}`);
    const notes = [...row.querySelectorAll("[data-row-figure-note]")].map((n) => n.textContent?.trim());
    assert.deepEqual(notes, ["no sound recorded"], "a dash with no reason beside it");
  });

  test("a FAILED read says so, rather than borrowing the sentence for silence", async () => {
    // Both used to land as null, so a server that was down told the operator
    // their meter had not been recording. And it is logged, per key: a day where
    // one of three services will not load is a different problem from a day
    // where none of them will.
    const warned: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(" ")); };
    try {
      installFetch();
      const real = (globalThis as unknown as { fetch: (i: unknown) => Promise<unknown> }).fetch;
      (globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown) => {
        if (String(input).startsWith("/api/spl/history/")) throw new Error("socket hang up");
        return real(input);
      };
      const view = await renderList();
      const row = view.container.querySelector(`[data-history-row="${ELEVEN.serviceKey}"]`)!;
      const notes = [...row.querySelectorAll("[data-row-figure-note]")].map((n) => n.textContent?.trim());
      assert.deepEqual(notes, ["sound unavailable"], "a failed read must not read as a service that recorded nothing");
      assert.deepEqual(
        warned.filter((l) => l.startsWith("[history] could not read the sound record")).length,
        2,
        `one [history] line per failed key, not one for the batch: ${warned.join(" | ")}`,
      );
      assert.ok(warned.some((l) => l.includes("socket hang up")), "the line must carry the reason");
    } finally {
      console.warn = realWarn;
    }
  });
});

describe("a history load that failed, rather than came back empty", () => {
  /** Renders with `failing` URLs throwing, and collects the log lines. */
  async function withFailures(failing: (url: string) => boolean) {
    const warned: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(" ")); };
    installFetch();
    const real = (globalThis as unknown as { fetch: (i: unknown) => Promise<unknown> }).fetch;
    (globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown) => {
      if (failing(String(input))) throw new Error("socket hang up");
      return real(input);
    };
    try {
      return { view: await renderList(), warned };
    } finally {
      console.warn = realWarn;
    }
  }

  test("the empty state says the history could not be READ", async () => {
    // All three loads used to `.catch(() => set…([]))`, which is the same lie
    // three times: a server that was down read as "No service timings recorded
    // yet" and sent an operator to look at a recorder that was fine.
    const { view, warned } = await withFailures((url) =>
      url === "/api/service-timeline" || url === "/api/attendance/history");
    const txt = (view.container.textContent ?? "").replace(/\s+/g, " ");
    assert.ok(
      txt.includes("could not be read"),
      `a failed read still reads as an empty history: ${txt.slice(0, 200)}`,
    );
    assert.equal(
      txt.includes("No service timings recorded yet"),
      false,
      "the absence copy is still being used for a failure",
    );
    // And both failures are named, separately — one line per load, so a day
    // where one of them is down is distinguishable from one where both are.
    const lines = warned.filter((l) => l.startsWith("[history] could not read"));
    assert.deepEqual(
      lines.map((l) => l.replace(/: .*/, "")).sort(),
      ["[history] could not read the attendance history", "[history] could not read the service timings"],
    );
    assert.ok(lines.every((l) => l.includes("socket hang up")), "the lines must carry the reason");
  });

  test("a failed SOUND summary says so on Trends instead of reading as silence", async () => {
    const { view, warned } = await withFailures((url) => url === "/api/spl/summary");
    // The note lives on the SOUND measure, which is where the lie would be —
    // an attendance chart is not wrong because the sound summary did not load.
    // So this walks the path an operator walks: click Sound, then read it.
    const { act } = await import("@testing-library/react");
    await act(async () => {
      view.container.querySelector<HTMLButtonElement>('[data-trend-measure="sound"]')!.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    assert.ok(
      view.container.querySelector("[data-sound-unavailable]"),
      "the Trends card must say the sound summary is missing, not just be missing it",
    );
    // And the TILES, one level down, say the same thing: a type with no level
    // because the summary would not load is not a type that recorded no sound.
    const tileNotes = [...view.container.querySelectorAll("[data-trend-change]")].map((n) => n.textContent);
    assert.ok(tileNotes.length > 0, "no tiles at all, so this asserts nothing");
    assert.deepEqual(
      [...new Set(tileNotes)],
      ["sound unavailable"],
      `a tile is still reading a failed load as silence: ${JSON.stringify(tileNotes)}`,
    );
    assert.ok(
      warned.some((l) => l.startsWith("[history] could not read the sound summary")),
      `no tagged line for the sound summary: ${warned.join(" | ")}`,
    );
    // The rest of the page is unaffected: the timings loaded fine.
    assert.ok(view.container.querySelectorAll("[data-history-row]").length > 0, "the day list went too");
  });
});

describe("what the All services page is made of", () => {
  // The page composition itself, because two of the three things here are a
  // REMOVAL and a MOVE: a removal nothing asserts comes back on the next merge,
  // and a shipped feature moved behind a button is one refactor away from being
  // a shipped feature that is gone.

  test("there is no Overview card, and Export is in the Recorded services header", async () => {
    installFetch();
    const view = await renderList();
    const text = view.container.textContent ?? "";

    // GONE. Its five figures were an all-time blend across one service type;
    // every one of them is on the service page's own KPI row instead.
    assert.ok(!text.includes("Avg length"), "the Overview card is still on the page");
    assert.ok(!text.includes("Avg start"), "the Overview card is still on the page");
    assert.equal(
      view.container.querySelector('[aria-label="Overview service type"]'),
      null,
      "the Overview scope picker is still there",
    );

    // MOVED, not removed. Export is a shipped feature.
    assert.ok(text.includes("Recorded services"), "the list card has no title");
    const exportTrigger = view.container.querySelector('[aria-label="Export"]');
    assert.ok(exportTrigger, "Export is gone from the page entirely");
    assert.equal(exportTrigger.closest("[data-history-row]"), null, "Export landed inside a service row");
    // In the HEADER, beside the title — not floating somewhere else on the page.
    const header = [...view.container.querySelectorAll("h3")]
      .find((h) => h.textContent?.trim() === "Recorded services")?.parentElement;
    assert.ok(header?.contains(exportTrigger), "Export is not in the Recorded services header");
  });

  test("the header says which day it is showing and how many services", async () => {
    installFetch();
    const view = await renderList();
    const text = view.container.textContent ?? "";
    assert.match(text, /Showing .+ · 2 services/, `no count in the header: ${text.slice(0, 400)}`);
  });
});
