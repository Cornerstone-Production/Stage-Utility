// History → Edit times: Recalculate and the per-item counted checkbox.
//
// The server refuses an edit to a service that is still recording (409 "live"),
// whose record a recorder could not save yet (409 "unsaved"), or whose stored
// record cannot be read (503). Each answers with a reason the operator can act
// on. These two handlers used to catch the failure and show a fixed string, so
// the reason never reached the screen.
//
// Driven through the real renderer/lib/api.ts, which turns the response's
// `error` field into the thrown message: the assertion is on the toast the
// operator would read, after pressing the real control.

import { strict as assert } from "node:assert";
import { after, before, beforeEach, describe, test } from "node:test";

import { eventually, installDom, settle, unmountAndTeardown } from "../../test-dom.js";
import { FakeEventSource } from "../../test-fixtures/fake-event-source.js";
import { ok, reply } from "../../test-fixtures/fetch-log.js";

const teardown = installDom();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

const DATE = "2026-09-17";
const KEY = "st1:plan-1:t-1";

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

interface Refusal {
  status: number;
  error: string;
}

/** The recalc and counted routes answer with `refusal`; every read answers as a quiet record. */
function installFetch(refusal: Refusal) {
  (globalThis as unknown as { fetch: unknown }).fetch = async (input: string, init?: { method?: string }) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "POST" && (url === "/api/history/recalc" || url === "/api/history/item-counted")) {
      return reply(refusal.status, { error: refusal.error });
    }
    if (url === "/api/service-timeline") return ok([timeline()]);
    if (url === "/api/attendance/history?summary=1") return ok([]);
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
const { TooltipProvider, Toaster } = await import("../../components/ui/index.js");

after(() => unmountAndTeardown(cleanup, teardown));

const text = (el: HTMLElement) => (el.textContent ?? "").replace(/\s+/g, " ").trim();

/** The NEWEST toast only: toasts linger across tests in one jsdom document. */
const lastToast = () => {
  const all = [...document.querySelectorAll(".text-footnote")];
  return all.length ? text(all[all.length - 1] as HTMLElement) : "NO TOAST";
};

const buttonLater = (root: HTMLElement, label: string, why: string) =>
  eventually(() => {
    const found = [...root.querySelectorAll("button")].find((b) => text(b as HTMLElement).includes(label));
    assert.ok(found, why);
    return found as HTMLElement;
  });

describe("History: a refused edit says why", () => {
  let ServiceHistorySection: typeof import("./service-history-section.js").ServiceHistorySection;

  before(async () => {
    ({ ServiceHistorySection } = await import("./service-history-section.js"));
  });

  beforeEach(() => cleanup());

  /** Mount, open the one recording and enter Edit times. */
  async function openEditing(refusal: Refusal) {
    installFetch(refusal);
    const view = render(
      React.createElement(TooltipProvider, null, React.createElement(ServiceHistorySection), React.createElement(Toaster)),
    );
    await settle();
    await settle();
    fireEvent.click(await buttonLater(view.container, "Sunday Gathering", "the recording's row never rendered"));
    await settle();
    fireEvent.click(await buttonLater(view.container, "Edit times", "the recording never opened"));
    await settle();
    return view;
  }

  /** Wait for a toast that was not on screen when `act` began. */
  async function toastAfter(act: () => unknown) {
    const before = document.querySelectorAll(".text-footnote").length;
    const newest = lastToast();
    await act();
    await settle();
    await eventually(() =>
      assert.ok(document.querySelectorAll(".text-footnote").length > before || lastToast() !== newest, "no toast followed the press"),
    );
    return lastToast();
  }

  const REFUSALS: [string, Refusal][] = [
    ["live (409)", { status: 409, error: "That service is recording right now — it cannot be edited until it ends." }],
    ["unsaved (409)", { status: 409, error: "That service's record has not been saved yet — try again in a moment." }],
    ["unreadable (503)", { status: 503, error: "That service's record could not be read — nothing was changed." }],
  ];

  for (const [name, refusal] of REFUSALS) {
    test(`Recalculate shows the server's reason: ${name}`, async (t) => {
      const view = await openEditing(refusal);
      t.after(() => cleanup());
      const recalc = await buttonLater(view.container, "Recalculate", "Edit times never showed Recalculate");
      const shown = await toastAfter(() => fireEvent.click(recalc));
      assert.match(shown, /Recalculate failed/, `no failure toast: ${shown}`);
      assert.ok(shown.includes(refusal.error), `the reason was swallowed: ${shown}`);
    });

    test(`the counted checkbox shows the server's reason: ${name}`, async (t) => {
      const view = await openEditing(refusal);
      t.after(() => cleanup());
      const box = await eventually(() => {
        const found = view.container.querySelector('[aria-label$="the service timers"]');
        assert.ok(found, "Edit times never showed the counted checkbox");
        return found as HTMLElement;
      });
      const shown = await toastAfter(() => fireEvent.click(box));
      assert.match(shown, /Couldn't update/, `no failure toast: ${shown}`);
      assert.ok(shown.includes(refusal.error), `the reason was swallowed: ${shown}`);
    });
  }
});
