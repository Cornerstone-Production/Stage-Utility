// The published stage plots page, as a visitor with the link opens it: the venue's index
// and plots read from the Worker under the secret in the address, drawn with the same
// read-only component as /stageplots, the plot the venue showed for its plan selected and
// marked, and a tap on an item for its details.
//
// jsdom loads no stylesheet and measures nothing, so the 390 px phone layout, pinch zoom
// and the bottom sheet's place are driven in a browser against `wrangler dev`, not here.
//
// Every name below is invented. This is a public repository.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import type { PublishedPlot, PublishedVenue } from "@main/types/stageplots";

import { installRenderDom, settle } from "../test-dom.js";

installRenderDom();
(window as unknown as Record<string, unknown>).matchMedia = (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} });

const SECRET = "A".repeat(42) + "E";
let STORED: Map<string, unknown>;
let asked: string[] = [];
/** Keys that answer 500, as a read the Worker could not serve. */
let FAILING = new Set<string>();

function index(extra: Partial<PublishedVenue> = {}): PublishedVenue {
  return {
    name: "Room One",
    notes: "Side door, then left.",
    plots: [
      { id: "p-1", name: "Standard" },
      { id: "p-2", name: "Special" },
    ],
    defaultPlotId: "p-1",
    shown: { plotId: "p-2", reason: "plan" },
    plan: { date: "2026-11-15T15:00:00.000Z", dates: "November 15, 2026" },
    timeZone: "America/Chicago",
    ...extra,
  };
}

function plot(id: string, name: string, hash: string | null): PublishedPlot {
  return {
    id,
    name,
    bgFade: 0.4,
    items: [{ id: `i-${id}`, type: "box", x: 100, y: 100, w: 80, h: 60, rotation: 0, label: "Drum riser", color: null, notes: "Lock the casters.", inputs: ["Kick", "Snare"] }],
    background: { hash, width: 2400, height: 1600 },
  };
}

(globalThis as unknown as { fetch: unknown }).fetch = async (url: unknown) => {
  const path = new URL(String(url), "https://plots.example.workers.dev").pathname;
  asked.push(path);
  const prefix = `/stageplots/${SECRET}/`;
  if (path.startsWith(prefix) && FAILING.has(path.slice(prefix.length))) return { ok: false, status: 500, json: async () => ({}), text: async () => "{}" };
  const value = path.startsWith(prefix) ? STORED.get(path.slice(prefix.length)) : undefined;
  if (value === undefined) return { ok: false, status: 404, json: async () => ({ error: "Not found" }), text: async () => '{"error":"Not found"}' };
  return { ok: true, status: 200, json: async () => value, text: async () => JSON.stringify(value) };
};

const { render, cleanup, screen, fireEvent } = await import("@testing-library/react");
const React = (await import("react")).default;
const { act } = await import("react");
const { StagePlotsPublicPage, secretFromPath } = await import("./stageplots-public-page.js");

async function mount(path = `/stageplots/${SECRET}`) {
  await act(async () => {
    render(React.createElement(StagePlotsPublicPage, { path }));
  });
  for (let i = 0; i < 5; i++) await settle();
}

beforeEach(() => {
  STORED = new Map<string, unknown>([
    ["index", index()],
    ["plot/p-1", plot("p-1", "Standard", "0000000000000001")],
    ["plot/p-2", plot("p-2", "Special", null)],
  ]);
  asked = [];
  FAILING = new Set();
});

/** The tab coming back into view: the page reads again. */
async function comeBack() {
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  for (let i = 0; i < 5; i++) await settle();
}
afterEach(async () => {
  cleanup();
  await settle();
});

describe("the published stage plots page", () => {
  test("reads the secret out of the address, and nothing that is not one", () => {
    assert.equal(secretFromPath(`/stageplots/${SECRET}`), SECRET);
    assert.equal(secretFromPath(`/stageplots/${SECRET}/`), SECRET);
    assert.equal(secretFromPath("/stageplots/short"), null);
    assert.equal(secretFromPath(`/servicecue/${SECRET}`), null);
  });

  test("shows the venue, its plots as tabs, and the plot it showed for its plan, marked", async () => {
    await mount();
    assert.equal(screen.getByRole("heading", { level: 1 }).textContent, "Room One");
    assert.deepEqual(
      screen.getAllByRole("tab").map((t) => t.textContent),
      ["StandardDefault", "Special"],
    );
    assert.equal(screen.getByRole("tab", { selected: true }).textContent, "Special");
    assert.equal(screen.getByTestId("plan-badge").textContent, "For this plan · Sun 15 Nov");
    assert.match(document.body.textContent ?? "", /Side door, then left\./);
    assert.ok(asked.every((p) => p.startsWith(`/stageplots/${SECRET}/`)), `asked for something outside the secret: ${asked.join(", ")}`);
    assert.equal(document.title, "Room One · Stage plots");
  });

  test("draws a background from under the secret, and none the page does not hold yet", async () => {
    await mount();
    // Special's background is not published yet: no image, but the plot keeps its shape.
    assert.equal(document.querySelector("[data-testid=plot-background]"), null);
    assert.equal(document.querySelector("svg[role=img]")?.getAttribute("viewBox"), `0 0 1000 ${(1000 * 1600) / 2400}`);
    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: /Standard/ }));
    });
    await settle();
    assert.equal(document.querySelector("[data-testid=plot-background]")?.getAttribute("href"), `/stageplots/${SECRET}/image/0000000000000001`);
  });

  test("a tap on a linked connection point lists the channels it was published with, not its inputs", async () => {
    const p = plot("p-2", "Special", null);
    p.items = [
      {
        id: "sb1",
        type: "conn",
        x: 100,
        y: 100,
        w: 25,
        h: 25,
        rotation: 0,
        label: "SB-1",
        color: "#0091ff",
        notes: "",
        inputs: ["Own input"],
        patch: { sheet: "Main patch", channels: [{ channel: "Ch 1", label: "Kick In", path: "SB-1/1" }] },
      },
    ];
    STORED.set("plot/p-2", p);
    await mount();
    const item = document.querySelector('[data-id="sb1"]')!;
    await act(async () => {
      fireEvent.pointerDown(item, { pointerId: 1, clientX: 10, clientY: 10 });
      fireEvent.pointerUp(item, { pointerId: 1, clientX: 10, clientY: 10 });
    });
    await settle();
    const details = document.querySelector("[data-item-details]")!;
    assert.match(details.textContent ?? "", /^SB-1Connection pointPatch channels · Main patchCh 1Kick InSB-1\/1$/);
  });

  test("a tap on an item shows its label, notes and inputs", async () => {
    await mount();
    const item = document.querySelector('[data-id="i-p-2"]')!;
    await act(async () => {
      fireEvent.pointerDown(item, { pointerId: 1, clientX: 10, clientY: 10 });
      fireEvent.pointerUp(item, { pointerId: 1, clientX: 10, clientY: 10 });
    });
    await settle();
    const details = document.querySelector("[data-item-details]")!;
    assert.ok(details, "the item's details did not open");
    assert.match(details.textContent ?? "", /Drum riser/);
    assert.match(details.textContent ?? "", /Lock the casters\./);
    assert.match(details.textContent ?? "", /Kick/);
  });

  test("a default it showed is marked Default", async () => {
    STORED.set("index", index({ shown: { plotId: "p-1", reason: "default" }, plan: null }));
    await mount();
    assert.equal(screen.getByRole("tab", { selected: true }).textContent, "StandardDefault");
    assert.equal(screen.getByTestId("plan-badge").textContent, "Default");
  });

  test("a plot that fails to read again keeps its last copy and says it could not refresh", async () => {
    await mount();
    assert.ok(document.querySelector('[data-id="i-p-2"]'), "the plot was not drawn to begin with");
    FAILING.add("plot/p-2");
    await comeBack();
    assert.ok(document.querySelector('[data-id="i-p-2"]'), "a failed read blanked the plot it had");
    assert.match(document.body.textContent ?? "", /Could not refresh this plot; showing the last copy\./);
  });

  test("a plot that has never read shows the failure, not an empty stage", async () => {
    FAILING.add("plot/p-2");
    await mount();
    assert.equal(screen.getByRole("tab", { selected: true }).textContent, "Special");
    assert.match(screen.getByRole("alert").textContent ?? "", /This plot could not be loaded\. Try again in a moment\./);
    assert.equal(document.querySelector("svg[role=img]"), null, "an empty stage was drawn for a plot that never loaded");
  });

  test("an index that is gone on a later read blanks the page: the venue was unpublished", async () => {
    await mount();
    STORED.clear();
    await comeBack();
    assert.match(document.body.textContent ?? "", /This link is not published\./);
    assert.equal(document.querySelector("svg[role=img]"), null);
  });

  test("a link with nothing behind it says so, and asks for nothing more", async () => {
    STORED.clear();
    await mount();
    assert.match(document.body.textContent ?? "", /This link is not published\./);
    assert.deepEqual(asked, [`/stageplots/${SECRET}/index`]);
  });
});
