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
import type { LayoutRenderCtx } from "./layout-renderer";

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

const textObject: LayoutObject = {
  id: "t1", x: 0, y: 0, w: 1, h: 1, z: 0,
  config: { type: "text", text: VIEW_MARKER }, style: { fontSize: 0.1 },
};

/** A control INSIDE the tile, the thing an outer button would have eaten. Bound
 *  to a real action so pressing it is observable as a request rather than as an
 *  absence of one. */
const INNER_ACTION = "inner-action";
const innerButtonObject: LayoutObject = {
  id: "t2", x: 0, y: 0, w: 1, h: 1, z: 0,
  config: { type: "action-button", actionId: INNER_ACTION, label: "INNER CONTROL" }, style: {},
};

const view = (objects: LayoutObject[]): View => ({
  id: "v-1", name: "Slots A", kind: "custom", createdAt: "2026-01-01T00:00:00.000Z",
  layout: { version: 1, canvas: { width: 1920, height: 1080, fit: "contain" }, objects },
});

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
const { makeRenderCtx, DEFAULT_STAGE_STATE } = await import("./test-render-ctx.js");

const STATE: StageState = { ...DEFAULT_STAGE_STATE };

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
 *  screen, a VIEW tile by the view, and they are deliberately different words.
 *  One owner of that mapping — the nested fixtures further down use different
 *  names for both, and wrote out their own copy of the ternary before this. */
const titleFor = (kind: Kind, screen: string, viewName = "Slots A") =>
  kind === "screen-embed" ? screen : viewName;

/**
 * @param stopped the tile stops having anything to show — the screen goes to
 *   blackout for a `screen-embed`, the view is deleted for a `view-embed`. The
 *   two objects reach the same state by different routes, which is exactly why
 *   the guard below runs against both.
 */
function ctxFor(
  interactive: boolean,
  screen: string,
  objects: LayoutObject[],
  stopped: "blackout" | "view-deleted" | null = null,
): LayoutRenderCtx {
  return makeRenderCtx({
    state: {
      ...STATE,
      views: stopped === "view-deleted" ? [] : [view(objects)],
      outputs: [{ id: "out-1", name: screen, viewId: "v-1", blackout: stopped === "blackout" }],
    },
    interactive,
  });
}

const objectFor = (kind: Kind) => ({
  id: "o1", type: kind, x: 0, y: 0, w: 1, h: 1, z: 1,
  config: kind === "screen-embed"
    ? { type: "screen-embed", outputId: "out-1", showLabel: true }
    : { type: "view-embed", viewId: "v-1" },
  style: {},
});

/** Any object, in any context, through the real RenderObject — so the registry
 *  entry, the switch case and the component are all on the path. Takes the
 *  OBJECT rather than a kind, because the nested tests build their own. */
const tree = (o: LayoutObject, ctx: LayoutRenderCtx) =>
  React.createElement(TooltipProvider as never, null,
    React.createElement(RenderObject, { o, ctx } as never));

/** Mount a tree and let its effects settle. */
async function draw(el: React.ReactElement) {
  let result!: { container: HTMLElement; rerender: (el: React.ReactElement) => void };
  await act(async () => {
    result = render(el) as never;
    await settle();
  });
  return result;
}

/** One embed object on its own, at the top level of a surface. */
async function renderTile(
  { kind = "screen-embed", interactive, title = "Left Display", objects = [textObject] }:
  { kind?: Kind; interactive: boolean; title?: string; objects?: LayoutObject[] },
) {
  return draw(tree(objectFor(kind) as LayoutObject, ctxFor(interactive, title, objects)));
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

// One shape, two call sites, so it is proven at both. `useExpand`'s gate is an
// INPUT: gated only on the way out, the hook kept an invisible "expanded" —
// the panel gone, no control to reopen with, a document keydown listener still
// attached, and the panel springing back to full screen by itself when the tile
// had something to show again.
for (const [kind, stopped, what] of [
  ["screen-embed", "blackout", "the screen is blacked out"],
  ["view-embed", "view-deleted", "the view is deleted"],
] as [Kind, "blackout" | "view-deleted", string][]) {
  describe(`a ${kind} tile expanded when ${what}`, () => {
    test("closes the panel, and does not reopen it when the tile comes back", async () => {
      const { container, rerender } = await renderTile({ kind, interactive: true });
      await openOverlay(container);
      assert.ok(overlayEl(), "the overlay never opened");

      await act(async () => {
        rerender(tree(objectFor(kind) as LayoutObject, ctxFor(true, "Left Display", [textObject], stopped)));
        await settle();
      });
      assert.equal(overlays(), 0, `${what} and the panel stayed open`);
      assert.equal(buttons(container), 0, `${what} and the tile still offered to expand`);

      await act(async () => {
        rerender(tree(objectFor(kind) as LayoutObject, ctxFor(true, "Left Display", [textObject], null)));
        await settle();
      });
      assert.equal(overlays(), 0, "the panel reopened by itself when the tile came back");
      assert.equal(buttons(container), 1, "the tile came back without its expand control");
    });
  });
}

// The FLIP itself. jsdom has no layout, so BOTH halves need stubbing: a
// matchMedia that answers, and rects that are not 0x0 — without the rects the
// motion path bails on its own divide-by-zero guard and the assertion below
// would pass for a component that never animates.
describe("prefers-reduced-motion", () => {
  const rect = (left: number, top: number, width: number, height: number) => ({
    left, top, width, height, right: left + width, bottom: top + height, x: left, y: top,
    toJSON() {},
  });

  /** Open a tile with the media query answering `reduce: <reduced>`, and report
   *  what the panel's inline transform was before the release frame. */
  async function transformOnOpen(reduced: boolean) {
    const realMatchMedia = window.matchMedia;
    // Element, not HTMLElement: getBoundingClientRect is defined one level up,
    // so HTMLElement.prototype has no own descriptor to put back afterwards.
    const realRect = Object.getOwnPropertyDescriptor(Element.prototype, "getBoundingClientRect")!;
    (window as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({
      matches: q.includes("reduced-motion") ? reduced : false,
      media: q, onchange: null,
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
      dispatchEvent: () => false,
    });
    // The panel is the overlay root's only child; everything else is the tile.
    Object.defineProperty(Element.prototype, "getBoundingClientRect", {
      configurable: true,
      value(this: HTMLElement) {
        return this.parentElement?.hasAttribute("data-expand-overlay")
          ? rect(0, 0, 1000, 800)
          : rect(100, 200, 250, 200);
      },
    });
    try {
      const { container } = await renderTile({ interactive: true });
      const btn = expandControl(container);
      assert.ok(btn, "no way to expand the tile");
      // No settle(): the release is two requestAnimationFrames away, and this
      // reads the INVERTED position the transition starts from.
      await act(async () => { fireEvent.click(btn); });
      const panel = document.querySelector<HTMLElement>("[data-expand-overlay] > div");
      assert.ok(panel, "the overlay opened without a panel");
      return { transform: panel.style.transform, transition: panel.style.transition };
    } finally {
      (window as unknown as { matchMedia: unknown }).matchMedia = realMatchMedia;
      Object.defineProperty(Element.prototype, "getBoundingClientRect", realRect);
    }
  }

  test("off: the panel starts on the tile and is carried out", async () => {
    // 250x200 at (100,200) growing into 1000x800 at (0,0).
    const { transform, transition } = await transformOnOpen(false);
    assert.equal(transform, "translate(100px, 200px) scale(0.25, 0.25)",
      "the panel did not start on the tile — an overlay that appears at full size reads as the page having jumped");
    assert.equal(transition, "none", "the inverted position was itself animated");
  });

  test("on: nothing is transformed, and it still opens", async () => {
    const { transform } = await transformOnOpen(true);
    assert.equal(transform, "", "a reduced-motion viewer was animated anyway");
    assert.equal(overlays(), 1, "reduced motion stopped the overlay opening at all");
  });
});

// A NESTED EMBED — an embed whose view holds an embed of its own.
//
// Two opposite assertions, and the pair is the point: suppressing the inner
// control satisfies the first alone, and a fix that only ever draws it satisfies
// the second alone. On the TILE the nested embed is content and offers nothing;
// inside the EXPANDED panel it is a tile in its own right and offers a control
// that works. See `insideEmbedTile` on LayoutRenderCtx for why.
//
// EVERY PAIRING of outer and inner kind — four, not two. Two things are being
// proven and they live in different places:
//
//   THE GATE (`!ctx.insideEmbedTile`) is per object, so looping the INNER kind
//   covers it. That much a two-case loop did.
//   WHICH COPY IS WHICH — the "tile"/"panel" literal each object hands its body
//   — belongs to the OUTER object, and a suite whose outer tile was always a
//   `view-embed` never ran screen-embed's pair at all. Both of its literals
//   could be inverted with the whole suite green, which would have shipped a
//   producer wall built from a screen tile that expands and then offers no way
//   to drill in. That is the mutation this 2x2 exists for.

/** The view a nested tile bottoms out at. */
const leafView: View = {
  id: "v-leaf", name: "Leaf Wall", kind: "custom", createdAt: "2026-01-01T00:00:00.000Z",
  layout: { version: 1, canvas: { width: 1920, height: 1080, fit: "contain" }, objects: [textObject] },
};

/** Every "Expand X" on offer, by NAME — strings, so a red run prints something
 *  (see the note on `buttons` above: a DOM node OOMs the reporter). */
const expandLabels = (root: ParentNode) =>
  [...root.querySelectorAll('button[aria-label^="Expand "]')].map((b) => b.getAttribute("aria-label"));

/** An embed of a view whose only object is another embed — both kinds, either
 *  end. A screen tile is routed to the same view its view-embed twin names, so
 *  the four cases differ only in the object under test. */
async function renderNested(outer: Kind, inner: Kind) {
  const innerTileObject: LayoutObject = {
    id: "o-inner", x: 0, y: 0, w: 1, h: 1, z: 0,
    config: inner === "screen-embed"
      ? { type: "screen-embed", outputId: "out-leaf", showLabel: true }
      : { type: "view-embed", viewId: "v-leaf" },
    style: {},
  };
  const outerView: View = {
    id: "v-outer", name: "Outer Wall", kind: "custom", createdAt: "2026-01-01T00:00:00.000Z",
    layout: { version: 1, canvas: { width: 1920, height: 1080, fit: "contain" }, objects: [innerTileObject] },
  };
  const outerTileObject: LayoutObject = {
    id: "o-outer", x: 0, y: 0, w: 1, h: 1, z: 0,
    config: outer === "screen-embed"
      ? { type: "screen-embed", outputId: "out-outer", showLabel: true }
      : { type: "view-embed", viewId: "v-outer" },
    style: {},
  };
  const ctx = makeRenderCtx({
    state: {
      ...STATE,
      views: [outerView, leafView],
      // Both screens exist in all four cases: a view-embed end ignores its one,
      // and one fixture serving every pairing is one fewer thing that can
      // differ between runs of the same assertions.
      outputs: [
        { id: "out-outer", name: "Outer Screen", viewId: "v-outer", blackout: false },
        { id: "out-leaf", name: "Leaf Screen", viewId: "v-leaf", blackout: false },
      ],
    },
    interactive: true,
  });

  const { container } = await draw(tree(outerTileObject, ctx));
  return {
    container,
    outerLabel: `Expand ${titleFor(outer, "Outer Screen", "Outer Wall")}`,
    innerLabel: `Expand ${titleFor(inner, "Leaf Screen", "Leaf Wall")}`,
  };
}

/** Both panels open, outer first — the state the tests below start from. */
async function openNestedPanels(outer: Kind, inner: Kind) {
  const { container, outerLabel, innerLabel } = await renderNested(outer, inner);
  // BY NAME rather than through `openOverlay`, which takes the first button in
  // the container: these tests are about which control belongs to which box, so
  // naming each one is the assertion, not a convenience.
  const outerBtn = container.querySelector<HTMLButtonElement>(`[aria-label="${outerLabel}"]`);
  assert.ok(outerBtn, "the outer tile offered no way to expand");
  await act(async () => { fireEvent.click(outerBtn); await settle(); });

  const ov = overlayEl();
  assert.ok(ov, "the outer panel never opened");
  assert.deepEqual(expandLabels(ov), [innerLabel],
    "the nested tile lost its own control inside the panel, where it IS the tile");

  const innerBtn = ov.querySelector<HTMLButtonElement>(`[aria-label="${innerLabel}"]`);
  assert.ok(innerBtn, "the nested control vanished between the two reads");
  await act(async () => { fireEvent.click(innerBtn); await settle(); });
  return { container, outerLabel, innerLabel };
}

for (const outer of KINDS) {
  for (const inner of KINDS) {
    describe(`a ${inner} nested inside a ${outer}`, () => {
      test("the tile offers one control, the outer one", async () => {
        const { container, outerLabel } = await renderNested(outer, inner);
        // The tile really drew its content, so "one control" is a suppressed
        // inner affordance rather than a tile that failed to render at all.
        assert.match(container.textContent ?? "", new RegExp(VIEW_MARKER), "the nested tile drew nothing");
        assert.deepEqual(
          expandLabels(container), [outerLabel],
          "the nested embed drew a second expand control over the tile's own — the operator sees one tile and gets one control",
        );
      });

      test("and the nested control comes back inside the expanded panel", async () => {
        // The other half of the rule, so the fix cannot be "delete the inner
        // control": at full size the nested tile IS a tile, and expanding it is
        // what a producer wall inside a producer wall is for. The helper asserts
        // the control is there and named; this asserts pressing it did
        // something — and, because it is the OUTER object's panel copy that has
        // to say "panel" for the inner control to exist at all, it is what
        // pins that literal down for both outer kinds.
        await openNestedPanels(outer, inner);
        assert.equal(overlays(), 2, "the nested control did not expand anything");
      });
    });
  }
}

describe("a panel nested inside another expanded panel", () => {
  test("Escape closes only the innermost one", async () => {
    // Each level runs its own `useExpand`, and each attaches its own document
    // keydown listener; one Escape used to collapse every level because all of
    // them reacted to the same key press.
    await openNestedPanels("view-embed", "view-embed");
    assert.equal(overlays(), 2, "the two panels this test is about never both opened");

    await act(async () => { fireEvent.keyDown(document, { key: "Escape" }); await settle(); });

    assert.equal(overlays(), 1, "Escape closed more than the innermost panel");
    assert.equal(
      document.querySelector("[data-expand-overlay]")?.getAttribute("aria-label"),
      "Outer Wall",
      "the surviving panel was the wrong one — the outer panel closed instead of the inner one",
    );

    await act(async () => { fireEvent.keyDown(document, { key: "Escape" }); await settle(); });
    assert.equal(overlays(), 0, "the outer panel did not close on its own Escape");
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
