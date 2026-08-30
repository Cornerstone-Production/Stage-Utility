// Every tab opens at the top.
//
// This drives the ROUTER'S OWN scroll-restoration code, not a re-implementation
// of it, because the bug was never in this repo's logic — there was none. It was
// in what `scrollRestoration: true` does on its own:
//
//   - it tracks whatever scrolls, and here exactly one thing does: the shell's
//     `<main>` (`html`, `body` and `#root` are all `overflow: hidden`)
//   - on a forward navigation it COPIES the previous location's offset for every
//     tracked non-window scroller onto the new location, skipping only elements
//     named in `scrollToTopSelectors`
//   - its own scroll-to-top call goes to `window`, which cannot scroll here
//
// So every page inherited the offset of the page before it, and it read as
// intermittent only because a short page clamps the carried value away while a
// tall one keeps it. Every settings-shaped page ends in `pb-[50vh]`, which is why
// Integrations and History were the two reported.
//
// The third case below is the red one held permanently: the same navigation with
// the option taken away, failing with the number this bug is made of.
//
// KNOWN GAP, stated rather than left to be found: nothing here renders the shell,
// so nothing here would notice the `data-scroll-restoration-id` attribute being
// deleted from its `<main>`. The selector and the attribute cannot drift (they
// are one exported constant, which the type checker enforces), but the element
// losing it entirely is only caught by driving a browser. That was done for this
// change and the numbers are in the PR.

import { strict as assert } from "node:assert";
import { after, beforeEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

// The router package ships three `isServer` builds behind conditional exports,
// and Node picks the SERVER one — which short-circuits scroll restoration
// entirely unless NODE_ENV says "test". Without this every case below passes or
// fails on a code path that never ran, which is how the first draft of this file
// reported the offset carrying over in both directions.
process.env.NODE_ENV = "test";

// Globals the restoration code reaches for bare, which the shared DOM harness
// does not expose because nothing else in the suite has needed them. Local to
// this file rather than added to test-dom.ts: a global that appears for every
// test file is a global that changes how twenty other files behave.
const w = globalThis as unknown as Record<string, unknown>;
w.history = (globalThis as unknown as { window: Window }).window.history;
w.addEventListener = (globalThis as unknown as { window: Window }).window.addEventListener.bind(
  (globalThis as unknown as { window: Window }).window,
);
w.self = globalThis;
w.scrollX = 0;
w.scrollY = 0;
// jsdom's window.scrollTo reports "not implemented" through the virtual console.
// The library calls it on every reset and the document cannot scroll in this app
// anyway, so silence it rather than read twenty of them per run.
w.scrollTo = () => {};

const { setupScrollRestoration, storageKey } = await import("@tanstack/router-core");
const { PAGE_SCROLLER_ID, PAGE_SCROLLER_SELECTOR, scrollPageToTop } = await import("./route-reset.js");
const { router } = await import("./router.js");

after(() => {
  teardown();
});

/**
 * A scrolling pane exactly as the shell renders it, and a scroll offset jsdom
 * will keep.
 *
 * jsdom lays nothing out, so `scrollTop` on a real element clamps to 0 — there is
 * no overflow for it to have. The property is redefined to a plain value, which
 * is what makes the carried-over number observable at all. Documented here rather
 * than left to be discovered: a version of this test written against the real
 * property passed in both directions, because both directions read 0.
 */
function pane(): HTMLElement {
  const el = document.createElement("main");
  el.setAttribute("data-scroll-restoration-id", PAGE_SCROLLER_ID);
  let top = 0;
  Object.defineProperty(el, "scrollTop", {
    get: () => top,
    set: (v: number) => { top = v; },
  });
  Object.defineProperty(el, "scrollLeft", { get: () => 0, set: () => {} });
  // The library resets through scrollTo, which jsdom does not give elements.
  Object.defineProperty(el, "scrollTo", {
    value: (o: { top: number }) => { top = o.top; },
  });
  document.body.append(el);
  return el;
}

/** A location the way the router names one. */
function location(href: string, key: string) {
  return { href, hash: "", state: { __TSR_key: key } };
}

/**
 * The smallest router the real `setupScrollRestoration` will attach to, plus the
 * two events it listens for. Everything it reads is here; nothing is simulated.
 */
function harness(selectors: NonNullable<typeof router.options.scrollToTopSelectors> | undefined) {
  const subscribers: Record<string, ((e: unknown) => void)[]> = {};
  const here = location("/", "start");
  const fake = {
    isServer: false,
    options: {
      scrollRestoration: true,
      scrollToTopSelectors: selectors,
    },
    _scroll: { next: true } as Record<string, unknown>,
    stores: {
      resolvedLocation: { get: () => here },
      location: { get: () => here },
    },
    subscribe(name: string, fn: (e: unknown) => void) {
      (subscribers[name] ??= []).push(fn);
      return () => {};
    },
    latestLocation: here,
  };
  setupScrollRestoration(fake as never, true);
  return {
    /** Leave `from` and arrive at `to`, the way a rail click does. */
    navigate(from: ReturnType<typeof location>, to: ReturnType<typeof location>) {
      for (const fn of subscribers.onBeforeLoad ?? []) fn({ fromLocation: from });
      for (const fn of subscribers.onRendered ?? []) fn({ fromLocation: from, toLocation: to });
    },
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
  sessionStorage.removeItem(storageKey);
  // The library holds its cache in module state, so a run has to start from a
  // page that has never been visited or it reads the previous case's offsets.
  // Fresh keys per case do that without reaching into the module.
});

let seq = 0;
const fresh = (path: string) => location(path, `k${seq++}`);

describe("a tab opens at the top", () => {
  test("the router is told which element to reset, and it is the one the shell names", () => {
    // Runtime config, not source text: this is the array the library reads.
    assert.deepEqual(
      router.options.scrollToTopSelectors,
      [PAGE_SCROLLER_SELECTOR],
      "the operator router does not name its scrolling pane, so nothing is ever reset",
    );
    assert.equal(
      PAGE_SCROLLER_SELECTOR,
      `[data-scroll-restoration-id="${PAGE_SCROLLER_ID}"]`,
      "the selector and the attribute the shell writes have drifted apart",
    );
  });

  test("a page left scrolled does not hand its offset to the next one", () => {
    // Driven from the APP'S OWN options, not a local copy of them: take
    // `scrollToTopSelectors` out of router.tsx and this fails with 640, which is
    // the shipped behaviour the report describes.
    const el = pane();
    const restoration = harness(router.options.scrollToTopSelectors);

    const home = fresh("/");
    const integrations = fresh("/settings/integrations");

    // Scroll Home down. The capture-phase listener the library installs is what
    // marks this element as something worth snapshotting.
    el.scrollTop = 640;
    el.dispatchEvent(new Event("scroll", { bubbles: false }));

    restoration.navigate(home, integrations);
    assert.equal(el.scrollTop, 0, "Integrations opened where Home was left");
  });

  test("without the selector it carries the offset over, which is the reported bug", () => {
    // The same navigation with `scrollToTopSelectors` taken away — the shipped
    // configuration before this change. Delete the option in router.tsx and the
    // case above fails with exactly this number.
    const el = pane();
    const restoration = harness(undefined);

    const home = fresh("/");
    const integrations = fresh("/settings/integrations");

    el.scrollTop = 640;
    el.dispatchEvent(new Event("scroll", { bubbles: false }));

    restoration.navigate(home, integrations);
    assert.equal(el.scrollTop, 640, "the carry-over this fix removes is no longer the default behaviour");
  });

  test("Back still lands where you were", () => {
    // The half that must NOT change. Returning to a location the operator has
    // already visited restores its own offset — the reset is for arriving
    // somewhere new, not for erasing where you have been.
    const el = pane();
    const restoration = harness(router.options.scrollToTopSelectors);

    const history = fresh("/history");
    const home = fresh("/");

    el.scrollTop = 380;
    el.dispatchEvent(new Event("scroll", { bubbles: false }));
    restoration.navigate(history, home);
    assert.equal(el.scrollTop, 0);

    // Back to the same history entry — the same key, so the same cache entry.
    el.dispatchEvent(new Event("scroll", { bubbles: false }));
    restoration.navigate(home, history);
    assert.equal(el.scrollTop, 380, "Back no longer returns to where the page was left");
  });

  test("re-selecting the rail item you are on also returns to the top", () => {
    // The second seam, and it is not a navigation at all: the reset remounts the
    // route through a key, and the scroller sits OUTSIDE that keyed subtree. Its
    // docblock claimed the remount restored scroll position; it never could.
    const el = pane();
    el.scrollTop = 512;
    scrollPageToTop();
    assert.equal(el.scrollTop, 0, "re-selecting the active rail item left the page scrolled");
  });

  test("the reset finds the pane by the router's own selector", () => {
    // scrollPageToTop and the router must agree on what the page scroller is. A
    // pane with no id is not the shell's pane, and must not be moved.
    const el = pane();
    el.removeAttribute("data-scroll-restoration-id");
    el.scrollTop = 200;
    scrollPageToTop();
    assert.equal(el.scrollTop, 200, "the reset moved something that is not the page pane");
  });
});
