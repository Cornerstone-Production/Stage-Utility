// A card on Home takes a click. A card on a wall does not.
//
// Both halves matter and they pull in opposite directions, which is how this
// broke: the rule that protects wall displays was applied to every surface, and
// the operator's own front page went inert. The readiness card's chevrons went
// nowhere, drill-downs did nothing, and the plan checklist could not be ticked
// — reported as "I am not able to interact with the widget at all", which was
// true of every card on the page, not just the new one.
//
// Rendered, and asserted on the CLASS, with the reason stated because the
// obvious better choice does not work here. `getComputedStyle().pointerEvents`
// is what a browser actually acts on — but jsdom loads no stylesheet, so
// Tailwind's `pointer-events-none` resolves to the default and every reading
// comes back "auto". Written that way first, the Home test passed while the
// three inert cases failed, and the pass was worth nothing.
//
// So the class is the observable, checked on EVERY ancestor rather than one
// element, because pointer-events is inherited and the bug lived on a wrapper
// the card itself knew nothing about. What this cannot prove is that Tailwind
// still emits that class; the build does that, and `pointer-events-none` is
// used in six other places that would break with it.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

class StubEventSource {
  readyState = 0;
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}
(globalThis as unknown as { EventSource: unknown }).EventSource = StubEventSource;
(globalThis as unknown as { fetch: unknown }).fetch = async () =>
  ({ ok: true, status: 200, json: async () => ({}), text: async () => "{}" });

const { render, cleanup } = await import("@testing-library/react");
const React = (await import("react")).default;
const { ObjectContent } = await import("./layout-renderer.js");
const { makeRenderCtx } = await import("./test-render-ctx.js");

const settle = () => new Promise((r) => setTimeout(r, 0));
after(async () => { await settle(); teardown(); });
beforeEach(() => cleanup());
afterEach(async () => { cleanup(); await settle(); });

/** Enough of a context to render one card; only the two flags under test vary. */
function ctxWith(home: boolean, interactive: boolean) {
  return makeRenderCtx({ home, interactive });
}

/**
 * Whether a click would reach the card.
 *
 * Every element from the container down is checked, because pointer-events is
 * inherited: one `pointer-events-none` anywhere above kills the click, and that
 * is exactly where the bug lived — on a wrapper the card knew nothing about.
 */
function clicksLand(container: HTMLElement): boolean {
  const all = [container, ...Array.from(container.querySelectorAll("*"))];
  return !all.some((el) => el.classList.contains("pointer-events-none"));
}

function renderCard(home: boolean, interactive: boolean) {
  return render(
    React.createElement(ObjectContent, {
      // A card with no in-app link in it. The thing under test is the WRAPPER
      // ObjectContent puts around every home card, which is the same wrapper
      // whatever the card draws — and a card containing an AppLink needs a
      // router in the tree, which would make this test about the harness.
      o: { id: "c1", x: 0, y: 0, w: 1, h: 1, z: 1, config: { type: "home-next-service" }, style: {} },
      ctx: ctxWith(home, interactive),
    } as never),
  );
}

describe("a home card on the operator's own page", () => {
  test("TAKES A CLICK", () => {
    // The bug, stated as the assertion that would have caught it. Home builds
    // its context with `interactive: true, home: true` and a comment promising
    // "controls fire and drill-downs work"; the renderer ignored both.
    const { container } = renderCard(true, true);
    assert.ok(
      clicksLand(container),
      "every card on Home was inert — pointer-events is off somewhere above the card",
    );
  });
});

describe("a home card anywhere else", () => {
  test("a wall display cannot be navigated by a passer-by", () => {
    // The rule this protects: a wall runs the kiosk router, whose whole route
    // table is "/". A touch on a drill-down took a display to "Route not found"
    // and left it there until somebody walked over and reloaded it.
    const { container } = renderCard(false, false);
    assert.equal(clicksLand(container), false, "a wall display card was clickable");
  });

  test("a panel showing home cards is inert too", () => {
    const { container } = renderCard(false, true);
    assert.equal(clicksLand(container), false, "home:false must be inert whatever interactive says");
  });

  test("the layout EDITOR does not navigate out of itself", () => {
    // The editor sets home:true when the Home view is open. Gating on `home`
    // alone would make a link there navigate away mid-edit.
    const { container } = renderCard(true, false);
    assert.equal(clicksLand(container), false, "a link in the editor preview could leave the editor");
  });
});
