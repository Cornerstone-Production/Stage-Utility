// The whole History service page: header, then Rundown, Attendance and Sound
// as cards the header's nav anchors into.
//
// Driven through the REAL renderer/lib/api.ts — fetch routed by URL — like the
// other History tests, because what has to hold is what the page composes once
// three separate records have landed, not what a stub of `invoke` returns.
//
// NOT asserted here: jsdom loads no stylesheet, so the cards' surfaces, the
// sticky header and `scroll-mt` (which is the only thing stopping an anchor
// jump from parking a card's heading underneath the header) are invisible to
// it. Those were driven in a real browser.

import { strict as assert } from "node:assert";
import { after, before, beforeEach, describe, test } from "node:test";

import { installDom } from "../../test-dom.js";

const teardown = installDom();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** api.ts opens an SSE stream on first use; nothing here pushes on it. */
class FakeEventSource {
  readyState = 1;
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
};

const DAY = "2026-09-17";
const KEY = "salt:plan-1:evening";
const iso = (hhmmss: string) => new Date(`${DAY}T${hhmmss}`).toISOString();

function timeline() {
  return {
    serviceKey: KEY,
    serviceTypeId: "salt",
    serviceTypeName: "The Salt Company",
    planId: "plan-1",
    planTitle: "Evening",
    seriesTitle: "Kickoff",
    serviceDate: DAY,
    serviceTimeId: "evening",
    serviceTimeStartsAt: iso("20:15:00"),
    startedAt: iso("20:15:00"),
    endedAt: iso("21:45:00"),
    items: [
      { itemId: "a", title: "Welcome", sequence: 0, plannedLengthSec: 300, startedAt: iso("20:17:14"), endedAt: iso("20:22:44"), actualDurationSec: 330, counted: true },
      { itemId: "b", title: "Worship", sequence: 1, plannedLengthSec: 600, startedAt: iso("20:22:44"), endedAt: iso("20:33:44"), actualDurationSec: 660, counted: true },
    ],
  };
}

/** Pre, in-service and post samples, so peak-in-room (1,196), the stored
 *  in-service door count (1,727) and the all-samples door count (2,061) are
 *  three different numbers — see the cross-check below. */
function attendance() {
  return {
    serviceKey: KEY,
    serviceTypeId: "salt",
    serviceDate: DAY,
    planTitle: "Evening",
    startedAt: iso("19:15:00"),
    endedAt: iso("21:45:00"),
    peakAttendance: 1727,
    peakOccupancy: 1196,
    minOccupancy: 933,
    samples: [
      { t: iso("19:30:00"), attendance: 0, occupancy: 410, phase: "pre" },
      { t: iso("20:20:00"), attendance: 1187, occupancy: 1150 },
      { t: iso("20:40:00"), attendance: 1727, occupancy: 1196 },
      { t: iso("21:20:00"), attendance: 1727, occupancy: 933 },
      { t: iso("21:50:00"), attendance: 2061, occupancy: 210, phase: "post" },
    ],
  };
}

function spl() {
  return {
    serviceKey: KEY,
    serviceDate: DAY,
    metricKey: null,
    meterId: "m1",
    items: [
      { itemId: "a", title: "Welcome", sequence: 0, metrics: { "SPL LAeq": { max: 94.2, avg: 88, leq: 89, count: 40 } }, maxSpl: 94.2, sampleCount: 40, startedAt: iso("20:17:14"), endedAt: iso("20:22:44") },
      { itemId: "b", title: "Worship", sequence: 1, metrics: { "SPL LAeq": { max: 101.6, avg: 96, leq: 97, count: 80 } }, maxSpl: 101.6, sampleCount: 80, startedAt: iso("20:22:44"), endedAt: iso("20:33:44") },
    ],
  };
}

function installFetch() {
  (globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    if (method !== "GET") return ok({ ok: true });
    if (url === "/api/service-timeline") return ok([timeline()]);
    if (url === "/api/attendance/history") return ok([attendance()]);
    if (url === "/api/spl/summary") return ok([]);
    if (url === "/api/spl/trend") return ok({ shown: false, metric: null });
    if (url === "/api/spl/visible-metrics") return ok({ metrics: [] });
    if (url === "/api/baptism/sessions") return ok([]);
    if (/\/series\?/.test(url)) return ok({ metric: "SPL LAeq", bucketSec: 5, buckets: [] });
    if (/^\/api\/service-timeline\/[^/]+$/.test(url)) return ok(timeline());
    if (/^\/api\/attendance\/history\/[^/]+$/.test(url)) return ok(attendance());
    if (/^\/api\/spl\/history\/[^/]+$/.test(url)) return ok(spl());
    throw new Error(`unexpected fetch: ${method} ${url}`);
  };
}

const { render, cleanup, fireEvent } = await import("@testing-library/react");
const React = (await import("react")).default;
const { TooltipProvider, ConfirmHost } = await import("../../components/ui/index.js");

after(() => {
  cleanup();
  teardown();
});

const settle = () => new Promise((r) => setTimeout(r, 0));
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

async function openTheService(Section: React.ComponentType) {
  const view = render(
    React.createElement(TooltipProvider, null, React.createElement(Section), React.createElement(ConfirmHost)),
  );
  await settle();
  await settle();
  const row = [...view.container.querySelectorAll("button")].find((b) => text(b).includes("Evening"));
  assert.ok(row, "the service row never rendered");
  fireEvent.click(row!);
  await settle();
  await settle();
  await settle();
  return view;
}

describe("the History service page", () => {
  let ServiceHistorySection: typeof import("./service-history-section.js").ServiceHistorySection;

  before(async () => {
    ({ ServiceHistorySection } = await import("./service-history-section.js"));
  });

  beforeEach(() => cleanup());

  test("composes a header and three cards, in the nav's order", async (t) => {
    installFetch();
    const view = await openTheService(ServiceHistorySection);
    t.after(() => cleanup());

    assert.ok(view.container.querySelector('[data-testid="history-service-header"]'), "no header");

    // The anchors and the cards are matched by walking the DOM in order, so a
    // card renamed on one side alone fails here rather than 404-ing silently on
    // a click nobody tests.
    const navTargets = [...view.container.querySelectorAll('[data-testid="history-service-header"] nav a')]
      .map((a) => (a as HTMLAnchorElement).getAttribute("href")!.slice(1));
    const cardIds = [...view.container.querySelectorAll("section[id]")].map((s) => s.id);
    assert.deepEqual(navTargets, ["history-rundown", "history-attendance", "history-sound"]);
    assert.deepEqual(cardIds, navTargets, "every nav link must land on a card that exists, in page order");

    for (const id of navTargets) {
      const card = view.container.querySelector<HTMLElement>(`#${id}`)!;
      assert.match(card.className, /su-card/, `${id} must be a card`);
      // The header's own MEASURED height, not a fixed guess. A fixed
      // `scroll-mt-40` shipped here first and was 24px short at 1280 and 43px
      // short at 600 in a real browser, so every anchor jump parked the card's
      // heading behind the header. jsdom reports every height as 0 and cannot
      // catch that; what it CAN catch is the margin going back to a constant.
      assert.match(
        card.style.scrollMarginTop,
        /var\(--su-history-header-h/,
        `${id} must clear the sticky header by the header's own height when jumped to`,
      );
    }
  });

  test("no figure the header shows is repeated anywhere else on the page", async (t) => {
    installFetch();
    const view = await openTheService(ServiceHistorySection);
    t.after(() => cleanup());

    // The four the tile grid above the rundown used to carry. They are the
    // whole reason this guard exists: the tiles and the header KPIs were the
    // same four numbers, and leaving both in place put each on screen twice.
    //
    // Peak attendance and Peak <metric> are NOT in this list on purpose — the
    // attendance and sound strips show their own, by design, and the header
    // summarises them.
    const kpiRow = view.container.querySelector('[data-testid="service-kpis"]')!;
    const rundownHeader = view.container.querySelector('[data-testid="rundown-header"]')!;
    for (const label of ["Started", "Planned", "Actual", "Avg overrun"]) {
      // Every element on the page whose OWN text is exactly the label, minus
      // the rundown table's column heading of the same word. A re-added tile
      // grid, or a second strip figure, lands here as a second hit.
      const hits = [...view.container.querySelectorAll("*")].filter(
        (el) => text(el) === label && el.children.length === 0 && !rundownHeader.contains(el),
      );
      assert.equal(hits.length, 1, `"${label}" appears ${hits.length} times outside the rundown header; it belongs in the KPI row alone`);
      assert.ok(kpiRow.contains(hits[0]), `"${label}" must be in the header's KPI row`);
    }
  });

  test("the header and the Attendance card agree about which number is which", async (t) => {
    installFetch();
    // Entries is off by default in the Attendance card — the one figure this
    // test has to read off BOTH surfaces, so it is turned on the way an
    // operator turns it on, through the card's own preference entry.
    localStorage.setItem(
      "attendance:visibleMetrics",
      JSON.stringify(["occupancy", "avg", "markers", "peak", "lowest", "average", "samples", "entries"]),
    );
    t.after(() => localStorage.removeItem("attendance:visibleMetrics"));
    const view = await openTheService(ServiceHistorySection);
    t.after(() => cleanup());

    // THE cross-check. Both surfaces quote peak-in-room and the cumulative door
    // count, and they had them swapped: the header said "Peak attendance 2,061 /
    // 1,196 in room" above a card saying "PEAK 1,196 / ENTRIES 2,061". Asserting
    // a literal on one side alone would not have caught it — the literal was
    // right for whichever side the author was looking at. This reads both.
    const figures = (root: Element) =>
      new Map(
        [...root.querySelectorAll("[data-history-strip] > div")].map((d) => [
          (d.children[0]?.textContent ?? "").trim().toLowerCase(),
          (d.children[1]?.textContent ?? "").trim(),
        ]),
      );
    const header = figures(view.container.querySelector('[data-testid="service-kpis"]')!);
    const card = figures(view.container.querySelector("#history-attendance")!);

    assert.equal(card.get("peak"), "1,196", "the Attendance card's own peak (fixture check)");
    assert.equal(card.get("entries"), "2,061", "the Attendance card's own entries (fixture check)");
    assert.equal(
      header.get("peak attendance"),
      card.get("peak"),
      "the header's Peak attendance must be the same number the card calls Peak",
    );
    const headerSub = new Map(
      [...view.container.querySelectorAll('[data-testid="service-kpis"] [data-history-strip] > div')].map((d) => [
        (d.children[0]?.textContent ?? "").trim().toLowerCase(),
        (d.children[2]?.textContent ?? "").trim(),
      ]),
    );
    assert.equal(
      headerSub.get("peak attendance"),
      `${card.get("entries")} entries`,
      `the header's entries line must be the card's Entries figure; header subs were ${JSON.stringify([...headerSub])}`,
    );
  });

  test("the header's actions are reachable in order, and the nav links are real anchors", async (t) => {
    installFetch();
    const view = await openTheService(ServiceHistorySection);
    t.after(() => cleanup());

    // Nothing here is taken out of the tab order or given a positive tabIndex —
    // an action group reached by keyboard in a different order than it reads is
    // worse than one that is not reachable at all.
    const actions = [...view.container.querySelectorAll('[data-testid="history-actions"] button')];
    assert.deepEqual(actions.map((b) => text(b)), ["Edit times", "Copy report", "Rebuild from raw", "Delete"]);
    for (const b of actions) {
      assert.equal(b.getAttribute("tabindex"), null, `${text(b)} must keep the document's own tab order`);
      assert.equal((b as HTMLButtonElement).disabled, false);
    }

    // Anchors, not buttons with a scroll handler: they work with the keyboard,
    // with middle-click, and with JavaScript still parsing.
    const links = [...view.container.querySelectorAll('[data-testid="history-service-header"] nav a')];
    assert.equal(links.length, 3);
    for (const a of links) assert.match((a as HTMLAnchorElement).getAttribute("href") ?? "", /^#history-/);
  });
});
