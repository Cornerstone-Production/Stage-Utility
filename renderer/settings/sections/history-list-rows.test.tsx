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
    // Neither service recorded sound. `servicePeakLevel(null)` is "no-record",
    // which the row prints as "—" — and which the service page prints too.
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
      const kpis = new Map(serviceKpis(record, att, null).map((k) => [k.key, k]));
      const drawn = figuresOf(rows[i]);
      // The identity, figure by figure: each drawn value is the header's own.
      assert.equal(drawn["Peak attendance"], kpis.get("attendance")!.value, "Peak attendance must be the header's");
      assert.equal(drawn["Ran"], kpis.get("actual")!.value, "Ran must be the header's Actual");
      assert.equal(drawn["Peak level"], kpis.get("level")!.value, "the peak level must be the header's");
      // And the row's own extra: versus plan, which the header carries as a
      // sub-line of Actual.
      const vsPlan = serviceRowFigures(record, att, null).figures.find((f) => f.key === "vs-plan");
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
