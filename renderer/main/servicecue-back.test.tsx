// servicecue-back.test.tsx — a rundown's back arrow returns to the launcher it
// was opened from.
//
// The arrow was a hard-coded `/servicecue`, the tablet's chromeless launcher. An
// operator who opened a rundown from ServiceCue in the sidebar (`/servicecue/manage`)
// pressed it and lost the sidebar.
//
// Driven through the app's REAL route table (ALL_DESTINATIONS and NESTED_ROUTES),
// under a bare root so the shell's live wiring, whose SSE loop never settles, is
// not mounted. The links between these pages are plain anchors — document loads —
// and jsdom does not follow an anchor, so each hop here reads the anchor's href
// and opens it in a FRESH router, which is what a document load is: a new page at
// that address with nothing carried over but the address. That is the property
// the fix leans on, and it is why a reload is the same operation as a click.
//
// What jsdom cannot see: whether the sidebar is on screen. Chromelessness is
// asserted through isSharedChromelessPath, the function the shell asks; the
// pictures are in the browser run.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { FakeEventSource } from "../test-fixtures/fake-event-source.js";
import { eventually, installRenderDom, settle, unmountAndTeardown } from "../test-dom.js";
import { ok, stubFetchWithLog } from "../test-fixtures/fetch-log.js";

const teardown = installRenderDom();

(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

const { render, screen, cleanup, act, fireEvent } = await import("@testing-library/react");
const React = await import("react");
const { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } = await import(
  "@tanstack/react-router"
);
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { TooltipProvider } = await import("../components/ui/index.js");
const { ALL_DESTINATIONS, NESTED_ROUTES } = await import("../app/destinations.js");
const { isSharedChromelessPath } = await import("../app/active-page.js");
const { parseOrigin, withOrigin } = await import("../lib/back-target.js");
const { __resetForTests: resetStageState } = await import("./use-stage-state.js");
const { __resetReplayCacheForTests: resetReplayCache } = await import("../lib/api.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => {
  cleanup();
  resetStageState();
  resetReplayCache();
});

const RUNDOWN: ServiceCueRundownDTO = {
  serviceTypeId: "st1",
  planId: "p1",
  planTitle: "Sunday",
  planSeriesTitle: null,
  planDates: null,
  items: [],
  noteCategories: [],
  serviceTimes: [],
  timeZone: null,
  isActivePlan: false,
  isDefaultPlan: true,
};

function stubFetch() {
  return stubFetchWithLog((url) => {
    if (url.includes("/api/service-types")) return ok([{ id: "st1", name: "Weekend" }]);
    if (url.includes("/api/servicecue/layouts")) return ok([{ id: "svl1", name: "Audio", order: 0, columnRoles: ["r1"] }]);
    if (url.includes("/api/servicecue/roles")) return ok([{ id: "r1", name: "Sound", members: ["Audio"] }]);
    if (url.includes("/api/servicecue/config")) return ok({ serviceTypeIds: ["st1"] });
    if (url.includes("/api/servicecue/rundown")) return ok(RUNDOWN);
    if (url.includes("/api/pco/live")) return ok(null);
    if (url.includes("/api/state")) return ok({ pcoConfigured: true });
    return ok({});
  });
}

/**
 * A page load at `href`: a new router over the app's own pages, a new document.
 * Nothing but the address crosses from the previous page.
 */
async function loadPage(href: string) {
  cleanup();
  const root = createRootRoute({ component: Outlet });
  const pages = [...ALL_DESTINATIONS, ...NESTED_ROUTES].filter((r) => r.path.startsWith("/servicecue"));
  const router = createRouter({
    routeTree: root.addChildren(
      pages.map((r) => createRoute({ getParentRoute: () => root, path: r.path, component: r.Component })),
    ),
    history: createMemoryHistory({ initialEntries: [href] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(TooltipProvider, null, React.createElement(RouterProvider, { router })),
    ),
  );
  await settle();
  await settle();
  await settle();
  return router;
}

/** The address a link on the page leads to, read the way a browser would follow it. */
async function hrefOf(name: string): Promise<string> {
  const link = await eventually(() => screen.getByRole("link", { name }));
  return link.getAttribute("href") ?? "";
}

/** The page you land on after pressing a rundown's back arrow, from `rundownHref`. */
async function pressBackFrom(rundownHref: string) {
  await loadPage(rundownHref);
  const back = await hrefOf("All services");
  const landed = await loadPage(back);
  return { back, landed };
}

test("opened from the operator's launcher in the shell, back returns to it, with the shell's chrome", async () => {
  const f = stubFetch();
  try {
    await loadPage("/servicecue/manage");
    const open = await hrefOf("Open Weekend");
    assert.equal(open, "/servicecue/weekend/audio?from=%2Fservicecue%2Fmanage", "the launcher names itself as the page you came from");

    const { back, landed } = await pressBackFrom(open);
    assert.equal(back, "/servicecue/manage");
    assert.equal(landed.state.location.pathname, "/servicecue/manage");
    assert.equal(isSharedChromelessPath(landed.state.location.pathname), false, "the page it lands on has the shell's chrome");
    await hrefOf("Open Weekend");
  } finally {
    f.restore();
  }
});

test("opened from the volunteer launcher, back returns to the volunteer launcher", async () => {
  const f = stubFetch();
  try {
    await loadPage("/servicecue");
    const open = await hrefOf("Open Weekend");

    const { back, landed } = await pressBackFrom(open);
    assert.equal(back, "/servicecue");
    assert.equal(landed.state.location.pathname, "/servicecue");
    assert.equal(isSharedChromelessPath(landed.state.location.pathname), true);
  } finally {
    f.restore();
  }
});

test("opened directly, with no origin in the address, back goes to the volunteer launcher", async () => {
  const f = stubFetch();
  try {
    const { back, landed } = await pressBackFrom("/servicecue/weekend/audio");
    assert.equal(back, "/servicecue");
    assert.equal(landed.state.location.pathname, "/servicecue");
  } finally {
    f.restore();
  }
});

test("a reload of the rundown, and a change of layout or text size on it, all keep the origin", async () => {
  const f = stubFetch();
  try {
    const rundown = "/servicecue/weekend/audio?from=%2Fservicecue%2Fmanage&plan=p1";
    // A reload is a page load at the same address.
    await loadPage(rundown);
    assert.equal(await hrefOf("All services"), "/servicecue/manage");

    // The page's own navigation: pick another layout, which keeps the query.
    const router = await loadPage(rundown);
    const select = await eventually(() => screen.getByRole("combobox", { name: "Layout" }) as HTMLSelectElement);
    await act(async () => { fireEvent.change(select, { target: { value: "__all__" } }); });
    await eventually(() => assert.equal(router.state.location.pathname, "/servicecue/weekend/all-columns"));
    assert.equal(await hrefOf("All services"), "/servicecue/manage", "changing layout did not drop the origin");

    // And the text size, which rewrites the address in place.
    const sized = await loadPage("/servicecue/weekend/audio?from=%2Fservicecue%2Fmanage&text=100");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Larger text" })); });
    await eventually(() => assert.notEqual(sized.state.location.search.text, 100, "the size changed"));
    assert.equal(sized.state.location.search.from, "/servicecue/manage", "changing the text size did not drop the origin");
    assert.equal(await hrefOf("All services"), "/servicecue/manage");
  } finally {
    f.restore();
  }
});

test("an origin that is not a path in this app is ignored, not followed", async () => {
  const f = stubFetch();
  try {
    for (const from of ["//evil.example", "https://evil.example", "/\\evil.example", "javascript:alert(1)", "/a b", "/x?y=1", ""]) {
      await loadPage(`/servicecue/weekend/audio?from=${encodeURIComponent(from)}`);
      assert.equal(await hrefOf("All services"), "/servicecue", `from=${from} fell back`);
    }
  } finally {
    f.restore();
  }
});

test("withOrigin and parseOrigin agree: what one writes the other reads back", () => {
  assert.equal(withOrigin("/servicecue/a/b", "/servicecue/manage"), "/servicecue/a/b?from=%2Fservicecue%2Fmanage");
  assert.equal(withOrigin("/servicecue/a/b?plan=1", "/servicecue/"), "/servicecue/a/b?plan=1&from=%2Fservicecue");
  assert.equal(parseOrigin("/servicecue/manage"), "/servicecue/manage");
  assert.equal(parseOrigin(null), null);
  assert.equal(parseOrigin("servicecue"), null);
});
