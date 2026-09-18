// History → a recording → Edit times → "Rebuild from raw".
//
// A control that renders is not a control that does anything: this presses the
// real button, through the real confirm dialog, through the real
// renderer/lib/api.ts, and asserts the request that reached the network and the
// counts the operator is shown. A stub of `invoke` would have proved only that
// the handler this file also wrote calls itself.
//
// jsdom lays out nothing and loads no stylesheet, so nothing here asserts
// layout, size or colour — where the button sits in the action row was checked
// in a browser instead.

import { strict as assert } from "node:assert";
import { after, before, beforeEach, describe, test } from "node:test";

import { installDom } from "../../test-dom.js";

const teardown = installDom();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** api.ts opens an SSE stream on first use; nothing here needs to push on it. */
class FakeEventSource {
  readyState = 1;
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

const DATE = "2026-09-17";
const KEY = `st1:plan-1:t-1`;

function timeline() {
  return {
    serviceKey: KEY,
    serviceTypeId: "st1",
    serviceTypeName: "Weekend",
    planId: "plan-1",
    planTitle: "Sunday Gathering",
    seriesTitle: null,
    serviceDate: DATE,
    serviceTimeId: "t-1",
    serviceTimeStartsAt: `${DATE}T23:00:00.000Z`,
    startedAt: `${DATE}T23:23:48.789Z`,
    endedAt: "2026-09-18T00:43:15.189Z",
    items: [
      {
        itemId: "pco-1",
        title: "Doors",
        sequence: 0,
        plannedLengthSec: 900,
        startedAt: `${DATE}T23:23:48.789Z`,
        endedAt: "2026-09-18T00:43:15.189Z",
        actualDurationSec: 4766,
        preService: true,
      },
    ],
  };
}

interface Call {
  method: string;
  url: string;
  body: unknown;
}

function installFetch(calls: Call[], rebuild: () => { ok: boolean; body: unknown }) {
  (globalThis as unknown as { fetch: unknown }).fetch = async (
    input: string,
    init?: { method?: string; body?: string },
  ) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const ok = (body: unknown) => ({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
    if (method !== "GET") calls.push({ method, url, body: init?.body ? JSON.parse(init.body) : null });

    if (url === "/api/history/rebuild") {
      const r = rebuild();
      const payload = r.body;
      return r.ok
        ? ok(payload)
        : { ok: false, status: 500, json: async () => payload, text: async () => JSON.stringify(payload) };
    }
    if (url === "/api/service-timeline") return ok([timeline()]);
    if (url === "/api/attendance/history") return ok([]);
    if (url === "/api/spl/summary") return ok([]);
    if (url === "/api/spl/trend") return ok({ shown: false, metric: null });
    if (url === "/api/baptism/sessions") return ok([]);
    if (url.match(/^\/api\/service-timeline\/[^/]+$/)) return ok(timeline());
    if (url.match(/^\/api\/attendance\/history\/[^/]+$/)) return ok(null);
    if (url.match(/^\/api\/spl\/history\/[^/]+$/)) return ok(null);
    throw new Error(`unexpected fetch: ${method} ${url}`);
  };
}

const { render, cleanup, fireEvent } = await import("@testing-library/react");
const React = (await import("react")).default;
const { TooltipProvider, ConfirmHost, Toaster } = await import("../../components/ui/index.js");

function mountSection(Section: React.ComponentType) {
  return render(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(Section),
      React.createElement(ConfirmHost),
      React.createElement(Toaster),
    ),
  );
}

after(() => {
  cleanup();
  teardown();
});

const settle = () => new Promise((r) => setTimeout(r, 0));
const text = (el: HTMLElement) => (el.textContent ?? "").replace(/\s+/g, " ").trim();
const button = (root: HTMLElement, label: string) =>
  [...root.querySelectorAll("button")].find((b) => text(b as HTMLElement) === label) as HTMLElement | undefined;

/** The NEWEST toast only. Toasts linger across tests in one jsdom document, so
 *  reading document.body lets a PREVIOUS test's message satisfy an assertion
 *  about this one — which it did, on the first run of the "left alone" case. */
const lastToast = () => {
  const all = [...document.querySelectorAll(".text-footnote")];
  return all.length ? text(all[all.length - 1] as HTMLElement) : "NO TOAST";
};

/** Open the one recording and reveal the edit actions. */
async function openEditActions(container: HTMLElement) {
  const row = [...container.querySelectorAll("button")].find((b) =>
    text(b as HTMLElement).includes("Sunday Gathering"),
  );
  assert.ok(row, "the recording's row never rendered");
  fireEvent.click(row!);
  await settle();
  await settle();
  const edit = [...container.querySelectorAll("button")].find((b) => text(b as HTMLElement) === "Edit times");
  assert.ok(edit, "the Edit times button never rendered");
  fireEvent.click(edit!);
  await settle();
}

describe("History: Rebuild from raw", () => {
  let ServiceHistorySection: typeof import("./service-history-section.js").ServiceHistorySection;

  before(async () => {
    ({ ServiceHistorySection } = await import("./service-history-section.js"));
  });

  beforeEach(() => cleanup());

  test("posts the service key and reports the three counts it got back", async (t) => {
    const calls: Call[] = [];
    installFetch(calls, () => ({
      ok: true,
      body: {
        timeline: { rebuilt: true, items: 12, missing: false },
        spl: { rebuilt: true, items: 11, missing: false },
        attendance: { rebuilt: true, items: 143, missing: false },
        failed: [],
      },
    }));
    const view = mountSection(ServiceHistorySection);
    t.after(() => cleanup());
    await settle();
    await settle();
    await openEditActions(view.container);

    const btn = button(view.container, "Rebuild from raw");
    assert.ok(btn, `the Rebuild from raw button never rendered: ${text(view.container)}`);
    fireEvent.click(btn!);
    await settle();

    // The confirm has to say what is lost — the rebuild discards hand edits.
    const dialog = text(document.body as HTMLElement);
    assert.match(dialog, /Rebuild from raw\?/);
    assert.match(dialog, /hand edits to times are lost/i);

    const go = button(document.body as HTMLElement, "Rebuild");
    assert.ok(go, `the confirm dialog offered no Rebuild button: ${dialog}`);
    fireEvent.click(go!);
    await settle();
    await settle();

    const posted = calls.filter((c) => c.url === "/api/history/rebuild");
    assert.equal(posted.length, 1, `expected exactly one rebuild request, got ${JSON.stringify(calls)}`);
    assert.equal(posted[0].method, "POST");
    assert.deepEqual(posted[0].body, { serviceKey: KEY });

    const shown = lastToast();
    assert.match(shown, /12 items/, `the toast does not report the timeline count: ${shown}`);
    assert.match(shown, /11 SPL items/, `the toast does not report the SPL count: ${shown}`);
    assert.match(shown, /143 attendance samples/, `the toast does not report the sample count: ${shown}`);
    assert.doesNotMatch(shown, /left alone/, `nothing was left alone, so the toast must not say so: ${shown}`);
  });

  // The defect the per-record shape exists for: a count alone read as an
  // achievement even for a record the raw layer held nothing for, so a rebuild
  // that changed nothing reported "Rebuilt: 12 items".
  test("names the records it left alone, not just the ones it derived", async (t) => {
    const calls: Call[] = [];
    installFetch(calls, () => ({
      ok: true,
      body: {
        timeline: { rebuilt: false, items: 12, missing: false },
        spl: { rebuilt: false, items: 9, missing: false },
        attendance: { rebuilt: true, items: 143, missing: false },
        failed: [],
      },
    }));
    const view = mountSection(ServiceHistorySection);
    t.after(() => cleanup());
    await settle();
    await settle();
    await openEditActions(view.container);

    fireEvent.click(button(view.container, "Rebuild from raw")!);
    await settle();
    fireEvent.click(button(document.body as HTMLElement, "Rebuild")!);
    await settle();
    await settle();

    const shown = lastToast();
    assert.match(shown, /left alone: items, SPL items/, `the toast hid what it did not touch: ${shown}`);
    assert.doesNotMatch(shown, /Rebuilt: 12 items/, `an untouched record was reported as rebuilt: ${shown}`);
    assert.match(shown, /Rebuilt: 143 attendance samples/, `the one derived record is missing: ${shown}`);
  });

  test("reports a record whose write failed, without claiming the rebuild succeeded", async (t) => {
    const calls: Call[] = [];
    installFetch(calls, () => ({
      ok: true,
      body: {
        timeline: { rebuilt: true, items: 24, missing: false },
        spl: { rebuilt: true, items: 24, missing: false },
        attendance: { rebuilt: true, items: 571, missing: false },
        failed: ["spl"],
      },
    }));
    const view = mountSection(ServiceHistorySection);
    t.after(() => cleanup());
    await settle();
    await settle();
    await openEditActions(view.container);

    fireEvent.click(button(view.container, "Rebuild from raw")!);
    await settle();
    fireEvent.click(button(document.body as HTMLElement, "Rebuild")!);
    await settle();
    await settle();

    const shown = lastToast();
    assert.match(shown, /could not save: spl/, `a failed write was not reported to the operator: ${shown}`);
  });

  test("sends nothing when the confirm is dismissed", async (t) => {
    const calls: Call[] = [];
    installFetch(calls, () => ({
      ok: true,
      body: {
        timeline: { rebuilt: true, items: 0, missing: false },
        spl: { rebuilt: false, items: 0, missing: true },
        attendance: { rebuilt: false, items: 0, missing: true },
        failed: [],
      },
    }));
    const view = mountSection(ServiceHistorySection);
    t.after(() => cleanup());
    await settle();
    await settle();
    await openEditActions(view.container);

    fireEvent.click(button(view.container, "Rebuild from raw")!);
    await settle();
    const cancel = button(document.body as HTMLElement, "Cancel");
    assert.ok(cancel, "the confirm dialog offered no Cancel");
    fireEvent.click(cancel!);
    await settle();
    await settle();

    assert.deepEqual(
      calls.filter((c) => c.url === "/api/history/rebuild"),
      [],
      "a dismissed confirm still rebuilt",
    );
  });

  test("says why when the server refuses", async (t) => {
    const calls: Call[] = [];
    installFetch(calls, () => ({
      ok: false,
      body: { error: "That service is recording right now — it cannot be rebuilt until it ends." },
    }));
    const view = mountSection(ServiceHistorySection);
    t.after(() => cleanup());
    await settle();
    await settle();
    await openEditActions(view.container);

    fireEvent.click(button(view.container, "Rebuild from raw")!);
    await settle();
    fireEvent.click(button(document.body as HTMLElement, "Rebuild")!);
    await settle();
    await settle();

    const shown = lastToast();
    assert.match(shown, /Rebuild failed/, `no failure toast: ${shown}`);
    assert.match(shown, /recording right now/, `the reason was swallowed: ${shown}`);
  });
});
