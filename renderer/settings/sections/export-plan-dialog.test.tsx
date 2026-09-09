// The export dialog, rendered.
//
// What is under test is the thing an operator can get wrong without noticing:
// the Download link's query string. The checklist is only as good as the URL it
// builds — a switch that flips and a href that does not is a control that
// renders and does nothing, which is the failure this repo has shipped before.
//
// NOT unit-tested here, and driven in a real browser against a real server
// instead: that the dialog opens from the Plan page's button, that the anchor
// actually downloads (jsdom does not navigate, and has no Content-Disposition),
// and that the segmented control and the switches read as pressed — jsdom loads
// no stylesheet, so the accent fill on the chosen segment is not observable at
// all. See the commit for the requests driven and what came back.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND. node:assert builds its
// failure message by inspecting `actual`, and inspecting a live jsdom element
// does not terminate in any useful time — a sibling test file once ran 81.5 s
// and was killed with no assertion text at all.

import assert from "node:assert/strict";
import { describe, test, after, afterEach } from "node:test";
import { installDom } from "../../test-dom.js";

const teardown = installDom();

const { render, screen, cleanup, fireEvent, act } = await import("@testing-library/react");
const React = await import("react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");

afterEach(cleanup);
after(() => {
  cleanup();
  for (const c of clients) c.clear();
  teardown();
});

const { ExportPlanDialog, planExportHref } = await import("./export-plan-dialog.js");

const PREVIEW = {
  serviceTypeName: "Sunday AM",
  views: 3,
  boards: 2,
  rows: 14,
  patchVariants: [{ sheetName: "Analog", variantName: "Sunday rig" }],
  presets: 4,
  scriptviewLayouts: 1,
};

/** Every URL the dialog asked for, as STRINGS — see the note at the top. */
const asked: string[] = [];

/** The dialog reads its counts over HTTP. Answered here rather than mocked at
 *  the api layer, so the real invoke() and the real query hook both run. Every
 *  request is recorded: a preview that never refetches is invisible on screen,
 *  because the stub answers both scopes with the same body. */
function stubFetch(body: unknown, ok = true): () => void {
  asked.length = 0;
  const before = globalThis.fetch;
  // api.ts arms AbortSignal.timeout(15000) on every request. The stub never
  // reads the signal, but the TIMER outlives the test, and firing it after
  // installDom's teardown threw "parameter 1 is not of type Event" out of a
  // finished test. A controller's signal never fires and holds no timer.
  const beforeTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  globalThis.fetch = (async (url: unknown) => (asked.push(String(url)), {
    ok,
    status: ok ? 200 : 400,
    statusText: ok ? "OK" : "Bad Request",
    json: async () => body,
  })) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = before;
    AbortSignal.timeout = beforeTimeout;
  };
}

const clients: InstanceType<typeof QueryClient>[] = [];

function open(types = [{ id: "st-1", name: "Sunday AM", itemTypeColors: [] }]) {
  // gcTime 0. The default is five minutes, and react-query holds a timer for it
  // — so the node process could not exit and the whole FILE was killed at
  // 300 s ("duration_ms: 301013") in the full suite while passing on its own.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  return render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(ExportPlanDialog, {
        open: true,
        onOpenChange: () => {},
        serviceTypes: types as never,
        defaultServiceTypeId: "st-1",
      }),
    ),
  );
}

function href(): string {
  return document.querySelector('[data-testid="plan-export-download"]')?.getAttribute("href") ?? "";
}

/**
 * Poll until the Download link's query satisfies `want`.
 *
 * Polled rather than read once: the counts arrive over HTTP, and a click on a
 * switch is a React state update that has not been committed by the time the
 * click() call returns. Reading the href immediately after either read the
 * loading state or the value from before the click — which is exactly the bug
 * this file exists to catch, so it must not be the way the test passes.
 *
 * Throws a STRING message, never the element: node:assert inspecting a live
 * jsdom node does not terminate in any useful time.
 */
async function download(want: RegExp = /./): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const h = href();
    if (h && want.test(h)) return h;
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  }
  throw new Error(`the Download link never matched ${want}; it was "${href() || "absent"}"`);
}

/** A click that React has committed by the time it resolves. */
async function press(el: Element): Promise<void> {
  await act(async () => { fireEvent.click(el); });
}

describe("the download link reflects the checklist", () => {
  test("the defaults: this type's boards, the patch variant, no presets", async () => {
    const restore = stubFetch(PREVIEW);
    const { unmount } = open();
    const href = await download();
    assert.equal(href, "/api/plans/export?serviceTypeId=st-1&slots=type&patch=1&presets=0");
    unmount();
    restore();
  });

  test("turning presets on puts them in the query", async () => {
    const restore = stubFetch(PREVIEW);
    const { unmount } = open();
    await download();
    await press(screen.getByLabelText("Include the slot presets"));
    assert.match(await download(/presets=/), /presets=1/);
    unmount();
    restore();
  });

  test("turning the patch variant off takes it out", async () => {
    const restore = stubFetch(PREVIEW);
    const { unmount } = open();
    await download();
    await press(screen.getByLabelText("Include the patch sheet variant"));
    assert.match(await download(/patch=0/), /patch=0/);
    unmount();
    restore();
  });

  test("the other slots scope changes the query, not just the button", async () => {
    const restore = stubFetch(PREVIEW);
    const { unmount } = open();
    await download();
    await press(screen.getByRole("button", { name: "Every type on those views" }));
    assert.match(await download(/slots=all/), /slots=all/);
    unmount();
    restore();
  });

  test("a type with no patch variant cannot turn one on", async () => {
    // The switch is disabled AND the query says 0: a checklist row that reads as
    // on with nothing behind it would promise a section the file does not have.
    const restore = stubFetch({ ...PREVIEW, patchVariants: [] });
    const { unmount } = open();
    const href = await download();
    assert.match(href, /patch=0/);
    const sw = screen.getByLabelText("Include the patch sheet variant") as HTMLButtonElement;
    assert.equal(sw.disabled, true, "the switch is offered with nothing to include");
    unmount();
    restore();
  });
});

describe("the preview follows the slots scope", () => {
  test("flipping the segment asks the server again, for the other scope", async () => {
    // The counts differ between the two scopes. Keyed on the service type
    // alone, the query never refetched: the boards and rows line sat still
    // while the file the Download link points at grew.
    const restore = stubFetch(PREVIEW);
    const { unmount } = open();
    await download();
    const before = asked.filter((u) => u.includes("/api/plans/export/preview")).length;
    await press(screen.getByRole("button", { name: "Every type on those views" }));
    for (let i = 0; i < 200; i++) {
      if (asked.some((u) => u.includes("/api/plans/export/preview") && u.includes("slots=all"))) break;
      await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    }
    const previews = asked.filter((u) => u.includes("/api/plans/export/preview"));
    assert.equal(previews.length, before + 1, `the preview was asked ${previews.length} times: ${previews.join(", ")}`);
    assert.match(previews.at(-1)!, /slots=all/);
    unmount();
    restore();
  });

  test("the first ask carries the default scope rather than leaving it off", async () => {
    const restore = stubFetch(PREVIEW);
    const { unmount } = open();
    await download();
    assert.match(asked.find((u) => u.includes("/api/plans/export/preview"))!, /serviceTypeId=st-1&slots=type/);
    unmount();
    restore();
  });
});

describe("the counts", () => {
  test("come from the preview, so the dialog cannot disagree with the file", async () => {
    const restore = stubFetch(PREVIEW);
    const { unmount } = open();
    await download();
    // Booleans, never the node: see the note at the top of the file.
    assert.ok(!!screen.queryByText("2 boards, 14 rows"), "the board and row counts are not on screen");
    assert.ok(!!screen.queryByText("Analog: Sunday rig"), "the patch variant is not named");
    assert.ok(!!screen.queryByText(/4 saved arrangements/), "the preset count is not on screen");
    unmount();
    restore();
  });

  test("a preview that fails says so and offers no Download", async () => {
    // Downloading anyway would navigate to the same 400 the preview just got.
    const restore = stubFetch({ error: "nothing to export for Youth" }, false);
    const { unmount } = open();
    for (let i = 0; i < 200 && !screen.queryByRole("alert"); i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    }
    assert.equal(screen.queryByRole("alert")?.textContent, "nothing to export for Youth");
    assert.ok(
      !document.querySelector('[data-testid="plan-export-download"]'),
      "a Download link that navigates to a 400 is worse than none",
    );
    unmount();
    // Let the failed query finish settling before the test returns. Without it
    // node:test reports "asynchronous activity after the test ended" from inside
    // react-query's error path and fails the whole FILE.
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    restore();
  });
});

describe("the query string itself", () => {
  test("is built from the choices and nothing else", () => {
    assert.equal(
      planExportHref("st-2", { slots: "all", patch: false, presets: true }),
      "/api/plans/export?serviceTypeId=st-2&slots=all&patch=0&presets=1",
    );
  });

  test("escapes a service type id rather than pasting it in", () => {
    assert.match(planExportHref("a&b=c", { slots: "type", patch: true, presets: false }), /serviceTypeId=a%26b%3Dc/);
  });
});
