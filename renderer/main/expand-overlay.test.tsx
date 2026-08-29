// Tapping a tile expands it, and there is always a way back.
//
// Two failures this guards, and they are opposite ones:
//
//  - A wall display offering an expand control. Nobody stands next to a wall; an
//    overlay a passer-by opens stays open until somebody walks over to the rack.
//    So a wall gets NO control, not a disabled one.
//  - The expand affordance wrapped AROUND the tile's content, swallowing the
//    clicks of the controls inside it. This repository has shipped a nested
//    <button> twice, and an embedded tile is exactly where it would land a third
//    time — the tiles hold checklists, live controls and action buttons.
//
// What the second one does NOT catch, honestly: an affordance that is a DOM
// sibling but visually covers the body — `absolute inset-0` over the content.
// jsdom does no layout and no hit-testing, so a click dispatched at the inner
// control reaches it whatever is painted on top. That variant is ruled out by
// the affordance being a corner control, and confirmed by pressing an embedded
// control in a real browser.
//
// Neither is provable by "the box is non-empty", which is how an earlier embed
// suite stayed green with the whole component stubbed out. Each test below turns
// on something only the branch it names can produce.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** jsdom does no layout, so every element measures 0 — and a tile sizes its
 *  child's canvas by MEASURING its body. */
const BOX_PX = 270;
Object.defineProperty(HTMLElement.prototype, "clientHeight", {
  get: () => BOX_PX,
  configurable: true,
});

// jsdom ships neither, and both are reached by a render: the state hooks open
// the state stream, and every view fetches on mount. Left real, a request
// outlives the test and settles after teardown has removed `window`.
class StubEventSource {
  static readonly CONNECTING = 0;
  readyState = 0;
  onmessage: unknown = null;
  onerror: unknown = null;
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}
(globalThis as unknown as { EventSource: unknown }).EventSource = StubEventSource;

/** The routed view draws this and nothing else does. */
const VIEW_MARKER = "ROUTED VIEW BODY";

const textObject = {
  id: "t1", type: "text", x: 0, y: 0, w: 1, h: 1, z: 0,
  config: { type: "text", text: VIEW_MARKER }, style: { fontSize: 0.1 },
};

/** A control INSIDE the tile, the thing an outer button would have eaten. Bound
 *  to a real action so pressing it is observable as a request rather than as an
 *  absence of one. */
const INNER_ACTION = "inner-action";
const innerButtonObject = {
  id: "t2", type: "action-button", x: 0, y: 0, w: 1, h: 1, z: 0,
  config: { type: "action-button", actionId: INNER_ACTION, label: "INNER CONTROL" }, style: {},
};

const view = (objects: unknown[]) => ({
  id: "v-1", name: "Slots A", kind: "custom", layout: { objects },
});

const STATE = {
  views: [], outputs: [], slotsByView: {}, slotsByLayoutObject: {},
  emptySlotLogo: null, defaultAvatar: null, hourCycle: "24h", appName: "APP NAME",
  appLogo: null, appLogoMonochrome: false, serviceTypeName: "ST", planTitle: "PT",
  planSeriesTitle: "PS", showQr: false, remoteUrl: "", planId: null, serviceTypeId: null,
  pcoConfigured: true, chargerBays: [],
};

/** Every request the render (or a press) made, so a press is provable. */
const requests: string[] = [];
(globalThis as unknown as { fetch: unknown }).fetch = async (url: unknown, init?: unknown) => {
  const u = String(url);
  requests.push(`${u} ${JSON.stringify((init as { body?: unknown } | undefined)?.body ?? "")}`);
  const body = u.includes("/api/state") ? STATE : u.includes("transcript") ? [] : { ok: true, detail: "" };
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};

const { render, cleanup, fireEvent } = await import("@testing-library/react");
const React = (await import("react")).default;
const { act } = await import("react");
const { TooltipProvider } = await import("../components/ui/tooltip-provider.js");
const { RenderObject } = await import("./layout-renderer.js");

const settle = () => new Promise((r) => setTimeout(r, 0));
after(async () => { await settle(); teardown(); });
beforeEach(() => { cleanup(); requests.length = 0; });
afterEach(async () => {
  cleanup();
  // The portal lives on document.body, outside the container Testing Library
  // owns. An overlay left mounted by one test is a passing assertion in the
  // next one.
  document.body.innerHTML = "";
  await settle();
});

/** The tile types that can expand. BOTH, always: the wall rule is enforced at
 *  two call sites, and a suite that only ever built a `screen-embed` stayed
 *  green with view-embed's copy of the gate hardcoded open. */
const KINDS = ["screen-embed", "view-embed"] as const;
type Kind = (typeof KINDS)[number];

/** The name the overlay is expected to carry: a SCREEN tile is titled by the
 *  screen, a VIEW tile by the view, and they are deliberately different words. */
const titleFor = (kind: Kind, screen: string) => (kind === "screen-embed" ? screen : "Slots A");

function ctxFor(interactive: boolean, screen: string, objects: unknown[], blackout = false) {
  return {
    state: {
      ...STATE,
      views: [view(objects)],
      outputs: [{ id: "out-1", name: screen, viewId: "v-1", blackout }],
    },
    propresenter: null, propInstances: null, pcoLive: null, planItems: null,
    transcript: [], spl: null, obs: null, reaper: null, resi: null, youtube: null,
    osc: null, peopleCount: null, serviceLow: null, serviceAttendance: null,
    servicePeak: null, servicePeakAttendance: null, baptism: null,
    serviceTimeline: null, integrations: [], integrationLabels: {}, wireless: [],
    now: 0, skewMs: 0, ndiSource: null, H: 1080, placed: undefined,
    home: false, interactive, embedChain: [],
  };
}

const objectFor = (kind: Kind) => ({
  id: "o1", type: kind, x: 0, y: 0, w: 1, h: 1, z: 1,
  config: kind === "screen-embed"
    ? { type: "screen-embed", outputId: "out-1", showLabel: true }
    : { type: "view-embed", viewId: "v-1" },
  style: {},
});

const tree = (kind: Kind, ctx: unknown) =>
  React.createElement(TooltipProvider as never, null,
    React.createElement(RenderObject, { o: objectFor(kind), ctx } as never));

/**
 * A tile drawn through the real RenderObject, so the registry entry, the switch
 * case and the component are all on the path.
 */
async function renderTile(
  { kind = "screen-embed", interactive, title = "Left Display", objects = [textObject] }:
  { kind?: Kind; interactive: boolean; title?: string; objects?: unknown[] },
) {
  let result!: { container: HTMLElement; rerender: (el: React.ReactElement) => void };
  await act(async () => {
    result = render(tree(kind, ctxFor(interactive, title, objects))) as never;
    await settle();
  });
  return result;
}

const expandControl = (container: HTMLElement) => container.querySelector("button");
const overlayEl = () => document.querySelector("[data-expand-overlay]");

/** Open the tile and let the portal commit. Four tests did this verbatim. */
async function openOverlay(container: HTMLElement) {
  const btn = expandControl(container);
  assert.ok(btn, "no way to expand the tile");
  await act(async () => { fireEvent.click(btn); await settle(); });
}

// COUNTS, never the node itself. `assert.equal(el, null)` on a failing run asks
// node:test to serialise an HTMLElement, whose parent/child/ownerDocument chain
// walks the entire jsdom tree — the process is OOM-killed before it prints, and
// a guard whose red output is exit 137 tells nobody what broke.
const buttons = (root: ParentNode) => root.querySelectorAll("button").length;
const overlays = () => document.querySelectorAll("[data-expand-overlay]").length;

// EVERY tile kind, every time. The wall rule lives at two call sites, and a
// suite that only built one of them let the other be hardcoded open.
for (const kind of KINDS) {
  describe(`expanding a ${kind} tile`, () => {
    test("a wall display cannot expand anything", async () => {
      // The rule: a wall runs the kiosk router and nobody is standing next to
      // it. An overlay opened by a passer-by stays open until somebody walks
      // over.
      const { container } = await renderTile({ kind, interactive: false });
      // The tile really did draw, so "no button" is a missing control rather
      // than a missing tile.
      assert.match(container.textContent ?? "", new RegExp(VIEW_MARKER), "the wall tile drew nothing");
      assert.equal(buttons(container), 0, "a wall tile offered a control");
    });

    test("a control surface CAN, and opens an overlay", async () => {
      const { container } = await renderTile({ kind, interactive: true });
      await openOverlay(container);
      assert.ok(overlayEl(), "clicking did not open anything");
      // And the overlay holds the view, not an empty panel with a title bar.
      assert.match(overlayEl()?.textContent ?? "", new RegExp(VIEW_MARKER),
        "the overlay opened without the tile's content in it");
    });

    test("ESCAPE closes it", async () => {
      const { container } = await renderTile({ kind, interactive: true });
      await openOverlay(container);
      assert.ok(overlayEl(), "the overlay never opened");
      await act(async () => { fireEvent.keyDown(document, { key: "Escape" }); await settle(); });
      assert.equal(overlays(), 0, "Escape did not close the overlay");
    });

    test("there is a visible way back, not only a key", async () => {
      // Somebody on a touchscreen has no Escape key. A control surface is a
      // touchscreen more often than not.
      const { container } = await renderTile({ kind, interactive: true });
      await openOverlay(container);
      const back = document.querySelector("[data-expand-overlay] button");
      assert.ok(back, "the only way out of the overlay was the keyboard");
      await act(async () => { fireEvent.click(back); await settle(); });
      assert.equal(overlays(), 0, "the visible control did not close the overlay");
    });

    test("names what is expanded, so a wall of tiles is not ambiguous", async () => {
      const { container } = await renderTile({ kind, interactive: true, title: "Left Display" });
      await openOverlay(container);
      const want = titleFor(kind, "Left Display");
      assert.ok(
        overlayEl()?.textContent?.includes(want),
        `the overlay did not say which tile it came from (wanted "${want}")`,
      );
    });

    test("the panel announces itself as a modal dialog", async () => {
      // Without this a screen reader is told nothing opened, and the page behind
      // the panel reads as the live document.
      const { container } = await renderTile({ kind, interactive: true });
      await openOverlay(container);
      const ov = overlayEl();
      assert.equal(ov?.getAttribute("role"), "dialog", "the overlay is not a dialog");
      assert.equal(ov?.getAttribute("aria-modal"), "true", "the overlay is not modal");
      assert.equal(ov?.getAttribute("aria-label"), titleFor(kind, "Left Display"),
        "the dialog is unnamed");
    });

    test("focus moves into the panel, and comes back to the tile", async () => {
      // The control that opened the panel unmounts, so focus fell to <body> and
      // the next Tab walked the page BEHIND the overlay.
      const { container } = await renderTile({ kind, interactive: true });
      await openOverlay(container);
      assert.equal(
        (document.activeElement as HTMLElement | null)?.getAttribute("aria-label"),
        `Close ${titleFor(kind, "Left Display")}`,
        "focus stayed outside the panel",
      );
      await act(async () => { fireEvent.keyDown(document, { key: "Escape" }); await settle(); });
      assert.equal(
        (document.activeElement as HTMLElement | null)?.getAttribute("aria-label"),
        `Expand ${titleFor(kind, "Left Display")}`,
        "focus was dropped on the floor when the panel closed",
      );
    });
  });
}

describe("a screen that stops showing while it is expanded", () => {
  test("closes the panel, and does not reopen it when the screen comes back", async () => {
    // Straight off a producer desk: expand a tile, then black that screen out.
    // Gated only on the way out, the hook kept an invisible "expanded" — no
    // control to reopen with, a document key listener still attached, and the
    // panel springing back to full screen by itself when the blackout cleared.
    const { container, rerender } = await renderTile({ interactive: true });
    await openOverlay(container);
    assert.ok(overlayEl(), "the overlay never opened");

    await act(async () => {
      rerender(tree("screen-embed", ctxFor(true, "Left Display", [textObject], true)));
      await settle();
    });
    assert.equal(overlays(), 0, "a blacked-out screen kept its panel open");
    assert.equal(buttons(container), 0, "a blacked-out screen still offered to expand");

    await act(async () => {
      rerender(tree("screen-embed", ctxFor(true, "Left Display", [textObject], false)));
      await settle();
    });
    assert.equal(overlays(), 0, "the panel reopened by itself when the blackout cleared");
    assert.equal(buttons(container), 1, "the screen came back without its expand control");
  });
});

describe("the expand affordance is a sibling of the tile's content, not its ancestor", () => {
  test("a control inside the tile still gets its own press", async () => {
    // The nested-<button> bug, which this repository has shipped twice: an outer
    // control wrapped around the content swallows the inner one's click. Tiles
    // hold checklists, live controls and action buttons, so a full-bleed hit
    // area over the body is the same defect with a different tag name.
    const { container } = await renderTile({ interactive: true, objects: [innerButtonObject] });
    const inner = container.querySelector<HTMLButtonElement>(`[aria-label="INNER CONTROL"]`);
    assert.ok(inner, "the embedded control did not render");

    await act(async () => { fireEvent.click(inner); await settle(); });

    assert.ok(
      requests.some((r) => r.includes("/api/action/invoke") && r.includes(INNER_ACTION)),
      `the tile ate the embedded control's click (requests: ${requests.join(" | ")})`,
    );
    assert.equal(overlays(), 0, "pressing a control inside the tile expanded the tile instead");

    // The same bug named structurally, so it fails on the shape and not only on
    // this one click path: the nearest <button> above the embedded control is
    // the control itself.
    // `parentElement` first, because `closest` starts at the node itself and
    // would answer "yes, me" for every button ever. A boolean rather than the
    // node: see the note on `buttons` above — a DOM node as an assertion value
    // OOMs the reporter before it can print.
    assert.equal(inner.parentElement?.closest("button") == null, true,
      "the embedded control was nested inside an outer button");
  });

  test("the expand control contains none of the tile's content", async () => {
    // Structural, so it fails on the shape of the bug rather than on one click
    // path: nothing the tile draws may live inside the control.
    const { container } = await renderTile({ interactive: true });
    const btn = expandControl(container);
    assert.ok(btn, "no way to expand the tile");
    assert.equal(
      (btn.textContent ?? "").includes(VIEW_MARKER),
      false,
      "the expand control was wrapped around the tile's content",
    );
  });
});
