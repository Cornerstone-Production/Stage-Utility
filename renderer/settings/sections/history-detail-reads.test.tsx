// history-detail-reads.test.tsx — one service's History page, when one of its
// own reads fails, or has not answered yet.
//
// The list's three loads already say when they fail (see "Which of the three
// history loads FAILED" in service-history-section.tsx). The four reads behind
// a service's own page were the copy that fix did not reach, and each drew a
// failure as a fact about the service:
//
//   the record       the click fell through to the list; nothing opened
//   attendance       "No attendance recorded for this service."
//   sound            "No sound recorded for this service." — and the header's
//                    level said "no sound recorded" too
//   baptisms         the Baptisms card vanished, as on a weekend without any
//
// A read still in flight is the same mistake from the other side: nothing has
// been read, so nothing may be claimed. On a slow connection a click left the
// list on screen until the record landed, then jumped to the service; the
// cards then said "No attendance recorded" until their charts arrived.
//
// Each log assertion names ITS read ("… for <key>"): the list's own rows read
// every service's sound record from the same URL, and log a line a bare
// /sound/ would accept in place of the page's.
//
// Driven through the real section with a stubbed fetch and a stream that can
// push. NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND — node:assert
// inspects `actual` to build its failure message, and inspecting a live jsdom
// element does not finish in any useful time.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { FakeEventSource } from "../../test-fixtures/fake-event-source.js";
import { installRenderDom, settle, unmountAndTeardown } from "../../test-dom.js";
import { alerts, ok, stubFetchWithLog } from "../../test-fixtures/fetch-log.js";

const teardown = installRenderDom();
(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
};

(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

const { render, screen, cleanup, fireEvent, act } = await import("@testing-library/react");
const React = await import("react");
const { ServiceHistorySection } = await import("./service-history-section.js");
const { TooltipProvider, ConfirmHost, Toaster } = await import("../../components/ui/index.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

const DAY = "2026-09-17";
const iso = (hhmmss: string) => new Date(`${DAY}T${hhmmss}`).toISOString();

/** Two services on one day, so a test can open one and then the other. */
function service(key: string, planTitle: string, start: string, end: string) {
  const timeline = {
    serviceKey: key,
    serviceTypeId: "salt",
    serviceTypeName: "The Salt Company",
    planId: key.split(":")[1],
    planTitle,
    seriesTitle: "Kickoff",
    serviceDate: DAY,
    serviceTimeId: key.split(":")[2],
    serviceTimeStartsAt: iso(start),
    startedAt: iso(start),
    endedAt: iso(end),
    items: [
      { itemId: "a", title: "Welcome", sequence: 0, plannedLengthSec: 300, startedAt: iso(start), endedAt: iso(end), actualDurationSec: 330, counted: true },
    ],
  };
  const attendance = {
    serviceKey: key,
    serviceTypeId: "salt",
    serviceDate: DAY,
    planTitle,
    startedAt: iso(start),
    endedAt: iso(end),
    peakAttendance: 1727,
    peakOccupancy: 1196,
    minOccupancy: 933,
    samples: [
      { t: iso(start), attendance: 1187, occupancy: 1150 },
      { t: iso(end), attendance: 1727, occupancy: 1196 },
    ],
  };
  const spl = {
    serviceKey: key,
    serviceDate: DAY,
    metricKey: null,
    meterId: "m1",
    items: [
      { itemId: "a", title: "Welcome", sequence: 0, metrics: { "SPL LAeq": { max: 94.2, avg: 88, leq: 89, count: 40 } }, maxSpl: 94.2, sampleCount: 40, startedAt: iso(start), endedAt: iso(end) },
    ],
  };
  return { key, timeline, attendance, spl };
}
const A = service("salt:plan-1:evening", "Evening", "20:15:00", "21:45:00");
const B = service("salt:plan-2:late", "Late", "22:00:00", "23:00:00");
const BY_KEY = new Map([A, B].map((s) => [s.key, s]));

type DetailRead = "record" | "attendance" | "spl" | "baptisms";

interface Setup {
  failing?: DetailRead;
  /** Answer a service's own record read, for the in-flight cases below. */
  recordFor?: (key: string) => unknown;
  /** Answer a service's own attendance read, for the race below. */
  attendanceFor?: (key: string) => unknown;
  /** Answer a service's sound record by key. */
  splFor?: (key: string) => unknown;
}

function stubFetch({ failing, recordFor, attendanceFor, splFor }: Setup = {}) {
  return stubFetchWithLog((url, init) => {
    const method = init?.method ?? "GET";
    const read = (name: DetailRead, body: unknown) => {
      if (failing === name) throw new TypeError("fetch failed");
      return ok(body);
    };
    const keyed = (prefix: string) => {
      const m = url.match(new RegExp(`^${prefix}/([^/?]+)$`));
      return m ? BY_KEY.get(decodeURIComponent(m[1])) ?? null : null;
    };
    if (method !== "GET") return ok({ ok: true });
    if (url === "/api/baptism/sessions") return read("baptisms", []);
    if (url === "/api/service-timeline") return ok([A.timeline, B.timeline]);
    if (url === "/api/attendance/history?summary=1") return ok([A.attendance, B.attendance]);
    if (url === "/api/spl/summary") return ok([]);
    if (url === "/api/spl/trend") return ok({ shown: false, metric: null });
    if (url === "/api/spl/visible-metrics") return ok({ metrics: [] });
    if (url === "/api/history/milestones") return ok([]);
    if (/\/series\?/.test(url)) return ok({ metric: "SPL LAeq", bucketSec: 5, buckets: [] });
    const tl = keyed("/api/service-timeline");
    if (tl) return recordFor ? recordFor(tl.key) : read("record", tl.timeline);
    const att = keyed("/api/attendance/history");
    if (att) return attendanceFor ? attendanceFor(att.key) : read("attendance", att.attendance);
    const spl = keyed("/api/spl/history");
    if (spl) return splFor ? splFor(spl.key) : read("spl", spl.spl);
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
}

const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

function mountSection() {
  return render(
    React.createElement(TooltipProvider, null, React.createElement(ServiceHistorySection), React.createElement(ConfirmHost)),
  );
}

/** Click the row whose text includes `title`, and let its reads land. */
async function open(container: HTMLElement, title: string): Promise<void> {
  const row = [...container.querySelectorAll("button")].find((b) => text(b).includes(title));
  assert.ok(!!row, `the ${title} row never rendered`);
  fireEvent.click(row!);
  await settle();
  await settle();
  await settle();
}

async function openA(): Promise<HTMLElement> {
  const view = mountSection();
  await settle();
  await settle();
  await open(view.container, "Evening");
  return view.container;
}

const historyLines = (logs: { tag: string; message: string }[]) => logs.filter((l) => l.tag === "history");
const loggedFor = (logs: { tag: string; message: string }[], what: string) =>
  historyLines(logs).some((l) => l.message.startsWith(`could not read ${what} for ${A.key}:`));

test("a failed record read still opens the service from the list's own copy, and logs it", async () => {
  // The list read that drew the row returned the same record, so the page has
  // what it needs; the failure is a [history] line, not a page that says the
  // service could not be loaded. A service the list does NOT hold says so —
  // see history-service-url.test.tsx.
  const f = stubFetch({ failing: "record" });
  try {
    await openA();
    assert.equal(!!document.querySelector('[data-testid="history-service-header"]'), true, "the service opened");
    assert.equal(/Couldn't load this service's record/i.test(alerts()), false);
    assert.ok(loggedFor(f.logs, "the service record"), `got ${JSON.stringify(f.logs)}`);
  } finally {
    f.restore();
  }
});

/** A read that answers only when the test says so. */
function held<T>(): { promise: Promise<T>; answer: (v: T) => void } {
  let answer: (v: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    answer = resolve;
  });
  return { promise, answer };
}

const sectionLabels = () => [...document.querySelectorAll("section")].map((s) => s.getAttribute("aria-label"));
const loadingCards = () =>
  [...document.querySelectorAll("[data-history-loading]")].map((n) => n.getAttribute("data-history-loading"));

test("a click opens the service at once while its own reads are in flight, and claims nothing", async () => {
  // Every read of Evening held — its record, attendance and sound, and so the
  // row's own sound read too, which is the same route.
  const record = held<unknown>();
  const attendance = held<unknown>();
  const sound = held<unknown>();
  const f = stubFetch({
    recordFor: (key) => (key === A.key ? record.promise.then(ok) : ok(B.timeline)),
    attendanceFor: (key) => (key === A.key ? attendance.promise.then(ok) : ok(B.attendance)),
    splFor: (key) => (key === A.key ? sound.promise.then(ok) : ok(B.spl)),
  });
  try {
    await openA();
    assert.equal(
      !!document.querySelector('[data-testid="history-service-header"]'),
      true,
      "the list stayed on screen until the record landed",
    );
    assert.deepEqual(sectionLabels(), ["Rundown", "Attendance", "Sound"]);
    assert.deepEqual(loadingCards(), ["attendance", "sound"], "both charts say they are loading");
    // Nothing yet claims the service recorded nothing — neither card, nor the
    // header's level figure.
    assert.equal(!!screen.queryByText(/No attendance recorded/i), false);
    assert.equal(!!screen.queryByText(/No sound recorded/i), false);
    assert.equal(!!screen.queryByText("loading"), true, "the header's level figure says it is loading");
    assert.equal(alerts(), "");

    await act(async () => {
      record.answer(A.timeline);
      attendance.answer(A.attendance);
      sound.answer(A.spl);
    });
    await settle();
    await settle();
    assert.deepEqual(loadingCards(), [], "the charts replace the placeholders");
    assert.equal(!!screen.queryByText("loading"), false);
  } finally {
    f.restore();
  }
});

test("a service the row already read the sound of does not wait on the page's own read", async () => {
  // The row's read of Evening's sound answered; the page's own read of the
  // same route is held. The Sound card draws from the row's answer.
  let splReads = 0;
  const sound = held<unknown>();
  const f = stubFetch({
    splFor: (key) => {
      if (key !== A.key) return ok(B.spl);
      splReads += 1;
      return splReads === 1 ? ok(A.spl) : sound.promise.then(ok);
    },
  });
  try {
    await openA();
    assert.ok(splReads >= 2, "the page made its own read");
    assert.deepEqual(loadingCards(), []);
    assert.equal(!!screen.queryByText(/No sound recorded/i), false);
  } finally {
    f.restore();
  }
});

test("Copy report waits for the attendance rather than copying a report without it", async () => {
  // The page opens before its attendance is read, and the report's attendance
  // line needs the full record. Copied in that window, it left the line out
  // and said "Report copied".
  const writes: string[] = [];
  const nav = navigator as unknown as { clipboard?: unknown };
  const win = window as unknown as { isSecureContext: boolean };
  const hadClipboard = Object.getOwnPropertyDescriptor(nav, "clipboard");
  const wasSecure = win.isSecureContext;
  Object.defineProperty(nav, "clipboard", {
    configurable: true,
    value: { writeText: async (t: string) => void writes.push(t) },
  });
  win.isSecureContext = true;
  const attendance = held<unknown>();
  const f = stubFetch({
    attendanceFor: (key) => (key === A.key ? attendance.promise.then(ok) : ok(B.attendance)),
  });
  try {
    const view = render(
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(ServiceHistorySection),
        React.createElement(ConfirmHost),
        React.createElement(Toaster),
      ),
    );
    await settle();
    await settle();
    await open(view.container, "Evening");
    fireEvent.click(screen.getByRole("button", { name: /Copy report/ }));
    await settle();
    assert.deepEqual(writes, [], "nothing is copied while the attendance is in flight");
    assert.equal(!!screen.queryByText(/still loading/i), true, "and it says why");

    await act(async () => attendance.answer(A.attendance));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Copy report/ }));
    await settle();
    assert.equal(writes.length, 1);
    assert.match(writes[0]!, /Peak attendance 1,196/);
  } finally {
    f.restore();
    if (hadClipboard) Object.defineProperty(nav, "clipboard", hadClipboard);
    else delete nav.clipboard;
    win.isSecureContext = wasSecure;
  }
});

test("a service whose attendance is still in flight says so, not 'No attendance recorded'", async () => {
  const attendance = held<unknown>();
  const f = stubFetch({
    attendanceFor: (key) => (key === A.key ? attendance.promise.then(ok) : ok(B.attendance)),
  });
  try {
    await openA();
    assert.deepEqual(loadingCards(), ["attendance"]);
    assert.equal(!!screen.queryByText(/No attendance recorded/i), false);
    // A read that answers "none" is the only thing that may say so.
    await act(async () => attendance.answer(null));
    await settle();
    assert.deepEqual(loadingCards(), []);
    assert.equal(!!screen.queryByText(/No attendance recorded for this service/i), true);
  } finally {
    f.restore();
  }
});

test("a failed attendance read says so on the Attendance card, not 'No attendance recorded'", async () => {
  const f = stubFetch({ failing: "attendance" });
  try {
    await openA();
    assert.match(alerts(), /Couldn't load the attendance for this service/i);
    assert.equal(!!screen.queryByText(/No attendance recorded/i), false);
    assert.ok(loggedFor(f.logs, "the attendance"), `got ${JSON.stringify(f.logs)}`);
  } finally {
    f.restore();
  }
});

test("a failed sound read says so on the Sound card and in the header, not 'No sound recorded'", async () => {
  const f = stubFetch({ failing: "spl" });
  try {
    await openA();
    assert.match(alerts(), /Couldn't load the sound for this service/i);
    // Nor the header's level figure, which said "no sound recorded" too.
    assert.equal(!!screen.queryByText(/No sound recorded/i), false);
    assert.equal(!!screen.queryByText("sound unavailable"), true, "the header's level figure says why it has no level");
    assert.ok(loggedFor(f.logs, "the sound"), `the page's own line, not a row's — got ${JSON.stringify(f.logs)}`);
  } finally {
    f.restore();
  }
});

test("a failed baptism read keeps a Baptisms card that says so, rather than dropping it", async () => {
  const f = stubFetch({ failing: "baptisms" });
  try {
    await openA();
    assert.match(alerts(), /Couldn't load the baptism sessions/i);
    assert.equal(
      [...document.querySelectorAll("section")].some((s) => s.getAttribute("aria-label") === "Baptisms"),
      true,
      "the card stays, so the failure is on the page where the timings would be",
    );
    // The sessions read is page-wide rather than per service, so its line names
    // no service.
    assert.ok(
      historyLines(f.logs).some((l) => l.message.startsWith("could not read the baptism sessions:")),
      `got ${JSON.stringify(f.logs)}`,
    );
  } finally {
    f.restore();
  }
});

// Both live channels a service's page listens on, each after its own failed read.
for (const [read, channel, note, record] of [
  ["attendance", "attendance:history", /Couldn't load the attendance for this service/i, A.attendance],
  ["spl", "spl:history", /Couldn't load the sound for this service/i, A.spl],
] as const) {
  test(`a live ${channel} push for the open service fills a card whose read failed`, async () => {
    const f = stubFetch({ failing: read });
    try {
      await openA();
      assert.match(alerts(), note);
      await act(async () => FakeEventSource.last?.push(channel, record));
      await settle();
      assert.equal(note.test(alerts()), false, "the data streaming in replaces the note");
    } finally {
      f.restore();
    }
  });
}

test("a failure on the service the operator left goes with it: the next one's own state shows", async () => {
  // Evening's sound record fails to read; Late genuinely recorded none. Late's
  // page must say THAT, not carry Evening's failure over.
  const f = stubFetch({ splFor: (key) => (key === A.key ? Promise.reject(new TypeError("fetch failed")) : ok(null)) });
  try {
    const container = await openA();
    assert.match(alerts(), /Couldn't load the sound for this service/i);
    fireEvent.click(screen.getByRole("button", { name: /All services/ }));
    await settle();
    await open(container, "Late");
    assert.equal(/Couldn't load the sound/i.test(alerts()), false, "Evening's failure is not Late's");
    assert.equal(!!screen.queryByText(/No sound recorded for this service/i), true, "Late's own empty state");
  } finally {
    f.restore();
  }
});

// The same two channels, each carrying the OTHER service's record.
for (const [read, channel, note, record] of [
  ["attendance", "attendance:history", /Couldn't load the attendance for this service/i, B.attendance],
  ["spl", "spl:history", /Couldn't load the sound for this service/i, B.spl],
] as const) {
  test(`a live ${channel} push for ANOTHER service does not fill the open one's failed card`, async () => {
    const f = stubFetch({ failing: read });
    try {
      await openA();
      assert.match(alerts(), note);
      await act(async () => FakeEventSource.last?.push(channel, record));
      await settle();
      assert.match(alerts(), note, "Late's figures are not Evening's");
    } finally {
      f.restore();
    }
  });
}

test("a slow failure for the service the operator left does not land on the one they opened", async () => {
  // Evening's attendance is still being read when the operator goes back and
  // opens Late; Late's answer lands, and only then Evening's failure.
  let failEvening: (e: Error) => void = () => {};
  const f = stubFetch({
    attendanceFor: (key) => (key === A.key ? new Promise((_, reject) => { failEvening = reject; }) : ok(B.attendance)),
  });
  try {
    const container = await openA();
    fireEvent.click(screen.getByRole("button", { name: /All services/ }));
    await settle();
    await open(container, "Late");
    await act(async () => failEvening(new TypeError("fetch failed")));
    await settle();
    assert.equal(alerts(), "", "Evening's read no longer applies; its failure is not Late's");
  } finally {
    f.restore();
  }
});

test("control: every read loads, the service's page has no alert and no [history] line", async () => {
  const f = stubFetch();
  try {
    await openA();
    assert.deepEqual(
      [...document.querySelectorAll("section")].map((s) => s.getAttribute("aria-label")),
      ["Rundown", "Attendance", "Sound"],
    );
    assert.equal(alerts(), "");
    assert.deepEqual(historyLines(f.logs), []);
  } finally {
    f.restore();
  }
});
