// History's Edit times, in the APP's zone rather than this browser's.
//
// The bug: the Start and End fields were filled and read in the browser's zone,
// anchored on the service date, and Save sent both stamps whether or not either
// had changed. An evening service in Chicago, opened from a browser in UTC, sits
// on the next UTC day, so the stamps went back a day early and the server
// trimmed away every item, SPL item and attendance sample the service had — from
// pressing Save on a form nobody had touched.
//
// So this file runs as a UTC browser (TZ is read per call by Node's Date and
// Intl, and each test file is its own process) with the app zone, served on
// stage state, set to America/Chicago. Each assertion fails on one bug:
//
//   - the fields open on the Chicago times, not the UTC ones (display)
//   - Save with nothing changed POSTs nothing (sending unchanged stamps)
//   - changing End alone POSTs exactly that instant and no start (parse, and
//     sending unchanged stamps)
//   - a service that crosses midnight puts its end on the next day (anchoring
//     the end on the service date)
//   - an item's corrected time is read in the app zone (the item fields)
//
// Driven through the real api.ts, as history-item-time-edits.test.tsx is: what
// has to hold is what Save actually sends.

process.env.TZ = "UTC";

import { strict as assert } from "node:assert";
import { after, afterEach, before, describe, test } from "node:test";

import { eventually, installDom, settle, unmountAndTeardown } from "../../test-dom.js";
import { FakeEventSource } from "../../test-fixtures/fake-event-source.js";

const teardown = installDom();

(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

const KEY = "weekend:plan-eve:6pm";

interface Window {
  serviceDate: string;
  startedAt: string;
  endedAt: string;
}

/** 18:00-19:30 in Chicago on Sunday 22 Nov 2026: 00:00-01:30 UTC on the 23rd,
 *  a different calendar day in this browser than in the app. */
const EVENING: Window = {
  serviceDate: "2026-11-22",
  startedAt: "2026-11-23T00:00:00.000Z",
  endedAt: "2026-11-23T01:30:00.000Z",
};

/** 23:30 on Saturday 21 Nov to 01:00 on Sunday 22 Nov, in Chicago. */
const PAST_MIDNIGHT: Window = {
  serviceDate: "2026-11-21",
  startedAt: "2026-11-22T05:30:00.000Z",
  endedAt: "2026-11-22T07:00:00.000Z",
};

function timeline(w: Window) {
  return {
    serviceKey: KEY,
    serviceTypeId: "weekend",
    serviceTypeName: "Weekend",
    planId: "plan-eve",
    planTitle: "Evening",
    seriesTitle: null,
    serviceDate: w.serviceDate,
    serviceTimeId: "6pm",
    serviceTimeStartsAt: w.startedAt,
    startedAt: w.startedAt,
    endedAt: w.endedAt,
    items: [
      {
        itemId: "wel-1",
        title: "Welcome",
        sequence: 0,
        plannedLengthSec: 300,
        startedAt: w.startedAt,
        endedAt: new Date(Date.parse(w.startedAt) + 600_000).toISOString(),
        actualDurationSec: 600,
      },
    ],
  };
}

interface Posted {
  url: string;
  body: Record<string, unknown>;
}

/** The server: a Chicago app zone on a UTC host, one recorded service. `refuse`
 *  answers the first window POST as a server would a window that trims data. */
function installFetch(w: Window, opts: { refuse?: boolean } = {}) {
  const posts: Posted[] = [];
  const seen = new Set<string>();
  let refusals = opts.refuse ? 1 : 0;
  (globalThis as unknown as { fetch: unknown }).fetch = async (
    input: unknown,
    init?: { method?: string; body?: string },
  ) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    seen.add(url);
    const answer = (status: number, body: unknown) => ({
      ok: status < 300,
      status,
      statusText: String(status),
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
    const ok = (body: unknown) => answer(200, body);
    if (method === "POST") {
      const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
      posts.push({ url, body });
      if (url === "/api/history/window" && refusals > 0) {
        refusals--;
        return answer(409, {
          error: "That window would delete 1 timeline item recorded outside it. Nothing was changed.",
          code: "trims-data",
        });
      }
      return ok({ ok: true });
    }
    if (url === "/api/state") return ok({ timezone: "America/Chicago", hostTimezone: "UTC" });
    if (url === "/api/service-timeline") return ok([timeline(w)]);
    if (url === "/api/attendance/history?summary=1") return ok([]);
    if (url === "/api/spl/summary") return ok([]);
    if (url === "/api/baptism/sessions") return ok([]);
    if (/^\/api\/service-timeline\/[^/]+$/.test(url)) return ok(timeline(w));
    if (/^\/api\/attendance\/history\/[^/]+$/.test(url)) return ok(null);
    if (/^\/api\/spl\/history\/[^/]+$/.test(url)) return ok(null);
    return ok({});
  };
  return { posts, seen };
}

const { render, cleanup, fireEvent } = await import("@testing-library/react");
const React = (await import("react")).default;
const { TooltipProvider, ConfirmHost } = await import("../../components/ui/index.js");
const { __resetForTests: resetStageState } = await import("../../main/use-stage-state.js");
const { __resetReplayCacheForTests: resetReplayCache } = await import("../../lib/api.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => {
  cleanup();
  resetStageState();
  resetReplayCache();
});

const text = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ").trim();
const buttonNamed = (root: ParentNode, label: string) =>
  [...root.querySelectorAll("button")].find((b) => text(b) === label) as HTMLButtonElement | undefined;

/** The window form's own two fields, by their labels. */
function windowFields(container: HTMLElement) {
  const field = (label: string) => {
    const el = [...container.querySelectorAll("label")].find((l) => text(l).startsWith(label))?.querySelector("input");
    assert.ok(el, `the ${label} field never rendered`);
    return el as HTMLInputElement;
  };
  return { start: field("Start"), end: field("End") };
}

describe("History: Edit times in the app's zone, from a browser in another", () => {
  let ServiceHistorySection: typeof import("./service-history-section.js").ServiceHistorySection;

  before(async () => {
    ({ ServiceHistorySection } = await import("./service-history-section.js"));
  });

  /** Mount, wait for the app zone to land, open the service and press Edit times. */
  async function openEditTimes(server: ReturnType<typeof installFetch>) {
    const view = render(
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(ServiceHistorySection),
        React.createElement(ConfirmHost),
      ),
    );
    await settle();
    // The form is filled in whatever zone it has when it opens. Before stage
    // state lands that is the browser's, which is the fallback, not the case.
    await eventually(() => assert.ok(server.seen.has("/api/state"), "stage state was never read"));
    await settle();
    const row = await eventually(() => {
      const found = [...view.container.querySelectorAll("button")].find((b) => text(b).includes("Evening"));
      assert.ok(found, "the service row never rendered");
      return found;
    });
    fireEvent.click(row);
    await settle();
    const edit = await eventually(() => {
      const found = buttonNamed(view.container, "Edit times");
      assert.ok(found, "the Edit times button never rendered");
      return found;
    });
    fireEvent.click(edit);
    await settle();
    return view;
  }

  const windowPosts = (server: ReturnType<typeof installFetch>) =>
    server.posts.filter((p) => p.url === "/api/history/window");

  test("the fields open on the app zone's times, not this browser's", async () => {
    assert.equal(new Date(EVENING.startedAt).getHours(), 0, "precondition: this browser runs UTC");
    const server = installFetch(EVENING);
    const view = await openEditTimes(server);

    const { start, end } = windowFields(view.container);
    assert.equal(start.value, "18:00", "Start reads in the browser's zone");
    assert.equal(end.value, "19:30", "End reads in the browser's zone");
    const item = view.container.querySelector<HTMLInputElement>('input[aria-label="Started — Welcome"]');
    assert.equal(item?.value, "18:00:00", "an item's Started reads in the browser's zone");
    // The rundown's read-only times are still this browser's, so the form says
    // which zone it is in.
    assert.match(text(view.container), /Times in America\/Chicago/);
  });

  test("Save with nothing changed sends nothing", async () => {
    const server = installFetch(EVENING);
    const view = await openEditTimes(server);

    fireEvent.click(buttonNamed(view.container, "Save")!);
    await settle();
    await settle();

    assert.deepEqual(windowPosts(server), [], "an untouched form re-windowed the service");
    assert.equal(buttonNamed(view.container, "Save"), undefined, "the form did not close");
  });

  test("changing End alone sends that instant, and no start", async () => {
    const server = installFetch(EVENING);
    const view = await openEditTimes(server);

    fireEvent.change(windowFields(view.container).end, { target: { value: "19:45" } });
    await settle();
    fireEvent.click(buttonNamed(view.container, "Save")!);
    await settle();

    const post = await eventually(() => {
      const [found] = windowPosts(server);
      assert.ok(found, "nothing was POSTed");
      return found;
    });
    assert.deepEqual(post!.body, { serviceKey: KEY, endedAt: "2026-11-23T01:45:00.000Z" });
  });

  test("a service past midnight keeps its end on the next day", async () => {
    const server = installFetch(PAST_MIDNIGHT);
    const view = await openEditTimes(server);

    const { start, end } = windowFields(view.container);
    assert.equal(start.value, "23:30");
    assert.equal(end.value, "01:00");

    fireEvent.change(end, { target: { value: "01:15" } });
    await settle();
    fireEvent.click(buttonNamed(view.container, "Save")!);
    await settle();

    const post = await eventually(() => {
      const [found] = windowPosts(server);
      assert.ok(found, "nothing was POSTed");
      return found;
    });
    // 01:15 on Sunday the 22nd in Chicago — not on the service date, the 21st,
    // which would put the end a day before the start.
    assert.deepEqual(post!.body, { serviceKey: KEY, endedAt: "2026-11-22T07:15:00.000Z" });
  });

  test("an item's corrected time is read in the app zone too", async () => {
    const server = installFetch(EVENING);
    const view = await openEditTimes(server);

    const ended = view.container.querySelector<HTMLInputElement>('input[aria-label="Ended — Welcome"]')!;
    assert.equal(ended.value, "18:10:00");
    fireEvent.change(ended, { target: { value: "18:12:00" } });
    await settle();
    fireEvent.click(view.container.querySelector<HTMLButtonElement>('button[aria-label="Save times — Welcome"]')!);
    await settle();

    const post = await eventually(() => {
      const found = server.posts.find((p) => p.url === "/api/history/item-times");
      assert.ok(found, "nothing was POSTed");
      return found;
    });
    assert.equal(post!.body.endedAt, "2026-11-23T00:12:00.000Z");
    assert.equal(post!.body.startedAt, null, "the untouched Started was sent as a change");
  });

  test("a window the server says would delete data is sent again only once confirmed", async () => {
    const server = installFetch(EVENING, { refuse: true });
    const view = await openEditTimes(server);

    fireEvent.change(windowFields(view.container).end, { target: { value: "18:05" } });
    await settle();
    fireEvent.click(buttonNamed(view.container, "Save")!);
    await settle();

    const dialog = await eventually(() => {
      const found = document.querySelector('[role="alertdialog"], [role="dialog"]');
      assert.ok(found, "the refusal was not put to the operator");
      return found;
    });
    assert.match(text(dialog!), /would delete 1 timeline item/);
    assert.equal(windowPosts(server).length, 1, "it was sent again before anyone confirmed");

    fireEvent.click(buttonNamed(dialog!, "Trim")!);
    await settle();
    await settle();

    const resent = await eventually(() => {
      const found = windowPosts(server)[1];
      assert.ok(found, "confirming did not send it again");
      return found;
    });
    assert.deepEqual(resent!.body, { serviceKey: KEY, endedAt: "2026-11-23T00:05:00.000Z", trim: true });
  });
});
