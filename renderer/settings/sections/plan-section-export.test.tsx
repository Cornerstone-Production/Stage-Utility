// The Export plan… button on the Plan page, and what its dialog opens ON.
//
// The dialog seeds its service type picker from props when it MOUNTS. Mounted
// permanently beside the button, it seeded once, with whatever plan the machine
// was on when the page rendered — and a page left open across a plan change
// opened the dialog on last week's type. Mounting it only while open is the
// fix, and this is the guard: the page renders on one type, the machine moves
// to another, the button is pressed, and the dialog must ask the server about
// the CURRENT type.
//
// Nothing below passes a DOM node to assert.

import assert from "node:assert/strict";
import { test, after, afterEach } from "node:test";
import { installDom } from "../../test-dom.js";

const teardown = installDom();

const { render, screen, cleanup, fireEvent, act } = await import("@testing-library/react");
const React = await import("react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");

afterEach(cleanup);
after(() => {
  cleanup();
  teardown();
});

const { PlanSection } = await import("./plan-section.js");

test("the export dialog opens on the type the machine is on now, not the one the page mounted on", async () => {
  const asked: string[] = [];
  const beforeFetch = globalThis.fetch;
  const beforeTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  globalThis.fetch = (async (input: unknown) => {
    asked.push(String(input));
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        serviceTypeName: "Youth",
        views: 1, boards: 1, rows: 3, patchVariants: [], presets: 0, scriptviewLayouts: 0,
      }),
    };
  }) as unknown as typeof fetch;

  // Every handler resolves and does nothing; the page must not need any of them
  // to open the dialog.
  const handlers = new Proxy({}, { get: () => async () => {} });
  const state = (serviceTypeId: string | null) => ({
    planMode: "auto",
    allowedServiceTypeIds: [],
    serviceTypeId,
    planTitle: null,
    planDates: null,
    planSwitcherMode: "upcoming",
    checklistSources: [],
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const page = (serviceTypeId: string | null, types: { id: string; name: string }[]) =>
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(PlanSection, {
        stageState: state(serviceTypeId) as never,
        serviceTypes: types as never,
        plans: [],
        isRefreshing: false,
        handlers: handlers as never,
      }),
    );

  try {
    const types = [{ id: "st-1", name: "Sunday" }, { id: "st-2", name: "Youth" }];
    // The page renders while the machine follows Sunday.
    const { rerender, unmount } = render(page("st-1", types));
    // Auto plan mode moves it to Youth. The page stays open.
    rerender(page("st-2", types));

    await act(async () => { fireEvent.click(screen.getByText("Export plan…")); });
    // Other panels on the page fetch too (checklist sources); only the export
    // preview says which type the dialog opened on.
    const preview = () => asked.filter((u) => u.includes("/api/plans/export/preview"));
    for (let i = 0; i < 100 && preview().length === 0; i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    }

    assert.ok(preview().length > 0, "the dialog never asked the server about any type — it opened on nothing");
    assert.match(preview()[0]!, /serviceTypeId=st-2(&|$)/, `it asked about ${preview()[0]}, not the current type`);
    unmount();
    // Let the queries that the unmount cancelled settle before the DOM goes.
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  } finally {
    client.clear();
    globalThis.fetch = beforeFetch;
    AbortSignal.timeout = beforeTimeout;
  }
});
