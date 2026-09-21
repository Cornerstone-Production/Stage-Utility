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
function installFetch(opts: { extra?: ServiceTimeline[] } = {}): void {
  (globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown) => {
    const url = String(input);
    const ok = (b: unknown) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });
    if (url === "/api/service-timeline") return ok([NINE, ELEVEN, ...(opts.extra ?? [])]);
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

type Edge = "top" | "bottom" | "left" | "right";
const EDGES: Edge[] = ["top", "bottom", "left", "right"];
/** Which edges a Tailwind axis suffix touches: `p-3` all four, `py-3` two. */
const AXIS: Record<string, Edge[]> = {
  "": EDGES,
  x: ["left", "right"],
  y: ["top", "bottom"],
  t: ["top"],
  b: ["bottom"],
  l: ["left"],
  r: ["right"],
};

/**
 * The padding a rendered class list ADDS and the margin it PULLS BACK, per
 * edge, in px.
 *
 * Tailwind's spacing scale is 0.25rem a step, so `p-3` is 12px and `py-3.5` is
 * 14px. Read off the element's own `class` attribute rather than off this
 * repository's source, so a class that arrives through a helper, a variant or a
 * `cn()` branch still counts — and the LAST token for an edge wins, which is
 * what `cn`'s tailwind-merge leaves behind.
 *
 * A negative margin is the interesting half: it is how a ring comes to be drawn
 * outside the box the layout gave it, in space that belongs to its neighbour.
 */
function spacingOf(className: string): { pad: Record<Edge, number>; pull: Record<Edge, number> } {
  const pad: Record<Edge, number> = { top: 0, bottom: 0, left: 0, right: 0 };
  const pull: Record<Edge, number> = { top: 0, bottom: 0, left: 0, right: 0 };
  for (const token of className.split(/\s+/)) {
    const m = /^(-?)([pm])([xytrbl]?)-([\d.]+)$/.exec(token);
    if (!m) continue;
    const [, sign, kind, axis, size] = m;
    const px = Number(size) * 4;
    for (const edge of AXIS[axis]) {
      if (kind === "p") pad[edge] = px;
      else pull[edge] = sign === "-" ? px : -px;
    }
  }
  return { pad, pull };
}

/** The `gap-N` a flex column puts between its children, in px. */
function gapOf(className: string): number {
  const m = /(?:^|\s)gap-([\d.]+)(?:\s|$)/.exec(className);
  return m ? Number(m[1]) * 4 : 0;
}

/**
 * How far a `ring-N` is PAINTED outside the padding box, in px.
 *
 * Tailwind's ring is a box-shadow, not a border: it adds nothing to the layout
 * and draws entirely outside the box `spacingOf` measures. A clearance taken
 * from the box alone is that much too generous — the arithmetic said 12px and 4px
 * where the painted edge really stands at 11px and 3px. Read off the class so it
 * stays exact if the ring ever gets thicker; `ring` with no number is 3px, which
 * is Tailwind's own default.
 */
function ringWidthOf(className: string): number {
  const m = /(?:^|\s)ring(?:-(\d+))?(?:\s|$)/.exec(className);
  if (!m) return 0;
  return m[1] == null ? 3 : Number(m[1]);
}

/**
 * Any spacing or gap token behind a VARIANT — `sm:p-4`, `hover:gap-2`.
 *
 * `spacingOf` and `gapOf` read the unconditional ones only: a variant's value
 * depends on a media query or a state jsdom does not have, and silently reading
 * the base value instead would make the clearance arithmetic below quietly wrong
 * at exactly the width somebody added the variant for. Asserted as empty rather
 * than handled, so the next person to add one is told the helper cannot see it.
 */
function variantSpacing(className: string): string[] {
  return className.split(/\s+/).filter((t) => /:-?(?:[pm][xytrbl]?|gap)-[\d.]+$/.test(t));
}

/**
 * `{ attendance: { value: "1,196", caption: "peak in room" }, … }` for one row,
 * keyed by COLUMN.
 *
 * Keyed by the column rather than by the caption, because the caption is no
 * longer the column's name: the value leads and the caption under it says what
 * the figure is about — the metric for the level, the reason when there is no
 * number. The column heading is drawn once per day group instead.
 */
function figuresOf(row: Element): Record<string, { value: string; caption: string }> {
  const out: Record<string, { value: string; caption: string }> = {};
  for (const f of row.querySelectorAll("[data-row-figure]")) {
    const key = f.getAttribute("data-row-figure") ?? "";
    const [value, caption] = [...f.children].map((c) => (c.textContent ?? "").trim());
    out[key] = { value, caption };
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
      assert.equal(drawn.attendance.value, kpis.get("attendance")!.value, "Peak must be the header's");
      assert.equal(drawn.actual.value, kpis.get("actual")!.value, "Ran must be the header's Actual");
      assert.equal(drawn.level.value, kpis.get("level")!.value, "the peak level must be the header's");
      // And the row's own extra: versus plan, which the header carries as a
      // sub-line of Actual.
      const vsPlan = serviceRowFigures(record, att, spl).figures.find((f) => f.key === "vs-plan");
      assert.equal(drawn["vs-plan"].value, vsPlan!.value, "vs plan must come from the same derivation");
      // The one figure that has been wrong before: attendance is people in the
      // ROOM, not the cumulative door count.
      assert.equal(drawn.attendance.value, att!.peakOccupancy.toLocaleString());
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

  test("no row carries a Delete, open or read-only, and read-only changes nothing else", async () => {
    // Delete lives on the service page's header, once, behind a confirm. The
    // list matches the mockup: a row is a summary with a chevron, on either
    // side of the read-only gate. The second half is the other half of
    // renderer/app/shared-history-readonly.test.ts, from this side: read-only
    // must remove destructive controls and NOTHING ELSE — a gate written one
    // line too wide would take the figures with it, and the shared /history
    // link would go back to being a list of bare titles.
    installFetch();
    const open = await renderList(false);
    const openFigures = figuresOf(open.container.querySelector(`[data-history-row="${NINE.serviceKey}"]`)!);
    assert.deepEqual(
      [...open.container.querySelectorAll("button[aria-label^='Delete recording']")].map((b) => b.getAttribute("aria-label")),
      [],
      "a list row must not carry Delete; it lives on the service page header",
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
    // The loudest reading, with the METRIC as its caption — which meter reading
    // this is matters more on a row than repeating the heading above it, and
    // the heading has already said "peak".
    assert.deepEqual(
      drawn.level,
      { value: "102 dB", caption: "LAeq 10" },
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
    assert.equal(drawn.level.value, "—", `expected no level for the 9 o'clock: ${JSON.stringify(drawn)}`);
    assert.equal(drawn.level.caption, "no sound recorded", "a dash with no reason under it");
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
      assert.equal(
        figuresOf(row).level.caption,
        "sound unavailable",
        "a failed read must not read as a service that recorded nothing",
      );
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

  test("the list is a CARD, with its title, count and Export inside it", async () => {
    // It was flat on the page while Trends above it and the calendar beside it
    // were cards, so the one column an operator reads down was the only thing
    // on the tab not sitting on a surface.
    //
    // WHAT THIS CANNOT SEE: the border, the radius and the padding. They come
    // from `.su-card` in styles.css, and jsdom loads no stylesheet. Measured in
    // Chrome instead — 1px border, 14px radius, the same box Trends draws — and
    // what is asserted here is that the class is on the element and that the
    // three header pieces are inside it rather than floating above it.
    installFetch();
    const view = await renderList();
    const card = view.container.querySelector("[data-services-card]");
    assert.ok(card, "the list is not wrapped in a card at all");
    assert.ok(card.className.includes("su-card"), `the wrapper is not the app's card: ${card.className}`);
    for (const [what, sel] of [
      ["the title", "h3"],
      ["the Showing line", "[data-list-showing]"],
      ["Export", "[aria-label='Export']"],
    ] as const) {
      assert.ok(card.querySelector(sel), `${what} is not inside the card`);
    }
    // And the rows are RECESSED inside it, not cards of their own: a card
    // inside a card flattens the nesting it is there to create.
    const rows = [...view.container.querySelectorAll("[data-history-row]")]
      .map((r) => r.parentElement?.className ?? "");
    assert.ok(rows.length > 0, "no rows, so this asserts nothing");
    assert.deepEqual(rows.filter((c) => c.includes("su-card")), [], "a row is still a card inside the card");
  });

  test("the header names the MONTH it is showing and counts the month's services", async () => {
    installFetch();
    const view = await renderList();
    const showing = view.container.querySelector("[data-list-showing]")?.textContent ?? "";
    // The month, not the day. A list of one day meant paging the calendar to
    // read a month with the calendar sitting right beside it.
    assert.match(showing, /^Showing September 2026 · 2 services$/, `the header still names a day: "${showing}"`);
  });

  test("the list is the whole visible month, grouped by day, newest first", async () => {
    // Both fixtures are on the 13th, so a second day is added here — a list
    // that filtered to one day would show one group and one row.
    const EARLIER = timeline("weekend:plan-0:0900", "Sunday 9:00", "09:00:00", "10:20:00");
    const earlier = { ...EARLIER, serviceDate: "2026-09-06", serviceTimeStartsAt: iso("09:00:00") };
    installFetch({ extra: [earlier] });
    const view = await renderList();

    const groups = [...view.container.querySelectorAll("[data-day-group]")]
      .map((g) => g.getAttribute("data-day-group"));
    assert.deepEqual(groups, ["2026-09-13", "2026-09-06"], "the month's days, newest first");
    assert.equal(
      view.container.querySelectorAll("[data-history-row]").length,
      3,
      "every service in the month is listed, not just the selected day's",
    );
    // The column header is drawn ONCE for the list, under the first day label.
    // Under every day it was eight repetitions of "WHEN SERVICE PEAK RAN VS
    // PLAN PEAK DB" between nine rows — the loudest thing on the card.
    const headers = [...view.container.querySelectorAll("[data-row-header]")];
    assert.equal(headers.length, 1, "the column header repeats per day group");
    assert.equal(
      headers[0].closest("[data-day-group]")?.getAttribute("data-day-group"),
      "2026-09-13",
      "the one header is not in the FIRST group",
    );
  });

  test("picking a calendar day rings its group instead of hiding the others", async () => {
    const EARLIER = timeline("weekend:plan-0:0900", "Sunday 9:00", "09:00:00", "10:20:00");
    const earlier = { ...EARLIER, serviceDate: "2026-09-06", serviceTimeStartsAt: iso("09:00:00") };
    installFetch({ extra: [earlier] });
    const view = await renderList();

    const cell = view.container.querySelector<HTMLButtonElement>('button[data-date="2026-09-06"]');
    assert.ok(cell, "no calendar cell for the earlier day");
    await act(async () => {
      cell.click();
      await new Promise((r) => setTimeout(r, 0));
    });

    assert.equal(
      view.container.querySelector("button[data-selected]")?.getAttribute("data-date"),
      "2026-09-06",
      "the calendar did not follow the click",
    );
    // THE POINT: the other day's rows are still there.
    assert.equal(
      view.container.querySelectorAll("[data-history-row]").length,
      3,
      "picking a day filtered the list down to it",
    );
    // And the picked group is the one that carries the ring, so the click did
    // something visible rather than nothing at all.
    const ringed = [...view.container.querySelectorAll("[data-day-group]")]
      .filter((g) => g.className.includes("ring-accent"))
      .map((g) => g.getAttribute("data-day-group"));
    assert.deepEqual(ringed, ["2026-09-06"], "the picked day's group is not marked");

    // ── The ring stands clear of everything around it ──
    //
    // WHAT THIS CANNOT SEE: the pixels. jsdom loads no stylesheet and reports
    // every box as 0, so a geometry assertion would pass on any layout at all.
    // What it CAN do is the arithmetic those pixels come out of, off the class
    // attribute the element actually rendered: Tailwind's spacing scale is
    // 0.25rem a step, so the padding a group adds and the margin it pulls back
    // are both readable numbers, and the clearance is their difference against
    // the gap and padding of the card the group sits in. Measured in Chrome at
    // 1440 as well — the ring's top edge sits 12px under the Export button.
    //
    // The defect: at `p-3 -m-3` the ring drew 12px OUTSIDE its own box on all
    // four edges, into gaps of 8px (the card's `gap-2`) and padding of 14px. It
    // touched the Recorded services header, the next day group and the bottom
    // of the card at once.
    const ringedEl = view.container.querySelector('[data-day-group="2026-09-06"]') as HTMLElement;
    const card = view.container.querySelector("[data-services-card]") as HTMLElement;
    assert.deepEqual(
      [...variantSpacing(ringedEl.className), ...variantSpacing(card.className)].sort(),
      [],
      "the arithmetic below cannot read a spacing token behind a variant",
    );
    const ring = spacingOf(ringedEl.className);
    const cardPad = spacingOf(card.className).pad;
    const gap = gapOf(card.className);
    assert.ok(
      ring.pad.top >= 12 && ring.pad.left >= 12,
      `the ring has no inset from its own content: ${ringedEl.className}`,
    );
    // THE PAINTED EDGE, not the box. A Tailwind ring is a box-shadow drawn
    // outside the padding box, so every clearance is one ring-width shorter than
    // the boxes suggest: the real figures at 1440 are 11px and 3px, not 12 and 4.
    const paint = ringWidthOf(ringedEl.className);
    // One clearance per EDGE per line, sorted by what the ring is standing off,
    // so two branches adding different edges conflict instead of merging
    // silently — and so a branch changing `-mx-3` to `-mr-4` cannot pass on the
    // strength of the left side alone.
    const clearances: [what: string, clear: number, floor: number][] = [
      ["the card's bottom padding, under the last day of a month", cardPad.bottom - ring.pull.bottom - paint, 11],
      ["the card's left padding", cardPad.left - ring.pull.left - paint, 3],
      ["the card's right padding", cardPad.right - ring.pull.right - paint, 3],
      ["the day group above it, or the Recorded services header", gap - ring.pull.top - paint, 11],
      ["the day group below it", gap - ring.pull.bottom - paint, 11],
    ];
    // Every failing edge at once, not the first: the bug put the ring hard
    // against four different things, and a one-at-a-time assertion would have
    // been four runs to find that out.
    assert.deepEqual(
      clearances
        .filter(([, clear, floor]) => clear < floor)
        .map(([what, clear, floor]) => `the ring is ${clear}px from ${what}; it needs ${floor}px`),
      [],
    );
  });
});

describe("a row's columns", () => {
  test("a LIVE row, which has no vs-plan, dashes that column and keeps Peak dB in its own", async () => {
    // Taken in ORDER rather than by key, a live recording — `serviceRowFigures`
    // drops `vs plan` while one is running — slid Peak dB one column left,
    // under the "VS PLAN" heading. The heading is drawn once per day group, so
    // a row that closes a gap lies about every column to its right, and it does
    // it on exactly the rows an operator is most likely to be looking at.
    const LIVE = {
      ...timeline("weekend:plan-1:1300", "Sunday 1:00", "13:00:00", "14:00:00"),
      endedAt: null,
    } as unknown as ServiceTimeline;
    installFetch({ extra: [LIVE] });
    const view = await renderList();

    const live = view.container.querySelector(`[data-history-row="${LIVE.serviceKey}"]`);
    assert.ok(live, "the live recording did not render");
    const drawn = figuresOf(live);
    assert.deepEqual(
      Object.keys(drawn),
      ["attendance", "actual", "vs-plan", "level"],
      "a row dropped a column instead of dashing it",
    );
    assert.equal(drawn["vs-plan"].value, "—", "a live row has no vs plan, and the column must say so");
    // And the level is in the LEVEL column, not shifted into vs-plan's.
    assert.equal(drawn.level.caption, "no sound recorded", `Peak dB landed in the wrong column: ${JSON.stringify(drawn)}`);
  });

  test("a LIVE row's recording pill sits after the plan title, not in the WHEN column", async () => {
    // The pill does not shrink — it is a fixed badge — and in the WHEN column it
    // shared 104px with the service type. The type took whatever was left and
    // "Weekend" read as "W…", on the one row an operator is most likely to be
    // looking at.
    //
    // WHAT THIS CANNOT SEE: the ellipsis. `truncate` is a stylesheet rule and
    // jsdom loads none, so the type's text content is "Weekend" whether it is
    // squeezed to nothing or not. What it CAN see is the structure that did the
    // squeezing: which column the pill is in, and whether anything shares the
    // type's line. Driven in Chrome at 1440 and 900 as well.
    const LIVE = {
      ...timeline("weekend:plan-1:1300", "Sunday 1:00", "13:00:00", "14:00:00"),
      endedAt: null,
    } as unknown as ServiceTimeline;
    installFetch({ extra: [LIVE] });
    const view = await renderList();
    const live = view.container.querySelector(`[data-history-row="${LIVE.serviceKey}"]`) as HTMLElement;
    assert.ok(live, "the live recording did not render");

    const when = live.querySelector("[data-row-when]") as HTMLElement;
    const service = live.querySelector("[data-row-service]") as HTMLElement;
    assert.equal(
      when.querySelectorAll('[data-testid="recording-pill"]').length,
      0,
      `the pill is still in the WHEN column, squeezing the service type: ${when.textContent}`,
    );
    const pill = service.querySelector('[data-testid="recording-pill"]');
    assert.ok(pill, `the live row lost its recording pill altogether: ${service.textContent}`);
    // Beside the TITLE, on the first line — not stranded on the series line
    // under it, which is where "recording…" used to be.
    assert.equal(
      pill.parentElement?.firstElementChild?.textContent,
      "Sunday 1:00",
      "the pill is not the plan title's own neighbour",
    );
    // And CLIPPED with the title. SERVICE is the row's only flexible track, and
    // between 640 and about 1,150px wide it resolves to ZERO — measured in
    // Chrome: 238px at 1440, 78px at 1280, 0 from 1152 down. A pill does not
    // shrink, so in a zero-width cell it paints over the figure in the next
    // column instead of disappearing with the title beside it. jsdom lays out
    // nothing, so what is asserted is the rule that clips it.
    assert.ok(
      /\boverflow-hidden\b/.test(pill.parentElement?.className ?? ""),
      `the pill can paint outside the SERVICE column: ${pill.parentElement?.className}`,
    );
    // WHICH MEANS THE PILL IS NOT ENOUGH ON ITS OWN. Clipped away, the row has
    // nothing left saying it is live except a RAN caption that is itself near
    // the clipping edge. The dot rides with the start time instead, in WHEN —
    // a fixed 104px track, and the leftmost, so it is the one cell that cannot
    // be squeezed out. Six pixels beside a 42px time, not the 84px pill that
    // used to live there.
    const dot = when.querySelector('[data-testid="recording-dot"]');
    assert.ok(dot, `no live marker survives a zero-width SERVICE column: ${when.textContent}`);
    assert.equal(
      dot.previousElementSibling?.textContent,
      when.firstElementChild?.firstElementChild?.textContent,
      "the live dot is not beside the start time",
    );
    // Named, not just coloured: six green pixels are not a fact a screen reader
    // or a colour-blind operator can read.
    assert.equal(dot.getAttribute("aria-label"), "recording", "the live dot has no accessible name");
    // And GONE on a finished row, or it says every row is recording.
    const done = view.container.querySelector(`[data-history-row="${NINE.serviceKey}"]`) as HTMLElement;
    assert.equal(
      done.querySelectorAll('[data-testid="recording-dot"]').length,
      0,
      "a finished recording is wearing the live dot",
    );
    // The type has its line to itself and reads in full.
    assert.equal(
      (when.lastElementChild?.textContent ?? "").trim(),
      "Weekend",
      `something is sharing the service type's line: ${when.lastElementChild?.textContent}`,
    );
    // And the subtitle is back to what it says on a finished row: the pill
    // already says it is recording, and "recording…" cost the reader the only
    // place the row counts the items that have run.
    assert.equal(
      (service.lastElementChild?.textContent ?? "").trim(),
      "Rooted · 2 items",
      "a live row's subtitle must count its items, not repeat the pill",
    );
  });

  test("the header names the same columns, in the same order, as the rows carry", async () => {
    // A heading one column left of its figures is the failure. Asserted as the
    // two lists rather than as a screenshot, because jsdom lays out nothing.
    installFetch();
    const view = await renderList();
    const headings = [...(view.container.querySelector("[data-row-header]")?.children ?? [])]
      .map((c) => (c.textContent ?? "").trim());
    assert.deepEqual(headings, ["When", "Service", "In room", "Ran", "vs plan", "Peak dB", ""]);
    const row = view.container.querySelector("[data-history-row]")!;
    // Two leading cells (When, Service), four figures, then the chevron — the
    // same seven tracks the heading spans.
    assert.equal(row.children.length, headings.length);
  });

  test("the in-room column says WHICH attendance figure it is, in both its labels", async () => {
    // The app tracks two attendance numbers for one service: `peakOccupancy`,
    // the most people in the room at once, and `peakAttendance`, the cumulative
    // door count, which double-counts anyone who steps out and back. The column
    // was headed "Peak" and captioned "peak", which names either of them — and
    // the service page's header has had the two the wrong way round once
    // already, printing 2,061 where it meant 1,196.
    //
    // WHAT THIS CANNOT SEE: whether the heading row wraps at the narrow end.
    // jsdom loads no stylesheet and reports every box as 0. Driven in Chrome at
    // 1440 and 900, where "IN ROOM" sits on one line in its 84px column.
    installFetch();
    const view = await renderList();
    const headings = [...(view.container.querySelector("[data-row-header]")?.children ?? [])]
      .map((c) => (c.textContent ?? "").trim());
    const drawn = figuresOf(view.container.querySelector(`[data-history-row="${NINE.serviceKey}"]`)!);
    // One label per line, so two branches renaming different ones conflict
    // instead of merging silently.
    const labels: [what: string, text: string][] = [
      ["the caption under the value", drawn.attendance.caption],
      ["the column heading", headings[2]],
    ];
    assert.deepEqual(
      labels
        .filter(([, text]) => !/in.room/i.test(text))
        .map(([what, text]) => `${what} reads "${text}", which names either attendance figure`),
      [],
    );
    // And the number under those labels is the in-room one — the same figure
    // the service page's header quotes, not the door count beside it.
    const att = ATT.find((a) => a.serviceKey === NINE.serviceKey)!;
    const kpis = new Map(serviceKpis(NINE, att, null).map((k) => [k.key, k]));
    assert.equal(drawn.attendance.value, kpis.get("attendance")!.value, "the row and the page quote different numbers");
    // AND CALL IT THE SAME THING. One number with two names across two pages is
    // the confusion this column was relabelled to end; the service page said
    // "Peak attendance" while the row said "In room". Asserted as a shared word
    // rather than a shared string, because the row has the room for a heading
    // and a caption and the header has one label.
    assert.match(
      kpis.get("attendance")!.label,
      /in.room/i,
      `the service page calls it "${kpis.get("attendance")!.label}" while the row says "${headings[2]} / ${drawn.attendance.caption}"`,
    );
    assert.equal(drawn.attendance.value, att.peakOccupancy.toLocaleString());
    assert.notEqual(drawn.attendance.value, att.peakAttendance.toLocaleString(), "the row is showing the door count");
  });
});
