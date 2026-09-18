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

/**
 * The 17 Sep Salt Company recording's shape, scaled down: a pre-service ramp, a
 * service, and a post-service taper, with the door count still climbing through
 * all three.
 *
 * The three phases are the whole point. With in-service samples only, every
 * derivation of "peak attendance" agrees and the fixture proves nothing. Here
 * they diverge exactly as the real record does:
 *
 *   peakOccupancy (stored, in-service)     1,196  ← people in the room
 *   peakAttendance (stored, in-service)    1,727
 *   servicePeakAttendance (all samples)    2,061  ← cumulative door count
 *
 * The header showed 2,061 as "Peak attendance" with "1,196 in room" under it,
 * while the Attendance card below it showed 1,196 as PEAK and 2,061 as ENTRIES.
 */
function attendance(): ServiceAttendance {
  return {
    serviceKey: "salt:plan-1:2026-09-17",
    serviceDate: DAY,
    peakAttendance: 1727,
    peakOccupancy: 1196,
    minOccupancy: 933,
    samples: [
      { t: iso("19:30:00"), attendance: 0, occupancy: 410, phase: "pre" },
      { t: iso("20:10:00"), attendance: 900, occupancy: 1100, phase: "pre" },
      { t: iso("20:20:00"), attendance: 1187, occupancy: 1150 },
      { t: iso("20:40:00"), attendance: 1727, occupancy: 1196 },
      { t: iso("21:20:00"), attendance: 1727, occupancy: 933 },
      { t: iso("21:50:00"), attendance: 2061, occupancy: 210, phase: "post" },
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
const { SPL_METRICS_STORAGE_KEY } = await import("./spl-history-section.js");
const { useStoredKeys } = await import("./history-chart/index.js");
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
    // ATTENDANCE IS PEOPLE IN THE ROOM. The door count is Entries, and it is
    // the bigger of the two on every real record — which is how the inversion
    // survived: 2,061 looked like a plausible "peak attendance".
    assert.equal(by("attendance").value, "1,196", "peak attendance is peak people IN THE ROOM");
    assert.equal(by("attendance").sub, "2,061 entries", "the cumulative door count, named as entries");
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

  test("an absent level says WHICH kind of absent it is", () => {
    const level = (rec: ServiceSplHistory | null) => serviceKpis(timeline(), null, rec).find((k) => k.key === "level")!;

    // Nothing recorded.
    assert.equal(level(null).sub, "no sound recorded");

    // A record that carries metrics, with every one of them unticked. This is
    // the case the single note got wrong: the service recorded plenty and was
    // told it had recorded nothing, sending whoever read it to the meter.
    localStorage.setItem(SPL_METRICS_STORAGE_KEY, JSON.stringify([]));
    const hidden = level(spl());
    assert.equal(hidden.value, "—");
    assert.equal(hidden.sub, "metric hidden in Sound", "an unticked metric is not an unrecorded one");
    localStorage.removeItem(SPL_METRICS_STORAGE_KEY);

    // A record whose items carry no metric block at all.
    const bare = spl();
    (bare.items as unknown as { metrics?: unknown }[]).forEach((it) => delete it.metrics);
    assert.equal(level({ ...bare, metricKey: null } as ServiceSplHistory).sub, "no metrics recorded");
  });

  test("the header follows the Sound card's metric choice", () => {
    // `servicePeakLevel` reads localStorage, which React cannot see. The memo
    // held on its other dependencies, so switching metric in the Sound card's
    // Customize relabelled that card and left the header quoting the old one.
    const twoMetrics = spl();
    for (const it of twoMetrics.items as unknown as { metrics: Record<string, unknown> }[]) {
      it.metrics["LCeq"] = { max: 108.4, avg: 99, leq: 100, count: 60 };
    }
    localStorage.setItem(SPL_METRICS_STORAGE_KEY, JSON.stringify(["SPL LAeq"]));

    // Stands in for the Sound card, which owns this preference. It uses the
    // SAME hook the real Customize popover is wired to, so the change travels
    // the real write-and-announce path rather than a test-only back door.
    let toggle: ((key: string) => Error | null) | null = null;
    function SoundCardStandIn() {
      const [, t] = useStoredKeys(SPL_METRICS_STORAGE_KEY, null, []);
      toggle = t;
      return null;
    }
    const view = render(
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(ServiceHeader, {
          timeline: timeline(),
          attendance: attendance(),
          spl: twoMetrics,
          meta: "",
          onBack: noop, onEditTimes: noop, onCopyReport: noop, onMerge: noop,
          onRebuild: noop, onDelete: noop, onResetPacing: noop,
        }),
        React.createElement(SoundCardStandIn),
      ),
    );
    const label = () =>
      [...view.container.querySelectorAll('[data-testid="service-kpis"] [data-history-strip] > div')]
        .map((d) => (d.children[0]?.textContent ?? "").trim())
        .find((l) => l.startsWith("Peak ") && l !== "Peak attendance");
    assert.equal(label(), "Peak SPL LAeq");

    // Two acts, not two calls in one: `toggle` closes over the key list from
    // the render it came from, so a second call inside the same act writes from
    // the pre-toggle list and undoes the first — which is also true of two fast
    // clicks in the real popover, and is the hook's behaviour, not this test's.
    act(() => void toggle!("SPL LAeq")); // untick it, as a click in Customize does
    act(() => void toggle!("LCeq")); // and tick the other
    assert.equal(label(), "Peak LCeq", "the header must follow the metric the Sound card is showing");
    localStorage.removeItem(SPL_METRICS_STORAGE_KEY);
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

  test("every KPI's second line actually renders", () => {
    // `serviceKpis` returning a `sub` is not the same as the strip DRAWING it.
    // Deleting the sub line from Figure, or dropping `sub` on the way through
    // StatStrip, left every other guard in this file green: they all read the
    // derivation, not the DOM.
    const view = mount();
    const row = view.container.querySelector('[data-testid="service-kpis"]')!;
    const shown = text(row);
    for (const line of ["+2:14 late", "2 of 3 over", "2,061 entries", "ends 21:02", "+1:00 vs plan"]) {
      assert.ok(shown.includes(line), `the KPI row must show "${line}"; it showed: ${shown}`);
    }
    // And each one is under its OWN figure, not concatenated somewhere else.
    const subs = new Map(
      [...row.querySelectorAll("[data-history-strip] > div")].map((d) => [
        (d.children[0]?.textContent ?? "").trim(),
        (d.children[2]?.textContent ?? "").trim(),
      ]),
    );
    assert.equal(subs.get("Started"), "+2:14 late");
    assert.equal(subs.get("Avg overrun"), "2 of 3 over");
    assert.equal(subs.get("Peak attendance"), "2,061 entries");
  });

  test("the header publishes its height while mounted, and takes it back", () => {
    // The mechanism the cards' scroll-margin and the scroller's scroll-padding
    // both read. Deleting the setProperty call left the whole suite green: the
    // card guard asserts the margin REFERENCES the variable, and a variable
    // nobody writes still parses. jsdom reports 0 for every height, so this
    // asserts the property is SET, not what it is set to.
    const root = document.documentElement;
    root.style.removeProperty("--su-history-header-inset");
    assert.equal(root.style.getPropertyValue("--su-history-header-inset"), "", "not set before mounting");

    const view = mount();
    assert.notEqual(
      root.style.getPropertyValue("--su-history-header-inset"),
      "",
      "the header must publish its height, or every anchor jump lands under it",
    );

    view.unmount();
    assert.equal(
      root.style.getPropertyValue("--su-history-header-inset"),
      "",
      "a stale height would push the NEXT page's anchors down by a header that is gone",
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
