// /stageplots, read-only, through the real component and the real hook, over a
// stubbed GET /api/stageplots and a fake event stream.
//
// What is NOT here, because jsdom loads no stylesheet and measures every
// element as 0 by 0: pinch zoom and drag pan (usePanZoom reads the frame's
// size to turn pixels into plot units), the plot paper and grid colours, the
// 390 px phone layout and its lack of horizontal scroll. Those are driven in a
// browser; the pan and zoom geometry itself is unit-tested in use-pan-zoom.test.ts.
//
// Every name below is invented. This is a public repository.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import type { StagePlotsView } from "@main/types/stageplots";

import { installRenderDom, settle, unmountAndTeardown } from "../test-dom.js";
import { FakeEventSource } from "../test-fixtures/fake-event-source.js";

const teardown = installRenderDom();
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

let DOC: StagePlotsView;
(globalThis as unknown as { fetch: unknown }).fetch = async (url: unknown) => {
  const path = String(url).split("?")[0];
  const body = path === "/api/stageplots" ? DOC : null;
  return { ok: true, status: 200, statusText: "OK", json: async () => body, text: async () => JSON.stringify(body) };
};

const { render, cleanup, screen, fireEvent, within } = await import("@testing-library/react");
const React = (await import("react")).default;
const { act } = await import("react");
const { StagePlotsPage, LAST_VENUE_KEY } = await import("./stageplots-view.js");
const { __resetReplayCacheForTests: resetReplayCache } = await import("../lib/api.js");
const { isOperatorPath } = await import("@main/services/routes/operator-paths");
const { DESTINATIONS, NAV_GROUPS } = await import("../app/destinations.js");

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
  };
}

async function mount() {
  await act(async () => {
    render(React.createElement(StagePlotsPage));
  });
  await settle();
  await settle();
}

const venueNames = () => within(screen.getByTestId("venue-list")).getAllByRole("button").map((b) => b.querySelector("b")?.textContent);
const tabs = () => screen.getAllByRole("tab");

beforeEach(() => {
  DOC = doc();
  localStorage.clear();
});
afterEach(async () => {
  cleanup();
  await settle();
  resetReplayCache();
});
after(() => unmountAndTeardown(cleanup, teardown));

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
