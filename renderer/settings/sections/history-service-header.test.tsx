// The History service page's sticky header.
//
// NOT asserted here, deliberately: jsdom loads no stylesheet and lays nothing
// out, so `position: sticky`, the horizontal KPI scroller a phone gets, the
// hairline that separates Delete, and the pill's pulse are all invisible to it
// — every offsetWidth is 0 and no class has any effect. Those were driven in a
// real browser at 1280 and 600 wide, in light and dark. What is asserted here
// is the derivation, the pill's CONDITION, which action is styled destructive,
// and that the nav follows what the observer reports.
//
// The observer is stubbed rather than faked-out: jsdom ships no
// IntersectionObserver at all, so without a stub the hook's whole body is
// skipped and a test of the highlight would assert nothing.

import { strict as assert } from "node:assert";
import { after, beforeEach, describe, test } from "node:test";

import { installDom } from "../../test-dom.js";

const teardown = installDom();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The one stubbed IntersectionObserver, handing the test its callback. */
class StubObserver {
  static last: StubObserver | null = null;
  readonly observed: Element[] = [];
  constructor(readonly cb: (entries: { target: { id: string }; isIntersecting: boolean; intersectionRatio: number }[]) => void) {
    StubObserver.last = this;
  }
  observe(el: Element): void {
    this.observed.push(el);
  }
  disconnect(): void {}
  unobserve(): void {}
}
(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = StubObserver;

const DAY = "2026-09-17";
const iso = (hhmmss: string) => new Date(`${DAY}T${hhmmss}`).toISOString();

/** Scheduled 20:15; the first counted item went live at 20:17:14 — 2:14 late.
 *  Three counted items, two of which ran over. */
function timeline(overrides: Partial<ServiceTimeline> = {}): ServiceTimeline {
  return {
    serviceKey: "salt:plan-1:2026-09-17",
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
      // 2:14 late, 30s over its 5:00 plan.
      { itemId: "a", title: "Welcome", sequence: 0, plannedLengthSec: 300, startedAt: iso("20:17:14"), endedAt: iso("20:22:44"), actualDurationSec: 330, counted: true },
      // 60s over its 10:00 plan.
      { itemId: "b", title: "Worship", sequence: 1, plannedLengthSec: 600, startedAt: iso("20:22:44"), endedAt: iso("20:33:44"), actualDurationSec: 660, counted: true },
      // 30s UNDER its 30:00 plan, so the mean is (+30 +60 −30)/3 = +20.
      { itemId: "c", title: "Message", sequence: 2, plannedLengthSec: 1800, startedAt: iso("20:33:44"), endedAt: iso("21:03:14"), actualDurationSec: 1770, counted: true },
    ] as unknown as ServiceTimelineItem[],
    ...overrides,
  } as ServiceTimeline;
}

function attendance(): ServiceAttendance {
  return {
    serviceKey: "salt:plan-1:2026-09-17",
    serviceDate: DAY,
    peakAttendance: 0,
    peakOccupancy: 1196,
    samples: [
      { t: iso("20:15:00"), attendance: 100, occupancy: 100 },
      { t: iso("20:40:00"), attendance: 1396, occupancy: 1196 },
    ],
  } as unknown as ServiceAttendance;
}

function spl(): ServiceSplHistory {
  return {
    serviceKey: "salt:plan-1:2026-09-17",
    serviceDate: DAY,
    metricKey: null,
    items: [
      { itemId: "a", title: "Welcome", sequence: 0, metrics: { "SPL LAeq": { max: 94.2, avg: 88, leq: 89, count: 40 } }, maxSpl: 94.2, sampleCount: 40, startedAt: iso("20:17:14"), endedAt: iso("20:22:44") },
      { itemId: "b", title: "Worship", sequence: 1, metrics: { "SPL LAeq": { max: 101.6, avg: 96, leq: 97, count: 80 } }, maxSpl: 101.6, sampleCount: 80, startedAt: iso("20:22:44"), endedAt: iso("20:33:44") },
    ],
  } as unknown as ServiceSplHistory;
}

const { render, cleanup, act } = await import("@testing-library/react");
const React = (await import("react")).default;
const { TooltipProvider } = await import("../../components/ui/index.js");
const { ServiceHeader, serviceKpis } = await import("./history-service-header.js");
type ServiceHeaderProps = import("./history-service-header.js").ServiceHeaderProps;

after(() => {
  cleanup();
  teardown();
});

const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

function noop() {}

function mount(props: Partial<ServiceHeaderProps> = {}) {
  return render(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(ServiceHeader, {
        timeline: timeline(),
        attendance: attendance(),
        spl: spl(),
        meta: "Kickoff · The Salt Company · Thu, Sep 17, 2026 · 8:15 PM",
        readOnly: false,
        onBack: noop,
        onEditTimes: noop,
        onCopyReport: noop,
        onMerge: noop,
        onRebuild: noop,
        onDelete: noop,
        onResetPacing: noop,
        ...props,
      }),
      // The three sections the nav observes. Real elements, because the hook
      // looks them up by id — without them nothing is ever observed.
      React.createElement("div", { id: "history-rundown" }),
      React.createElement("div", { id: "history-attendance" }),
      React.createElement("div", { id: "history-sound" }),
    ),
  );
}

describe("History service header", () => {
  beforeEach(() => {
    cleanup();
    StubObserver.last = null;
  });

  test("the six KPIs read off the record, signs and counts included", () => {
    const kpis = serviceKpis(timeline(), attendance(), spl());
    assert.deepEqual(
      kpis.map((k) => k.label),
      ["Started", "Planned", "Actual", "Avg overrun", "Peak attendance", "Peak SPL LAeq"],
      "the header's six figures, in order",
    );
    const by = (key: string) => kpis.find((k) => k.key === key)!;

    // 20:17:14 against a 20:15 scheduled start.
    assert.equal(by("started").sub, "+2:14 late", "a late start says late, with a + sign");
    // 300 + 600 + 1800 = 2700s planned; 330 + 660 + 1770 = 2760s actual.
    assert.equal(by("planned").value, "45:00");
    assert.equal(by("actual").value, "46:00");
    assert.match(by("actual").sub ?? "", /^\+1:00 vs plan/);
    // (+30 +60 −30) / 3 = +20s, two of three over.
    assert.equal(by("overrun").value, "+0:20");
    assert.equal(by("overrun").sub, "2 of 3 over", "the over COUNT, not the total");
    // 1396 peak − 100 first sample.
    assert.equal(by("attendance").value, "1,296");
    assert.equal(by("attendance").sub, "1,196 in room");
    assert.equal(by("level").value, "102 dB", "the loudest item on the primary metric");
  });

  test("an early start says early", () => {
    const early = timeline();
    early.items[0].startedAt = iso("20:14:30");
    const started = serviceKpis(early, null, null).find((k) => k.key === "started")!;
    assert.equal(started.sub, "−0:30 early", "an early start must not read as late");
  });

  test("a record with no attendance or sound shows a dash, not a zero", () => {
    const kpis = serviceKpis(timeline(), null, null);
    assert.equal(kpis.find((k) => k.key === "attendance")!.value, "—");
    assert.equal(kpis.find((k) => k.key === "level")!.value, "—");
  });

  test("the recording pill is there only while the record is open", () => {
    const open = mount({ timeline: timeline({ endedAt: null }) });
    assert.ok(
      open.container.querySelector('[data-testid="recording-pill"]'),
      "an open record must say it is recording",
    );
    assert.match(text(open.container.querySelector('[data-testid="recording-pill"]')), /recording/);
    cleanup();

    const closed = mount({});
    // `!= null`, not the node itself: node:test renders the actual value into
    // its diff, and handing it a jsdom element walks the whole DOM graph until
    // the runner is SIGKILLed — a red guard that reports nothing at all.
    assert.equal(
      closed.container.querySelector('[data-testid="recording-pill"]') != null,
      false,
      "a finished record must NOT claim to be recording",
    );
  });

  test("Delete is the one destructive action in the group", () => {
    const view = mount({});
    const group = view.container.querySelector('[data-testid="history-actions"]')!;
    const buttons = [...group.querySelectorAll("button")];
    assert.deepEqual(
      buttons.map((b) => text(b)),
      ["Edit times", "Copy report", "Merge…", "Rebuild from raw", "Delete"],
      "one group, in reach order, Delete last",
    );
    // The CLASSES, from the rendered DOM — not a data attribute a comment could
    // satisfy. The button AND everything in it, because "destructive-styled" is
    // as true of a red trash icon as of a red button, and the first version of
    // this check read `button.className` alone and stayed green when Merge's
    // icon was painted danger. Exactly one, so a second red action goes red here.
    const destructive = buttons.filter((b) =>
      [b, ...b.querySelectorAll("*")].some((el) => /danger/.test(el.getAttribute("class") ?? "")),
    );
    assert.equal(destructive.length, 1, `exactly one destructive action, got ${destructive.map((b) => text(b)).join(", ") || "none"}`);
    assert.equal(text(destructive[0]), "Delete");
  });

  test("a read-only page offers only Copy report", () => {
    const view = mount({ readOnly: true });
    const group = view.container.querySelector('[data-testid="history-actions"]')!;
    assert.deepEqual([...group.querySelectorAll("button")].map((b) => text(b)), ["Copy report"]);
  });

  test("the nav highlights the section the observer reports", () => {
    const view = mount({});
    const link = (label: string) =>
      [...view.container.querySelectorAll("nav a")].find((a) => text(a) === label) as HTMLAnchorElement;

    // Real anchors, so they work with the keyboard and with JavaScript busy.
    assert.deepEqual(
      [...view.container.querySelectorAll("nav a")].map((a) => (a as HTMLAnchorElement).getAttribute("href")),
      ["#history-rundown", "#history-attendance", "#history-sound"],
    );
    assert.equal(link("Rundown").getAttribute("aria-current"), "true", "the first section leads");

    const obs = StubObserver.last;
    assert.ok(obs, "the hook never constructed an observer");
    assert.equal(obs!.observed.length, 3, "all three sections must be observed");

    act(() => {
      obs!.cb([
        { target: { id: "history-rundown" }, isIntersecting: false, intersectionRatio: 0 },
        { target: { id: "history-attendance" }, isIntersecting: true, intersectionRatio: 0.2 },
        { target: { id: "history-sound" }, isIntersecting: true, intersectionRatio: 0.9 },
      ]);
    });

    assert.equal(link("Sound").getAttribute("aria-current"), "true", "the most-visible section wins");
    assert.equal(link("Rundown").getAttribute("aria-current"), null);
    assert.equal(link("Attendance").getAttribute("aria-current"), null, "only one section is current");
  });
});
