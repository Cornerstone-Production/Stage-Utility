// /stageplots, read-only, through the real component and the real hook, over a
// stubbed GET /api/stageplots and a fake event stream.
//
// What is NOT here, because jsdom loads no stylesheet and measures every
// element as 0 by 0: pinch zoom and drag pan (usePanZoom reads the frame's
// size to turn pixels into plot units), the plot paper and grid colours, the
// 390 px phone layout and its lack of horizontal scroll, where a tap's details
// sit beside the item (they are placed from measured boxes), and the switch to
// a bottom sheet under 640 px (a CSS breakpoint), and the printed page itself
// (one landscape page; print media and @page need a real browser's PDF). Those are driven in a
// browser; the pan and zoom geometry itself is unit-tested in use-pan-zoom.test.ts.
//
// Every name below is invented. This is a public repository.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import type { StagePlotsView } from "@main/types/stageplots";
import type { PatchFile } from "@main/types/patch";

import { installRenderDom, settle, unmountAndTeardown } from "../test-dom.js";
import { FakeEventSource } from "../test-fixtures/fake-event-source.js";

const teardown = installRenderDom();
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

let DOC: StagePlotsView;
/** The app's time zone, as GET /api/state reports it. */
let TIMEZONE: string | null = null;
/** The server's own clock's zone, as GET /api/state reports it. */
let HOST_TIMEZONE = "UTC";
/** What GET /api/stageplots/patch answers; null is a 503, the patch unreadable. */
let PATCH: PatchFile | null = null;
(globalThis as unknown as { fetch: unknown }).fetch = async (url: unknown) => {
  const path = String(url).split("?")[0];
  if (path === "/api/stageplots/patch" && PATCH === null) return { ok: false, status: 503, statusText: "Service Unavailable", json: async () => ({ error: "patch.json could not be read (EIO)" }), text: async () => "" };
  const body = path === "/api/stageplots" ? DOC : path === "/api/stageplots/patch" ? PATCH : path === "/api/state" ? { timezone: TIMEZONE, hostTimezone: HOST_TIMEZONE } : null;
  return { ok: true, status: 200, statusText: "OK", json: async () => body, text: async () => JSON.stringify(body) };
};

const { render, cleanup, screen, fireEvent, within } = await import("@testing-library/react");
const React = (await import("react")).default;
const { act } = await import("react");
const { StagePlotsPage, LAST_VENUE_KEY } = await import("./stageplots-view.js");
const { PrintSheet, printedDate, printLayout, legendLines } = await import("./stageplots-print.js");
const { __resetForTests: resetStageState } = await import("./use-stage-state.js");
const { __resetReplayCacheForTests: resetReplayCache } = await import("../lib/api.js");
const { isOperatorPath } = await import("@main/services/routes/operator-paths");
const { DESTINATIONS, NAV_GROUPS } = await import("../app/destinations.js");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createRootRoute, createRoute, createRouter, createMemoryHistory, RouterProvider } = await import("@tanstack/react-router");

const background = {
  id: "b-1",
  name: "Plan",
  original: { hash: "0123456789abcdef", mime: "image/png" as const, bytes: 1000 },
  source: { hash: "0123456789abcdef", ext: "png" as const },
  converted: { hash: "fedcba9876543210", width: 2400, height: 1600, bytes: 300_000 },
  cleanup: true,
  pdfPage: null,
  pdfPages: null,
  url: "/stageplot-images/fedcba9876543210.webp",
  sourceUrl: "/stageplot-images/0123456789abcdef.png",
};

function doc(): StagePlotsView {
  return {
    venues: [
      { id: "v-off", name: "Hall Away", kind: "offsite", notes: "", plotIds: ["p-hall"], defaultPlotId: "p-hall" },
      { id: "v-main", name: "Room One", kind: "home", notes: "Load in at the side.", plotIds: ["p-std", "p-alt"], defaultPlotId: "p-alt" },
      { id: "v-small", name: "Room Two", kind: "home", notes: "", plotIds: [], defaultPlotId: null },
    ],
    backgrounds: [background],
    plots: [
      { id: "p-std", venueId: "v-main", name: "Standard", backgroundId: "b-1", bgFade: 0.4, items: [], version: 0 },
      { id: "p-alt", venueId: "v-main", name: "Special", backgroundId: null, bgFade: 0.4, items: [], version: 0 },
      { id: "p-hall", venueId: "v-off", name: "Setup", backgroundId: "b-1", bgFade: 0.2, items: [], version: 0 },
    ],
    overrides: [],
    pendingRemovals: [],
  };
}

async function mount() {
  await act(async () => {
    // The page reads the upcoming plans through react-query, as in the app.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    render(React.createElement(QueryClientProvider, { client }, React.createElement(StagePlotsPage)));
  });
  await settle();
  await settle();
}

const venueNames = () => within(screen.getByTestId("venue-list")).getAllByRole("button").map((b) => b.querySelector("b")?.textContent);
const tabs = () => screen.getAllByRole("tab");

beforeEach(() => {
  DOC = doc();
  PATCH = { updatedAt: "", sheets: [] };
  TIMEZONE = null;
  HOST_TIMEZONE = "UTC";
  localStorage.clear();
  window.history.replaceState(null, "", "/stageplots");
});
afterEach(async () => {
  cleanup();
  await settle();
  resetReplayCache();
  // The print sheet reads the app's time zone from the shared stage state.
  resetStageState();
});
after(() => unmountAndTeardown(cleanup, teardown));

/** The page under a real router, so the address it writes can be read back. */
async function mountAt(url: string) {
  const root = createRootRoute({});
  const route = createRoute({ getParentRoute: () => root, path: "/stageplots", component: StagePlotsPage });
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: [url] }) });
  await act(async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    render(React.createElement(QueryClientProvider, { client }, React.createElement(RouterProvider, { router } as never)));
  });
  for (let i = 0; i < 4; i++) await settle();
  return router;
}
const venueInAddress = (router: Awaited<ReturnType<typeof mountAt>>) => (router.state.location.search as { venue?: unknown }).venue;

describe("/stageplots: the venue's address", () => {
  test("opening a venue from its card writes ?venue=, and the back link removes it", async () => {
    const router = await mountAt("/stageplots");
    assert.equal(venueInAddress(router), undefined);
    fireEvent.click(screen.getByText("Hall Away"));
    await settle();
    await settle();
    assert.equal(venueInAddress(router), "v-off");
    fireEvent.click(screen.getByRole("button", { name: "Stage plots" }));
    await settle();
    await settle();
    assert.ok(screen.getByTestId("venue-list"));
    assert.equal(venueInAddress(router), undefined);
  });

  test("a venue opened on its own, as the only home venue, writes ?venue=", async () => {
    DOC.venues = DOC.venues.filter((v) => v.id !== "v-small");
    const router = await mountAt("/stageplots");
    assert.equal(screen.getByRole("heading", { level: 1 }).textContent, "Room One");
    assert.equal(venueInAddress(router), "v-main");
  });

  test("the remembered venue, once opened, writes ?venue=", async () => {
    localStorage.setItem(LAST_VENUE_KEY, "v-off");
    const router = await mountAt("/stageplots");
    assert.equal(venueInAddress(router), "v-off");
  });
});

describe("/stageplots", () => {
  test("lists home venues before offsite, under their headings", async () => {
    await mount();
    assert.deepEqual(venueNames(), ["Room One", "Room Two", "Hall Away"]);
    const list = screen.getByTestId("venue-list");
    assert.ok(list.textContent!.indexOf("Home") < list.textContent!.indexOf("Offsite"));
    const summaries = [...list.querySelectorAll("small")].map((el) => el.textContent);
    assert.deepEqual(summaries, ["2 plots · Default · no background", "No plots yet", "1 plot · Default"], "Room One's default has no background, and its card says so");
    assert.equal(list.querySelector("small .font-mono")?.textContent, "2", "the count is in Plex Mono");
  });

  test("one home venue opens directly", async () => {
    DOC.venues = DOC.venues.filter((v) => v.id !== "v-small");
    await mount();
    assert.equal(screen.getByRole("heading", { level: 1 }).textContent, "Room One");
    assert.equal(screen.queryByTestId("venue-list"), null);
  });

  test("the default plot tab is selected and labelled Default; another tab drops the badge", async () => {
    await mount();
    fireEvent.click(screen.getByText("Room One"));
    await settle();
    assert.deepEqual(tabs().map((t) => t.textContent), ["Standard", "SpecialDefault"]);
    assert.equal(tabs()[1].getAttribute("aria-selected"), "true");
    assert.ok(screen.getByText("Default", { selector: "h1 + span" }), "the heading's Default badge");
    assert.ok(screen.getByText("Load in at the side."), "the venue's notes");
    fireEvent.click(tabs()[0]);
    await settle();
    assert.equal(tabs()[0].getAttribute("aria-selected"), "true");
    assert.equal(screen.queryByText("Default", { selector: "h1 + span" }), null);
  });

  test("a plot with no background draws the grid, one with a background draws it faded", async () => {
    await mount();
    fireEvent.click(screen.getByText("Room One"));
    await settle();
    const plot = () => screen.getByRole("img", { name: /Stage plot/ });
    assert.ok(plot().querySelector('[data-testid="plot-grid"]'));
    assert.equal(plot().querySelector('[data-testid="plot-background"]'), null);
    assert.equal(plot().getAttribute("viewBox"), "0 0 1000 562.5");
    fireEvent.click(tabs()[0]);
    await settle();
    const image = plot().querySelector('[data-testid="plot-background"]')!;
    assert.equal(image.getAttribute("href"), background.url);
    assert.equal(image.getAttribute("opacity"), "0.66");
    assert.equal(plot().getAttribute("viewBox"), "0 0 1000 666.6666666666666");
    assert.ok(plot().querySelector("[data-items]"), "no items layer");
  });

  test("a stageplots:updated event redraws without a reload", async () => {
    await mount();
    fireEvent.click(screen.getByText("Room One"));
    await settle();
    const renamed = doc();
    renamed.plots[0].name = "Renamed";
    renamed.venues[1].defaultPlotId = "p-std";
    await act(async () => {
      FakeEventSource.last!.push("stageplots:updated", renamed);
    });
    await settle();
    assert.deepEqual(tabs().map((t) => t.textContent), ["RenamedDefault", "Special"]);
  });

  test("a read that lands after a broadcast does not put the older document back", async () => {
    // The read is held until after a change has been broadcast; the read's
    // answer was built before that change, so the change must stand.
    const real = globalThis.fetch;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const older = doc();
    (globalThis as unknown as { fetch: unknown }).fetch = async (url: unknown) => {
      if (String(url).split("?")[0] !== "/api/stageplots") return real(url as string);
      await held;
      return { ok: true, status: 200, statusText: "OK", json: async () => older, text: async () => JSON.stringify(older) };
    };
    try {
      await mount();
      const newer = doc();
      newer.venues[2].name = "Room Two Renamed";
      await act(async () => {
        FakeEventSource.last!.push("stageplots:updated", newer);
      });
      await settle();
      await act(async () => release());
      await settle();
      await settle();
      assert.deepEqual(venueNames(), ["Room One", "Room Two Renamed", "Hall Away"]);
    } finally {
      (globalThis as unknown as { fetch: unknown }).fetch = real;
    }
  });

  test("the last venue opened is remembered, and Back forgets it", async () => {
    await mount();
    fireEvent.click(screen.getByText("Hall Away"));
    await settle();
    assert.equal(localStorage.getItem(LAST_VENUE_KEY), "v-off");
    cleanup();
    await mount();
    assert.equal(screen.getByRole("heading", { level: 1 }).textContent, "Hall Away");
    fireEvent.click(screen.getByRole("button", { name: "Stage plots" }));
    await settle();
    assert.ok(screen.getByTestId("venue-list"));
    assert.equal(localStorage.getItem(LAST_VENUE_KEY), null);
  });

  test("a remembered venue that is gone shows the list", async () => {
    localStorage.setItem(LAST_VENUE_KEY, "v-deleted");
    await mount();
    assert.ok(screen.getByTestId("venue-list"));
  });

  test("an empty venue offers Add a plot, to the editor on that venue", async () => {
    await mount();
    fireEvent.click(screen.getByText("Room Two"));
    await settle();
    assert.ok(screen.getByText("No plots yet"));
    const add = screen.getByRole("link", { name: "Add a plot" });
    assert.equal(add.getAttribute("href"), "/stageplots/edit?venue=v-small");
  });

  test("?venue= opens that venue over the remembered one", async () => {
    localStorage.setItem(LAST_VENUE_KEY, "v-main");
    window.history.replaceState(null, "", "/stageplots?venue=v-off");
    await mount();
    assert.equal(screen.getByRole("heading", { level: 1 }).textContent, "Hall Away");
  });

  test("?venue= naming no venue shows the list", async () => {
    window.history.replaceState(null, "", "/stageplots?venue=v-gone");
    await mount();
    assert.ok(screen.getByTestId("venue-list"));
  });

  test("a failed read says so instead of showing no venues", async () => {
    const real = globalThis.fetch;
    (globalThis as unknown as { fetch: unknown }).fetch = async () => ({ ok: false, status: 500, statusText: "Server Error", json: async () => ({ error: "boom" }), text: async () => "boom" });
    try {
      await mount();
      assert.equal(screen.getByRole("alert").textContent, "Couldn't load the stage plots.");
      assert.equal(screen.queryByText("No venues yet"), null);
    } finally {
      (globalThis as unknown as { fetch: unknown }).fetch = real;
    }
  });

  test("/stageplots is an operator page in the rail's Content group", () => {
    assert.ok(isOperatorPath("/stageplots"));
    assert.ok(isOperatorPath("/stageplots/edit"));
    assert.ok(DESTINATIONS.some((d) => d.path === "/stageplots" && d.label === "Stage plots"));
    assert.ok(NAV_GROUPS.find((g) => g.label === "Content")?.paths.includes("/stageplots"));
  });
});

describe("/stageplots: an item's details, the legend and print", () => {
  type Item = StagePlotsView["plots"][number]["items"][number];
  const item = (over: Partial<Item> & Pick<Item, "id" | "type">): Item => ({ x: 100, y: 100, w: 25, h: 25, rotation: 0, label: "", color: null, notes: "", inputs: [], ...over });
  const marked = (): Item[] => [
    item({ id: "fp3", type: "conn", label: "FP-3", color: "#12a594", notes: "Floor pocket, stage left.", inputs: ["Keys L", "Keys R", "Click"] }),
    item({ id: "w1", type: "symbol", symbol: "wedge", label: "Floor wedge", color: "#f76b15", x: 300 }),
    item({ id: "w2", type: "symbol", symbol: "wedge", label: "Floor wedge", color: "#f76b15", x: 400 }),
    item({ id: "c1", type: "text", textKind: "callout", label: "Riser skirt faces the room", x: 500 }),
  ];
  const plotSvg = () => screen.getByRole("img", { name: /Stage plot/ });
  const press = async (target: Element, dx = 0) => {
    await act(async () => {
      fireEvent.pointerDown(target, { pointerId: 1, clientX: 10, clientY: 10, button: 0 });
      fireEvent.pointerUp(target, { pointerId: 1, clientX: 10 + dx, clientY: 10, button: 0 });
    });
    await settle();
  };

  async function openMarked() {
    DOC.plots[1].items = marked();
    await mount();
    fireEvent.click(screen.getByText("Room One"));
    await settle();
  }

  test("tapping FP-3 lists its three inputs", async () => {
    await openMarked();
    await press(plotSvg().querySelector('[data-id="fp3"] rect')!);
    const details = screen.getByTestId("item-details");
    assert.match(details.textContent!, /^FP-3Connection pointFloor pocket, stage left\.Inputs/);
    assert.deepEqual([...within(details).getAllByRole("listitem")].map((li) => li.textContent), ["1Keys L", "2Keys R", "3Click"]);
    assert.ok(plotSvg().querySelector('[data-id="fp3"] rect[fill="none"]'), "the tapped item is not ringed");
    // A tap on the empty plot closes it; a tap on text opens nothing.
    await press(plotSvg().querySelector("rect")!);
    assert.ok(screen.queryByTestId("item-details") === null);
    await press(plotSvg().querySelector('[data-id="c1"] circle')!);
    assert.ok(screen.queryByTestId("item-details") === null);
    // A press off the plot closes it too (on a phone the sheet covers the legend).
    await press(plotSvg().querySelector('[data-id="fp3"] rect')!);
    await act(async () => {
      fireEvent.pointerDown(within(screen.getByTestId("item-details")).getByText("Keys L"), { pointerId: 2 });
    });
    assert.ok(screen.queryByTestId("item-details") !== null, "a press inside the details closed them");
    await act(async () => {
      fireEvent.pointerDown(screen.getByTestId("legend"), { pointerId: 2 });
    });
    assert.ok(screen.queryByTestId("item-details") === null, "a press off the plot left the details open");
  });

  test("a cancelled press does not swallow the next tap", async () => {
    await openMarked();
    const target = plotSvg().querySelector('[data-id="fp3"] rect')!;
    await act(async () => {
      fireEvent.pointerDown(target, { pointerId: 1, clientX: 10, clientY: 10, button: 0 });
      fireEvent.pointerCancel(target, { pointerId: 1, clientX: 10, clientY: 10 });
    });
    await press(target);
    assert.ok(screen.queryByTestId("item-details") !== null, "the tap after a cancelled press opened nothing");
  });

  test("a press that moves is a pan, not a tap", async () => {
    await openMarked();
    await press(plotSvg().querySelector('[data-id="fp3"] rect')!, 30);
    assert.ok(screen.queryByTestId("item-details") === null);
  });

  test("the legend under the plot groups the two wedges and keys the callout", async () => {
    await openMarked();
    const legend = screen.getByTestId("legend");
    assert.deepEqual([...legend.querySelectorAll('[data-testid="legend-row"]')].map((r) => r.textContent), ["FP-3", "Floor wedge×2"]);
    assert.deepEqual([...legend.querySelectorAll('[data-testid="callout-key"]')].map((r) => r.textContent), ["1Riser skirt faces the room"]);
  });

  test("the print layout has the legend, the callout key and the connection points", async () => {
    let printed = 0;
    (window as unknown as { print: () => void }).print = () => void printed++;
    await openMarked();
    assert.ok(screen.queryByTestId("print-page") === null, "the sheet is on the page before printing");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Print" }));
    });
    await settle();
    assert.equal(printed, 1);
    const page = screen.getByTestId("print-page");
    assert.ok(page.parentElement === document.body, "the sheet is not on <body>, where the print rules expect it");
    assert.match(page.querySelector("h1")!.textContent!, /^Room One · Special$/);
    assert.match(page.querySelector("header p")!.textContent!, /^Default plotPrinted /);
    assert.deepEqual([...page.querySelectorAll('[data-testid="legend-row"]')].map((r) => r.textContent), ["FP-3", "Floor wedge×2"]);
    assert.deepEqual([...page.querySelectorAll('[data-testid="callout-key"]')].map((r) => r.textContent), ["1Riser skirt faces the room"]);
    assert.equal(page.querySelector('[data-testid="print-connections"]')?.textContent, "FP-3 Keys L, Keys R, Click");
    assert.ok(page.querySelector('svg [data-id="fp3"]'), "the plot is not on the page");
    await act(async () => {
      window.dispatchEvent(new window.Event("afterprint"));
    });
    assert.ok(screen.queryByTestId("print-page") === null, "the sheet stayed after printing");
  });

  test("the printed date uses the app time zone", async () => {
    // 12:00 UTC on Thursday 12 November is already Friday 13 in UTC+14, and
    // still Thursday on any host clock from UTC-11 to UTC+11.
    const noonUtc = Date.UTC(2026, 10, 12, 12);
    assert.equal(printedDate(noonUtc, "Pacific/Kiritimati"), "Fri 13 Nov 2026");
    assert.equal(printedDate(noonUtc, "UTC"), "Thu 12 Nov 2026");
    TIMEZONE = "Pacific/Kiritimati";
    await act(async () => {
      render(React.createElement(PrintSheet, { venueName: "Room One", plotName: "Standard", planLine: null, items: [], background: null, fade: 0.4, now: noonUtc }));
    });
    await settle();
    assert.equal(screen.getByTestId("print-page").querySelector("header p")!.textContent, "Printed Fri 13 Nov 2026");
  });

  test("with no zone set, the printed date follows the server's clock, not the browser's", async () => {
    // The app reasons in its host's zone when none is configured (appTimeZone),
    // so a server in UTC+14 has already reached Friday whatever the browser says.
    const noonUtc = Date.UTC(2026, 10, 12, 12);
    HOST_TIMEZONE = "Pacific/Kiritimati";
    await act(async () => {
      render(React.createElement(PrintSheet, { venueName: "Room One", plotName: "Standard", planLine: null, items: [], background: null, fade: 0.4, now: noonUtc }));
    });
    await settle();
    assert.equal(screen.getByTestId("print-page").querySelector("header p")!.textContent, "Printed Fri 13 Nov 2026");
  });

  test("a long legend goes beside the plot in up to two columns, then onto a second page", () => {
    assert.deepEqual(printLayout(10), { columns: 1, secondPage: false });
    assert.deepEqual(printLayout(50), { columns: 2, secondPage: false });
    assert.deepEqual(printLayout(60), { columns: 4, secondPage: true });
  });

  test("a connection point with a long input list counts as the lines it wraps to", () => {
    const boxes = [1, 2, 3].map((n) => item({ id: `sb${n}`, type: "conn", label: `SB-${n}`, inputs: Array.from({ length: 30 }, (_, i) => `Input ${i + 1}`) }));
    // "SB-1 Input 1, ..., Input 30" is 294 characters: ten lines of a column, not one.
    assert.equal(legendLines(boxes), 3 + 3 * 10 + 3, `three 30-input stage boxes counted as ${legendLines(boxes)} lines`);
    assert.deepEqual(printLayout(legendLines(boxes)), { columns: 2, secondPage: false });
    const six = [...boxes, ...[4, 5, 6].map((n) => ({ ...boxes[0], id: `sb${n}`, label: `SB-${n}` }))];
    assert.equal(printLayout(legendLines(six)).secondPage, true, "six 30-input stage boxes still fit beside the plot");
    assert.equal(legendLines([item({ id: "p", type: "conn", label: "FP-3", inputs: ["Keys L"] })]), 2 + 3);
  });
});

describe("/stageplots: a connection point linked to the patch", () => {
  type Item = StagePlotsView["plots"][number]["items"][number];
  const sb1 = (): Item => ({
    id: "sb1",
    type: "conn",
    x: 100,
    y: 100,
    w: 25,
    h: 25,
    rotation: 0,
    label: "Old SB",
    color: null,
    notes: "Stage box.",
    inputs: ["Own input"],
    patchLink: { sheetId: "main", deviceId: "dev-sb1", lastName: "Old SB", lastColor: null },
  });
  const patchFile = (): PatchFile => ({
    updatedAt: "",
    sheets: [
      {
        id: "main",
        name: "Main patch",
        kind: "analog",
        devices: [
          { id: "rack", name: "Rack A", kind: "rack", inputs: 32, outputs: 0 },
          { id: "dev-sb1", name: "SB-1", kind: "snake", inputs: 16, outputs: 4, color: "#0091ff" },
        ],
        endpoints: [
          { rackId: "rack", dir: "in", index: 1, consoleChannel: "1", label: "Kick In", path: [{ deviceId: "dev-sb1", connector: "1" }] },
          { rackId: "rack", dir: "in", index: 2, consoleChannel: "2", label: "Kick Out", path: [{ deviceId: "dev-sb1", connector: "2" }] },
        ],
        variants: [],
        assignments: { byServiceType: {}, byPlan: {} },
      },
    ],
  });
  const plotSvg = () => screen.getByRole("img", { name: /Stage plot/ });
  async function tapSb1() {
    const target = plotSvg().querySelector('[data-id="sb1"] rect')!;
    await act(async () => {
      fireEvent.pointerDown(target, { pointerId: 1, clientX: 10, clientY: 10, button: 0 });
      fireEvent.pointerUp(target, { pointerId: 1, clientX: 10, clientY: 10, button: 0 });
    });
    await settle();
    return screen.getByTestId("item-details");
  }
  async function open() {
    DOC.plots[1].items = [sb1()];
    await mount();
    fireEvent.click(screen.getByText("Room One"));
    await settle();
  }

  test("tapping a linked point lists its channels, under the device's name and colour", async () => {
    PATCH = patchFile();
    await open();
    const details = await tapSb1();
    assert.match(details.textContent!, /^SB-1Connection pointStage box\.Patch channels · Main patch/);
    assert.deepEqual([...within(details).getAllByRole("listitem")].map((li) => li.textContent), ["Ch 1Kick InSB-1/1", "Ch 2Kick OutSB-1/2"]);
    assert.equal(screen.queryByTestId("item-inputs"), null, "the point's own inputs were listed beside its patch channels");
    assert.deepEqual([...screen.getByTestId("legend").querySelectorAll('[data-testid="legend-row"]')].map((r) => r.textContent), ["SB-1"]);
    // A rename in the patch reaches the page on its broadcast.
    const next = patchFile();
    next.sheets[0]!.devices[1]!.name = "SB-1 Left";
    await act(async () => FakeEventSource.last?.push("patch:updated", next));
    await settle();
    assert.match(screen.getByTestId("item-details").textContent!, /^SB-1 Left/);
  });

  test("an unlinked point lists its inputs: the patch unreadable keeps its last name", async () => {
    PATCH = null;
    await open();
    const details = await tapSb1();
    assert.match(details.textContent!, /^Old SBConnection point/);
    assert.deepEqual([...within(details).getAllByRole("listitem")].map((li) => li.textContent), ["1Own input"]);
    assert.equal(screen.queryByTestId("patch-channels"), null);
  });
});
