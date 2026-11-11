// The Trends card's sound metric, driven through the real All services page.
//
// A stubbed server holds the SPL summaries and the organisation's saved choice,
// and a stream a test can push on stands in for a second browser. What is proved
// here is the path, not the pieces: a choice made in the select reaches the tiles
// and the chart, is POSTed, and a push from another browser moves this one. A
// test can hold each POST's answer and send each broadcast itself, so the orders
// the two connections can deliver them in are each a test.
//
// NOT asserted here, because jsdom loads no stylesheet and lays nothing out:
// where the select sits in the header at 1280 and 600, that it is the height of
// the switches beside it, how its chevron and the open list look, that a long
// metric name truncates on a narrow tile, and that the header's controls wrap
// inside the card at 360 rather than running off its edge. Those were driven in a
// browser against a real server and compared with the approved mockup. So was
// the load order behind "Sound holds its loading state": with the saved choice's
// read held back, the default metric was drawn first and then replaced, which is
// what that test pins in the state that causes it.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { FakeEventSource } from "../../test-fixtures/fake-event-source.js";
import { installDom } from "../../test-dom.js";

const teardown = installDom();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

const iso = (day: string, hhmmss: string) => new Date(`${day}T${hhmmss}`).toISOString();

const row = (day: string, type: string, name: string, start: string) => {
  const key = `${type}:plan:${day}`;
  return {
    serviceKey: key,
    serviceTypeId: type,
    serviceTypeName: name,
    planId: "plan",
    planTitle: "Sunday",
    seriesTitle: null,
    serviceDate: day,
    serviceTimeId: key,
    serviceTimeStartsAt: iso(day, start),
    startedAt: iso(day, start),
    endedAt: iso(day, "12:30:00"),
    items: [],
  };
};

const peak = (max: number) => ({ leq: max - 8, max, count: 600 });

/** Two types on two Sundays. Weekend carries four metrics; Evening never recorded LCeq 2. */
const summary = (day: string, type: string, name: string, metrics: Record<string, number>, start: string) => ({
  ...row(day, type, name, start),
  items: undefined,
  metrics: Object.fromEntries(Object.entries(metrics).map(([k, v]) => [k, peak(v)])),
});

const SPL = [
  summary("2026-09-06", "weekend", "Weekend", { "LAeq 2": 94.1, "LCeq 2": 105.2, "SPL Fast": 112.0, "LAeq 10": 91.0 }, "09:00:00"),
  summary("2026-09-13", "weekend", "Weekend", { "LAeq 2": 95.4, "LCeq 2": 106.6, "SPL Fast": 113.4, "LAeq 10": 92.0 }, "09:00:00"),
  summary("2026-09-06", "evening", "Evening", { "LAeq 2": 90.2, "SPL Fast": 108.0 }, "17:00:00"),
  summary("2026-09-13", "evening", "Evening", { "LAeq 2": 91.3, "SPL Fast": 109.0 }, "17:00:00"),
];

/** A third type that recorded only last Christmas Eve: on its tile, out of every range's chart. */
const CHRISTMAS = summary("2025-12-24", "xmas", "Christmas Eve", { "LAeq 2": 97.0, "LCeq 2": 108.0 }, "17:00:00");

type Summary = (typeof SPL)[number];

/** One POST the stub is holding, so a test decides when its answer lands. */
interface HeldPost {
  /** What was asked for. */
  soundMetric: string;
  /** The rev the server gave the write, as the real one does before it answers. */
  rev: number;
  /** Answer it: saved, or refused. */
  release: (refuse?: boolean) => void;
}

const server = {
  /** The organisation's saved choice, as the stub holds it. */
  saved: null as string | null,
  rev: 0,
  /** Every body POSTed to the trends-prefs route, in order. */
  posts: [] as unknown[],
  /** Make the next POST fail, as a server that would not save. */
  failPost: false,
  /** Hold every POST in `held` until the test releases it. */
  hold: false,
  held: [] as HeldPost[],
  /** What every route reports as recorded: timeline, attendance and SPL. */
  recordings: SPL as Summary[],
  /** The SPL summary, when it differs from what was recorded. */
  summaries: null as unknown[] | null,
  splFails: false,
  /** Hold the GET until this resolves: the saved choice arrives after everything else. */
  readGate: null as Promise<void> | null,
  /** Every line the page sent to the server log. */
  logs: [] as string[],
};

const failed = (status: number, error: string) => ({ ok: false, status, json: async () => ({ error }), text: async () => JSON.stringify({ error }) });

(globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown, init?: { method?: string; body?: string }) => {
  const url = String(input);
  const ok = (b: unknown) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });
  if (url === "/api/service-timeline") {
    return ok(server.recordings.map((s) => ({ ...row(s.serviceDate, s.serviceTypeId, s.serviceTypeName ?? "", "09:00:00"), endedAt: s.endedAt })));
  }
  if (url === "/api/attendance/history?summary=1") {
    return ok(
      server.recordings.map((x) => ({
        ...row(x.serviceDate, x.serviceTypeId, x.serviceTypeName ?? "", "09:00:00"),
        items: undefined,
        serviceStartedAt: x.startedAt,
        attendanceBaseline: 0,
        totalAttendance: 300,
        peakAttendance: 300,
        peakOccupancy: x.serviceTypeId === "weekend" ? 640 : 210,
        minOccupancy: 10,
        lastAttendance: 300,
        lastOccupancy: 250,
      })),
    );
  }
  if (url === "/api/spl/summary") return server.splFails ? failed(500, "unreadable") : ok(server.summaries ?? server.recordings);
  if (url === "/api/baptism/sessions") return ok([]);
  if (url === "/api/log/client") server.logs.push(init?.body ?? "");
  if (url === "/api/history/trends-prefs") {
    if (init?.method !== "POST") {
      if (server.readGate) await server.readGate;
      return ok({ rev: server.rev, soundMetric: server.saved });
    }
    const body = JSON.parse(init.body ?? "{}") as { soundMetric: string };
    server.posts.push(body);
    if (server.failPost) return failed(500, "disk full");
    // Numbered as it arrives: the real server saves writes in that order.
    const rev = ++server.rev;
    const answer = () => ok({ rev, soundMetric: (server.saved = body.soundMetric) });
    if (!server.hold) return answer();
    return new Promise((resolve) => {
      server.held.push({ soundMetric: body.soundMetric, rev, release: (refuse) => resolve(refuse ? failed(400, "refused") : answer()) });
    });
  }
  return ok(null);
};

const { render, cleanup, act, fireEvent } = await import("@testing-library/react");
const React = (await import("react")).default;
const { TooltipProvider } = await import("../../components/ui/index.js");
const { ServiceHistorySection } = await import("./service-history-section.js");
const { __resetReplayCacheForTests } = await import("../../lib/api.js");

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("history:trendMeasure", "sound");
  Object.assign(server, { saved: null, rev: 0, posts: [], failPost: false, hold: false, held: [], recordings: SPL, summaries: null, splFails: false, readGate: null, logs: [] });
});
afterEach(() => {
  cleanup();
  __resetReplayCacheForTests();
});
after(() => {
  cleanup();
  teardown();
});

const settle = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  });

async function renderHistory(readOnly = false): Promise<ReturnType<typeof render>> {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    const section = React.createElement(ServiceHistorySection as React.ComponentType<{ readOnly: boolean }>, { readOnly });
    view = render(React.createElement(TooltipProvider, null, section));
  });
  await settle();
  return view;
}

const select = (v: ReturnType<typeof render>) => v.container.querySelector<HTMLSelectElement>('select[aria-label="Sound metric"]');
const tile = (v: ReturnType<typeof render>, id: string) => v.container.querySelector(`[data-trend-tile="${id}"]`)!;
const latest = (v: ReturnType<typeof render>, id: string) => tile(v, id).querySelector("[data-trend-latest]")?.textContent;
const subtitle = (v: ReturnType<typeof render>) => v.container.querySelector("[data-trends-subtitle]")?.textContent ?? "";
const chooseMetric = async (v: ReturnType<typeof render>, metric: string) => {
  await act(async () => {
    fireEvent.change(select(v)!, { target: { value: metric } });
  });
  await settle();
};

describe("the Trends sound metric", () => {
  test("with nothing saved, Trends plots LAeq 2 and every tile, the subtitle and the chart name it", async () => {
    const view = await renderHistory();
    assert.equal(select(view)?.value, "LAeq 2");
    assert.equal(latest(view, "weekend"), "95.4 dB");
    assert.equal(latest(view, "evening"), "91.3 dB");
    assert.match(subtitle(view), /^Peak LAeq 2 per service type/);
    assert.equal(tile(view, "weekend").querySelector("[data-trend-what]")?.textContent, "latest day peak LAeq 2");
    assert.ok(
      view.container.querySelector('svg[aria-label="Peak LAeq 2: the loudest recording of each day over the last 16 weeks"]'),
      "the chart's aria-label does not name the metric",
    );
  });

  test("the select lists every metric the recordings carry, once, in a stable sorted order", async () => {
    const view = await renderHistory();
    assert.deepEqual(
      [...select(view)!.options].map((o) => o.value),
      ["LAeq 2", "LAeq 10", "LCeq 2", "SPL Fast"],
    );
  });

  test("it is offered under Sound only", async () => {
    localStorage.setItem("history:trendMeasure", "attendance");
    const view = await renderHistory();
    assert.ok(select(view) === null, "the select must not appear under Attendance");
    await act(async () => view.container.querySelector<HTMLButtonElement>('[data-trend-measure="sound"]')!.click());
    assert.ok(select(view), "the select appears once Sound is chosen");
  });

  test("choosing LCeq 2 redraws at once with that metric's maxima, and saves it", async () => {
    const view = await renderHistory();
    await chooseMetric(view, "LCeq 2");
    assert.equal(select(view)?.value, "LCeq 2");
    assert.equal(latest(view, "weekend"), "106.6 dB");
    assert.match(subtitle(view), /^Peak LCeq 2 per service type/);
    assert.equal(tile(view, "weekend").querySelector("[data-trend-what]")?.textContent, "latest day peak LCeq 2");
    assert.deepEqual(server.posts, [{ soundMetric: "LCeq 2" }]);
  });

  test("a type whose recordings lack the metric reads 'no <metric> reading', not another metric's figure", async () => {
    const view = await renderHistory();
    await chooseMetric(view, "LCeq 2");
    assert.equal(latest(view, "evening"), "—");
    assert.equal(tile(view, "evening").querySelector("[data-trend-change]")?.textContent, "no LCeq 2 reading");
  });

  test("and the legend keeps that type, noted, while its line draws nothing", async () => {
    const view = await renderHistory();
    await chooseMetric(view, "LCeq 2");
    const entry = view.container.querySelector('[data-series-toggle="evening"]');
    assert.equal(entry?.textContent, "Evening · no LCeq 2 reading");
    assert.ok(view.container.querySelector('[data-series-line="weekend"]'), "the type that has the metric still draws");
    assert.ok(view.container.querySelector('[data-series-line="evening"]') === null, "a type with no reading drew a line");
  });

  test("Sound holds its loading state, naming no metric, until the saved choice is heard", async () => {
    server.saved = "SPL Fast";
    let open!: () => void;
    server.readGate = new Promise((r) => (open = r));
    const view = await renderHistory();
    assert.ok(view.container.querySelector("[data-trends-loading]"), "the default metric was drawn before the saved one was known");
    assert.doesNotMatch(subtitle(view), /LAeq 2/, "the subtitle named the default before the saved choice was known");
    assert.ok(select(view) === null, "a select offered before the saved choice was known");
    await act(async () => open());
    await settle();
    assert.equal(latest(view, "weekend"), "113.4 dB");
    assert.match(subtitle(view), /^Peak SPL Fast per service type/);
  });

  test("a choice saved earlier is what a fresh page shows", async () => {
    server.saved = "SPL Fast";
    const view = await renderHistory();
    assert.equal(select(view)?.value, "SPL Fast");
    assert.equal(latest(view, "weekend"), "113.4 dB");
  });

  test("a second browser's choice arrives over the stream and moves this one with no request", async () => {
    const view = await renderHistory();
    assert.equal(latest(view, "weekend"), "95.4 dB");
    await act(async () => FakeEventSource.last!.push("trends:prefs", { rev: 9, soundMetric: "LCeq 2" }));
    assert.equal(select(view)?.value, "LCeq 2");
    assert.equal(latest(view, "weekend"), "106.6 dB");
    assert.deepEqual(server.posts, [], "following the push must not write anything back");
  });

  test("a choice the server refuses goes back to what it was, and nothing sticks", async () => {
    const view = await renderHistory();
    server.failPost = true;
    await chooseMetric(view, "LCeq 2");
    assert.equal(select(view)?.value, "LAeq 2", "the select kept a choice that was not saved");
    assert.equal(latest(view, "weekend"), "95.4 dB");
    assert.ok(
      server.logs.some((l) => l.includes("could not save the Trends sound metric: disk full")),
      `the refusal reached no log line: ${server.logs.join(" | ")}`,
    );
  });

  test("with nothing saved and no LAeq 2 or LAeq 1, the browser's own Customize list decides", async () => {
    server.summaries = SPL.map((s) => ({
      ...s,
      metrics: Object.fromEntries(Object.entries(s.metrics).filter(([k]) => k !== "LAeq 2")),
    }));
    localStorage.setItem("spl:visibleMetrics", JSON.stringify(["SPL Fast"]));
    const view = await renderHistory();
    assert.equal(select(view)?.value, "SPL Fast");
    assert.equal(latest(view, "weekend"), "113.4 dB");
  });

  test("with LAeq 2 present, a browser's Customize list does not move Trends", async () => {
    localStorage.setItem("spl:visibleMetrics", JSON.stringify(["SPL Fast"]));
    const view = await renderHistory();
    assert.equal(select(view)?.value, "LAeq 2");
    assert.equal(latest(view, "weekend"), "95.4 dB");
  });

  test("each tile has the date beside the name and the what-line second, in BOTH modes", async () => {
    const view = await renderHistory();
    const check = (what: string) => {
      const t = tile(view, "weekend");
      const nameLine = t.querySelector("[data-trend-name]")!.parentElement!;
      assert.equal(nameLine.querySelector("[data-trend-latest-date]")?.textContent, "Sep 13", "the date is not beside the name");
      assert.equal(nameLine.textContent, "WeekendSep 13", "the first line carries the name and the date and nothing else");
      assert.equal(t.querySelector("[data-trend-what]")?.textContent, what);
      assert.ok(!nameLine.contains(t.querySelector("[data-trend-what]")), "the what-line is on its own line");
    };
    check("latest day peak LAeq 2");
    await act(async () => view.container.querySelector<HTMLButtonElement>('[data-trend-measure="attendance"]')!.click());
    check("latest day total");
  });

  test("the chart draws no node at each data point", async () => {
    const view = await renderHistory();
    const line = view.container.querySelector("[data-series-line]");
    assert.ok(line, "sanity: a line is drawn");
    const plot = line.closest("svg")!;
    assert.equal(plot.querySelectorAll("circle").length, 0, "a per-point dot was drawn on a finished line");
  });

  test("with every carried metric hidden by this browser's Customize list, the select is still offered, and saves", async () => {
    server.summaries = SPL.map((s) => ({
      ...s,
      metrics: Object.fromEntries(Object.entries(s.metrics).filter(([k]) => k !== "LAeq 2")),
    }));
    localStorage.setItem("spl:visibleMetrics", JSON.stringify(["SPL Slow"]));
    const view = await renderHistory();
    assert.ok(select(view), "no metric resolved, and the select that would choose one was not offered");
    assert.equal(select(view)!.value, "", "a native select with no value showed its first option as if chosen");
    await chooseMetric(view, "LCeq 2");
    assert.deepEqual(server.posts, [{ soundMetric: "LCeq 2" }]);
    assert.equal(latest(view, "weekend"), "106.6 dB");
  });
});

const legendText = (v: ReturnType<typeof render>) =>
  [...v.container.querySelectorAll("[data-series-toggle]")].map((e) => e.textContent ?? "");

describe("the legend's 'no reading' note follows the tile", () => {
  test("a type whose readings are older than the range keeps its figure, and no note claims it has none", async () => {
    server.recordings = [...SPL, CHRISTMAS];
    const view = await renderHistory();
    assert.equal(latest(view, "xmas"), "97.0 dB", "sanity: the tile shows last Christmas's reading");
    assert.deepEqual(
      legendText(view).filter((t) => t.includes("reading")),
      [],
      "the legend said a type with a reading on its tile had none",
    );
  });

  test("with the SPL summary unread, no legend entry claims a missing reading", async () => {
    server.splFails = true;
    server.saved = "LCeq 2";
    const view = await renderHistory();
    assert.equal(tile(view, "weekend").querySelector("[data-trend-change]")?.textContent, "sound unavailable");
    assert.deepEqual(legendText(view).filter((t) => t.includes("reading")), []);
  });
});

describe("the shared /history link", () => {
  test("shows the organisation's choice and offers no select to change it", async () => {
    server.saved = "LCeq 2";
    const view = await renderHistory(true);
    // assert.ok, not assert.equal: a failing equal would try to print a jsdom node.
    assert.ok(select(view) === null, "the read-only page offered a control that writes an organisation setting");
    assert.equal(latest(view, "weekend"), "106.6 dB", "the read-only page does not follow the saved metric");
    assert.match(subtitle(view), /^Peak LCeq 2 per service type/);
    await act(async () => FakeEventSource.last!.push("trends:prefs", { rev: 3, soundMetric: "SPL Fast" }));
    assert.equal(latest(view, "weekend"), "113.4 dB", "the read-only page does not follow a change");
    assert.deepEqual(server.posts, []);
  });
});

describe("one browser among several", () => {
  const push = (rev: number, soundMetric: string) =>
    act(async () => FakeEventSource.last!.push("trends:prefs", { rev, soundMetric }));
  /** The server's broadcast of a held write: what the real one sends before it answers. */
  const echo = (i: number) => push(server.held[i].rev, server.held[i].soundMetric);
  const answer = async (i: number, refuse = false) => {
    await act(async () => server.held[i].release(refuse));
    await settle();
  };

  test("after a choice of its own, another browser's later change still moves it", async () => {
    const view = await renderHistory();
    await chooseMetric(view, "LCeq 2");
    await push(1, "LCeq 2");
    await push(2, "SPL Fast");
    assert.equal(select(view)?.value, "SPL Fast", "a browser that chose once stopped following the others");
  });

  test("its own echo, then another browser's change, then its own answer: it ends on the other browser's", async () => {
    server.hold = true;
    const view = await renderHistory();
    await chooseMetric(view, "LCeq 2");
    await echo(0);
    await push(2, "SPL Fast");
    await answer(0);
    assert.equal(select(view)?.value, "SPL Fast", "this browser's own answer put back a choice the server no longer holds");
  });

  test("an older answer landing after a newer choice does not win", async () => {
    server.hold = true;
    const view = await renderHistory();
    await chooseMetric(view, "LCeq 2");
    await chooseMetric(view, "SPL Fast");
    await answer(0);
    assert.equal(select(view)?.value, "SPL Fast");
    await echo(0);
    assert.equal(select(view)?.value, "SPL Fast", "the first choice's answer took the select back");
    await echo(1);
    await answer(1);
    assert.equal(select(view)?.value, "SPL Fast");
  });

  for (const order of ["echo before answer", "answer before echo"] as const) {
    test(`choosing A then B never shows A again (${order})`, async () => {
      server.hold = true;
      const view = await renderHistory();
      const shown: (string | undefined)[] = [];
      const look = () => void shown.push(select(view)?.value);
      await chooseMetric(view, "LCeq 2");
      await chooseMetric(view, "SPL Fast");
      look();
      const settleOne = async (i: number) => {
        if (order === "echo before answer") {
          await echo(i);
          look();
          await answer(i);
        } else {
          await answer(i);
          look();
          await echo(i);
        }
        look();
      };
      await settleOne(0);
      await settleOne(1);
      assert.deepEqual(shown, ["SPL Fast", "SPL Fast", "SPL Fast", "SPL Fast", "SPL Fast"]);
    });
  }

  test("B then A again over a saved A, both answered before either echo: B never shows after the second pick", async () => {
    server.hold = true;
    server.saved = "LAeq 2";
    const view = await renderHistory();
    await chooseMetric(view, "SPL Fast");
    await chooseMetric(view, "LAeq 2");
    const shown: (string | undefined)[] = [];
    for (const step of [() => answer(0), () => answer(1), () => echo(0), () => echo(1)]) {
      await step();
      shown.push(select(view)?.value);
    }
    assert.deepEqual(shown, ["LAeq 2", "LAeq 2", "LAeq 2", "LAeq 2"]);
  });

  test("a server restart between its answer and its echo does not leave it deaf to later changes", async () => {
    server.hold = true;
    server.rev = 6;
    const view = await renderHistory();
    await chooseMetric(view, "LCeq 2");
    await answer(0);
    // The new process loads the saved choice and counts from 0 again.
    await push(0, "LCeq 2");
    await push(1, "SPL Fast");
    assert.equal(select(view)?.value, "SPL Fast", "the held choice outlived the restart and hid a later change");
  });

  test("a restart that brings back a different value lets go of the held choice", async () => {
    // A config restore is a restart with another value, and the echo of this
    // browser's own write is lost with the old process.
    server.hold = true;
    server.rev = 6;
    const view = await renderHistory();
    await chooseMetric(view, "LCeq 2");
    await answer(0);
    await push(0, "SPL Fast");
    assert.equal(select(view)?.value, "SPL Fast", "the held choice hid what the restarted server holds");
    await push(1, "LAeq 10");
    assert.equal(select(view)?.value, "LAeq 10");
  });

  test("A, B, A answered before any echo never shows B on the way", async () => {
    server.hold = true;
    const view = await renderHistory();
    await chooseMetric(view, "LCeq 2");
    await chooseMetric(view, "SPL Fast");
    await chooseMetric(view, "LCeq 2");
    await answer(0);
    await answer(1);
    await answer(2);
    const shown = [select(view)?.value];
    for (const i of [0, 1, 2]) {
      await echo(i);
      shown.push(select(view)?.value);
    }
    assert.deepEqual(shown, ["LCeq 2", "LCeq 2", "LCeq 2", "LCeq 2"]);
  });

  test("a choice it made that the server refuses goes back to the server's value", async () => {
    server.hold = true;
    server.saved = "SPL Fast";
    const view = await renderHistory();
    await chooseMetric(view, "LCeq 2");
    assert.equal(select(view)?.value, "LCeq 2", "sanity: the choice shows while it is out");
    await answer(0, true);
    assert.equal(select(view)?.value, "SPL Fast", "the select kept a choice the server refused");
    assert.ok(server.logs.some((l) => l.includes("could not save the Trends sound metric")));
  });
});
