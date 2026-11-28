// A live push that lands while History's list read is still out is not lost.
//
// History and Home each kept their own copy of "read the list, then upsert the
// pushes", and both copies lost a push that raced a read. A timeline push that
// arrived before the first answer was dropped outright (`if (!prev) return
// prev`), so a service that started while the page was loading had no row until
// a reload; and an attendance push that arrived while the read was out was
// overwritten by that read's older answer. Both now share useHistoryLists,
// which keeps such a push aside and lays it over the answer.
//
// Driven through the real ServiceHistorySection with a fetch held open by hand
// and a fake EventSource pushed on directly, as history-list-live-pushes.test.tsx
// does. NOT ASSERTED HERE: layout, colour, the stylesheet. jsdom loads none of it.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { eventually, installDom, settle, unmountAndTeardown } from "../../test-dom.js";
import { FakeEventSource } from "../../test-fixtures/fake-event-source.js";

const teardown = installDom();

(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
};

const DAY = "2026-10-18";
const iso = (hhmmss: string) => new Date(`${DAY}T${hhmmss}`).toISOString();

function timeline(key: string, at: string): ServiceTimeline {
  return {
    serviceKey: key,
    serviceTypeId: "st1",
    serviceTypeName: "Weekend",
    planId: "plan-1",
    planTitle: key,
    seriesTitle: null,
    serviceDate: DAY,
    serviceTimeId: key,
    serviceTimeStartsAt: iso(at),
    startedAt: iso(at),
    endedAt: null,
    items: [
      { itemId: "a", title: "Doors", sequence: 0, plannedLengthSec: 300, startedAt: iso(at), endedAt: null, actualDurationSec: null, counted: true },
    ],
  } as unknown as ServiceTimeline;
}

/** An attendance-only record: the arrival ramp, before any item went live. It
 *  is a row of its own ("arriving"), so whether it survived is visible on the
 *  list. */
function arriving(key: string): ServiceAttendance {
  return {
    serviceKey: key,
    serviceTypeId: "st1",
    serviceTypeName: "Weekend",
    planId: "plan-2",
    planTitle: key,
    seriesTitle: null,
    serviceDate: DAY,
    serviceTimeId: key,
    serviceTimeStartsAt: iso("11:00:00"),
    startedAt: iso("10:05:00"),
    endedAt: null,
    samples: [{ t: iso("10:05:00"), attendance: 0, occupancy: 40, phase: "pre" }],
    attendanceBaseline: 0,
    totalAttendance: 0,
    peakAttendance: 0,
    peakOccupancy: 0,
    minOccupancy: null,
    lastAttendance: 0,
    lastOccupancy: 0,
  } as unknown as ServiceAttendance;
}

type Held = "timeline" | "attendance";
/** A fetch whose list reads answer only when released, with what they knew
 *  when they were SENT. */
function installFetch(answers: { timeline: ServiceTimeline[]; attendance: ServiceAttendance[] }): Record<Held, () => void> {
  const gates = new Map<Held, () => void>();
  const held = (which: Held) => new Promise<void>((resolve) => gates.set(which, resolve));
  const ok = (b: unknown) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });
  (globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown) => {
    const url = String(input);
    if (url === "/api/service-timeline") return held("timeline").then(() => ok(answers.timeline));
    if (url === "/api/attendance/history?summary=1") return held("attendance").then(() => ok(answers.attendance));
    if (url === "/api/spl/summary") return ok([]);
    if (url === "/api/baptism/sessions") return ok([]);
    if (url.startsWith("/api/baptism/lane")) return ok({ spans: [] });
    return ok(null);
  };
  const release = (which: Held) => () => {
    const go = gates.get(which);
    assert.ok(go, `the ${which} read was never sent`);
    go();
  };
  return { timeline: release("timeline"), attendance: release("attendance") };
}

const { render, cleanup, act } = await import("@testing-library/react");
const React = (await import("react")).default;
const { TooltipProvider } = await import("../../components/ui/index.js");
const { ServiceHistorySection } = await import("./service-history-section.js");
const { __resetReplayCacheForTests } = await import("../../lib/api.js");

afterEach(() => {
  cleanup();
  __resetReplayCacheForTests();
});
after(() => unmountAndTeardown(cleanup, teardown));

async function renderPage(): Promise<ReturnType<typeof render>> {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(ServiceHistorySection as React.ComponentType<{ readOnly: boolean }>, { readOnly: false }),
      ),
    );
    await new Promise((r) => setTimeout(r, 0));
  });
  return view;
}

const rowKeys = (view: ReturnType<typeof render>) =>
  [...view.container.querySelectorAll("[data-history-row]")].map((r) => r.getAttribute("data-history-row")).sort();

describe("a live push that races History's list read", () => {
  test("a timeline pushed before the first answer still gets its row", async () => {
    const release = installFetch({ timeline: [timeline("st1:p:9am", "09:00:00")], attendance: [] });
    const view = await renderPage();
    release.attendance();

    // A service goes live while the page is still waiting on the list.
    act(() => { FakeEventSource.last!.push("service-timeline:history", timeline("st1:p:11am", "11:00:00")); });
    await settle();
    release.timeline();
    await settle();

    await eventually(() => assert.deepEqual(rowKeys(view), ["st1:p:11am", "st1:p:9am"], `rows: ${rowKeys(view).join(", ")}`));
  });

  test("an attendance push is not overwritten by the older answer of a read already out", async () => {
    const release = installFetch({ timeline: [timeline("st1:p:9am", "09:00:00")], attendance: [] });
    const view = await renderPage();
    release.timeline();
    await settle();

    // The arrival ramp opens a record after the attendance read was sent, and
    // before it answered. The answer knows nothing of it.
    act(() => { FakeEventSource.last!.push("attendance:history", arriving("st1:p2:11am")); });
    await settle();
    release.attendance();
    await settle();

    // An arriving row is drawn without data-history-row, so it is found by its
    // title (the fixture's planTitle is the key) and its caption.
    await eventually(() => {
      const text = view.container.textContent ?? "";
      assert.ok(text.includes("st1:p2:11am") && text.includes("arriving"), "the arriving row is gone");
    });
  });
});
