// The plotted Sound metric, through the whole History page: the All services
// row, the service header's peak figure, the Sound card's title and its strip
// all name ONE metric, and a Plot choice moves all four.
//
// The page resolves the Trends metric and subscribes to this browser's choice
// once (`usePlotPrefs`), then hands that value to each of the four. A unit test
// of any one of them cannot see a call site that hands it something else, so this
// drives the real page: the organisation's Trends metric is LCeq 2, which is NOT
// the default (LAeq 2 would be), so a figure handed no preferences falls back to
// LAeq 2 and disagrees with the rest.
//
// NOT asserted here: where the title's metric sits beside "Sound" and how it
// wraps on a narrow screen. jsdom loads no stylesheet; driven in a browser.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { eventually, installDom, settle, unmountAndTeardown } from "../../test-dom.js";
import { FakeEventSource } from "../../test-fixtures/fake-event-source.js";

const teardown = installDom();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
};

const DAY = "2026-09-17";
const KEY = "gathering:plan-1:evening";
const iso = (hhmmss: string) => new Date(`${DAY}T${hhmmss}`).toISOString();

function timeline() {
  return {
    serviceKey: KEY,
    serviceTypeId: "gathering",
    serviceTypeName: "Main Room",
    planId: "plan-1",
    planTitle: "Evening",
    seriesTitle: null,
    serviceDate: DAY,
    serviceTimeId: "evening",
    serviceTimeStartsAt: iso("20:15:00"),
    startedAt: iso("20:15:00"),
    endedAt: iso("21:45:00"),
    items: [
      { itemId: "a", title: "Welcome", sequence: 0, plannedLengthSec: 300, startedAt: iso("20:17:00"), endedAt: iso("20:22:00"), actualDurationSec: 300, counted: true },
      { itemId: "b", title: "Worship", sequence: 1, plannedLengthSec: 600, startedAt: iso("20:22:00"), endedAt: iso("20:32:00"), actualDurationSec: 600, counted: true },
    ],
  };
}

function attendance() {
  return {
    serviceKey: KEY,
    serviceTypeId: "gathering",
    serviceDate: DAY,
    planTitle: "Evening",
    startedAt: iso("19:45:00"),
    endedAt: iso("21:45:00"),
    peakAttendance: 300,
    peakOccupancy: 250,
    minOccupancy: 10,
    samples: [
      { t: iso("20:20:00"), attendance: 200, occupancy: 190 },
      { t: iso("20:40:00"), attendance: 300, occupancy: 250 },
    ],
  };
}

/** Both metrics on every item, with peaks far enough apart that a figure on the
 *  wrong one is a different number as well as a different name. */
function spl() {
  const stat = (max: number) => ({ max, avg: max - 6, leq: max - 5, count: 60 });
  return {
    serviceKey: KEY,
    serviceDate: DAY,
    metricKey: null,
    meterId: "m1",
    startedAt: iso("20:15:00"),
    endedAt: iso("21:45:00"),
    items: [
      { itemId: "a", title: "Welcome", sequence: 0, metrics: { "LAeq 2": stat(88.2), "LCeq 2": stat(99.1) }, maxSpl: 88.2, sampleCount: 60, startedAt: iso("20:17:00"), endedAt: iso("20:22:00") },
      { itemId: "b", title: "Worship", sequence: 1, metrics: { "LAeq 2": stat(94.4), "LCeq 2": stat(106.3) }, maxSpl: 94.4, sampleCount: 60, startedAt: iso("20:22:00"), endedAt: iso("20:32:00") },
    ],
  };
}

/** The page's SPL summary: what the Trends metric is resolved against. */
function splSummary() {
  return [{ ...timeline(), items: undefined, metrics: { "LAeq 2": { max: 94.4, leq: 89, count: 120 }, "LCeq 2": { max: 106.3, leq: 101, count: 120 } } }];
}

/** Which metric each raw-series read asked for, in order. */
let seriesAsked: string[] = [];

function installFetch(opts: { timelineRecords?: unknown[] } = {}) {
  (globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    if (method !== "GET") return ok({ ok: true });
    if (url === "/api/baptism/sessions") return ok([]);
    if (/^\/api\/baptism\/lane\?/.test(url)) return ok({ spans: [] });
    if (url === "/api/service-timeline") return ok(opts.timelineRecords ?? [timeline()]);
    if (url === "/api/attendance/history?summary=1") return ok([attendance()]);
    if (url === "/api/spl/summary") return ok(splSummary());
    // The organisation's Trends metric: LCeq 2, not the LAeq 2 default.
    if (url === "/api/history/trends-prefs") return ok({ rev: 1, soundMetric: "LCeq 2" });
    if (url === "/api/spl/trend") return ok({ shown: false, metric: null });
    if (url === "/api/spl/visible-metrics") return ok({ metrics: [] });
    if (/\/series\?/.test(url)) {
      const metric = new URL(url, "http://x").searchParams.get("metric") ?? "";
      seriesAsked.push(metric);
      const t0 = Date.parse(iso("20:17:00"));
      return ok({
        metric,
        metrics: ["LAeq 2", "LCeq 2"],
        bucketSec: 60,
        buckets: Array.from({ length: 10 }, (_, i) => ({ t: t0 + i * 60_000, max: 80 + i, avg: 76 + i })),
      });
    }
    if (/^\/api\/service-timeline\/[^/]+$/.test(url)) return ok(opts.timelineRecords?.length === 0 ? null : timeline());
    if (/^\/api\/attendance\/history\/[^/]+$/.test(url)) return ok(attendance());
    if (/^\/api\/spl\/history\/[^/]+$/.test(url)) return ok(spl());
    throw new Error(`unexpected fetch: ${method} ${url}`);
  };
}

const { render, cleanup, fireEvent, screen, within } = await import("@testing-library/react");
const React = (await import("react")).default;
const { TooltipProvider } = await import("../../components/ui/index.js");
const { ServiceHistorySection } = await import("./service-history-section.js");
const { __resetReplayCacheForTests } = await import("../../lib/api.js");

beforeEach(() => {
  localStorage.clear();
  seriesAsked = [];
});
afterEach(() => {
  cleanup();
  __resetReplayCacheForTests();
});
after(() => unmountAndTeardown(cleanup, teardown));

const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

/** The row's peak-level caption: the metric it read. */
const rowMetric = (root: Element) => {
  const figure = root.querySelector(`[data-history-row="${KEY}"] [data-row-figure="level"]`);
  return text(figure?.children[1]);
};
/** The header's peak-level figure label ("Peak LCeq 2"). */
const headerLabel = (root: Element) =>
  [...root.querySelectorAll('[data-testid="service-kpis"] [data-history-strip] > div')]
    .map((d) => text(d.children[0]))
    .find((l) => l.startsWith("Peak ") && l !== "Peak in room");
/** The Sound card title's metric ("· LCeq 2" without the dot). */
const titleMetric = (root: Element) => text(root.querySelector("#history-sound [data-card-title-detail]")).replace(/^·\s*/, "");
/** The Sound card strip's peak figure ("LCeq 2 peak"). */
const stripPeak = (root: Element) =>
  [...root.querySelectorAll("#history-sound [data-history-strip] > div")]
    .map((d) => text(d.children[0]))
    .find((l) => / peak$/.test(l));

/** Everything that names the plotted metric, at once, so a failure shows all four. */
function named(root: Element, onService: boolean) {
  return onService
    ? { title: titleMetric(root), strip: stripPeak(root), header: headerLabel(root) }
    : { row: rowMetric(root) };
}

async function renderPage() {
  const view = render(React.createElement(TooltipProvider, null, React.createElement(ServiceHistorySection)));
  await settle();
  return view;
}

async function openService(view: ReturnType<typeof render>, rowText: RegExp) {
  const row = await eventually(() => {
    const found = [...view.container.querySelectorAll("button")].find((b) => rowText.test(text(b)));
    assert.ok(found, "the service row never rendered");
    return found;
  });
  fireEvent.click(row);
  await settle();
  await settle();
}

async function choosePlot(metric: string) {
  fireEvent.click(screen.getByLabelText("Customize sound"));
  const dialog = screen.getByLabelText("Customize sound", { selector: "[role='dialog']" });
  const group = within(dialog.querySelector("[data-customize-group='plot']") as HTMLElement);
  fireEvent.click(group.getByRole("radio", { name: new RegExp(`^${metric}`) }));
  await settle();
  await settle();
}

describe("one plotted metric across the page", () => {
  test("the row, the header, the card title and its strip name the Trends metric, then follow a Plot choice together", async () => {
    installFetch();
    const view = await renderPage();
    await eventually(() => assert.deepEqual(named(view.container, false), { row: "LCeq 2" }, "the row before any choice"));

    await openService(view, /Evening/);
    await eventually(() =>
      assert.deepEqual(
        named(view.container, true),
        { title: "LCeq 2", strip: "LCeq 2 peak", header: "Peak LCeq 2" },
        "with no browser choice, every figure plots the organisation's Trends metric",
      ),
    );
    assert.deepEqual(seriesAsked, ["LCeq 2"], "the raw series was read for another metric");

    await choosePlot("LAeq 2");
    await eventually(() =>
      assert.deepEqual(
        named(view.container, true),
        { title: "LAeq 2", strip: "LAeq 2 peak", header: "Peak LAeq 2" },
        "a Plot choice must move the title, the strip and the header together",
      ),
    );
    await eventually(() => assert.deepEqual(seriesAsked, ["LCeq 2", "LAeq 2"]));

    fireEvent.click(screen.getByText("← All services"));
    await settle();
    await eventually(() => assert.deepEqual(named(view.container, false), { row: "LAeq 2" }, "the row after the choice"));
  });

  test("the arrival-only view's Sound card plots from the same preferences", async () => {
    // No timeline record: the service is still arriving, and the page draws its
    // second Sound card call site, without the header.
    installFetch({ timelineRecords: [] });
    const view = await renderPage();
    await openService(view, /recording since|Evening/);
    await eventually(() =>
      assert.deepEqual({ title: titleMetric(view.container), strip: stripPeak(view.container) }, { title: "LCeq 2", strip: "LCeq 2 peak" }),
    );
    await choosePlot("LAeq 2");
    await eventually(() =>
      assert.deepEqual({ title: titleMetric(view.container), strip: stripPeak(view.container) }, { title: "LAeq 2", strip: "LAeq 2 peak" }),
    );
  });
});
