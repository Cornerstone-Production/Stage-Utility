// test-dom.ts — a DOM for component tests.
//
// The usual way to do this is the `global-jsdom` package, which is a thin
// wrapper around what follows. It is not used here because it pins
// `jsdom >=29 <30` as a peer, so adding it would have held jsdom a major
// version back — and the alternative, forcing the install past the conflict, is
// exactly the kind of workaround this project does not take. Twelve lines is a
// cheaper price than a dependency that dictates another dependency's version.
//
//   const teardown = installDom();
//   ...
//   teardown();

import { registerHooks } from "node:module";

import { act } from "react";
import { JSDOM } from "jsdom";

// The router's CLIENT build, the one Vite bundles for the browser.
// `@tanstack/router-core/isServer` picks its build by export condition, and
// plain Node matches "node" and gets the server build, where `isServer` is a
// constant `true` that no router option can override. A server router commits
// no navigation at all: `router.navigate()` resolves having changed neither the
// history nor `router.state.location`, so a test that clicks and then reads the
// URL sees nothing, and passes or fails for a reason no browser shares. Here at
// module scope, not in installDom(), so it is in place before any component
// import can load the router; a file must import this module before anything
// that reaches the router.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier !== "@tanstack/router-core/isServer") return nextResolve(specifier, context);
    return nextResolve(specifier, { ...context, conditions: ["browser", ...context.conditions] });
  },
});

/** Globals a React render expects to find. */
const EXPOSED = [
  "window",
  // What the router's client build (see the hook above) reads as bare globals,
  // the way browser code may: it registers itself on `self`, and scroll
  // restoration sets `history.scrollRestoration`, listens for "pagehide",
  // snapshots `scrollX`/`scrollY` and calls `scrollTo`. Creating the app's
  // router throws without them.
  "self",
  "history",
  "addEventListener",
  "removeEventListener",
  "scrollX",
  "scrollY",
  "scrollTo",
  "document",
  "navigator",
  "HTMLElement",
  // Testing Library reaches for this when it fires an event, so a component
  // containing a form control — a Switch, an Input — cannot be rendered without
  // it. The failure reads "HTMLFormElement is not defined" from inside React,
  // which points nowhere near the missing global.
  "HTMLFormElement",
  "HTMLInputElement",
  "HTMLButtonElement",
  "Element",
  "Node",
  // Radix's focus scope walks the tree with document.createTreeWalker and passes
  // NodeFilter.SHOW_ELEMENT, so ANY component that opens a popover, dialog or
  // dropdown throws "NodeFilter is not defined" from inside Radix on mount —
  // again pointing nowhere near the missing global.
  "NodeFilter",
  "Event",
  "KeyboardEvent",
  "MouseEvent",
  "InputEvent",
  "CustomEvent",
  // Long-press context menus (context-menu-trigger.ts) are built on raw
  // Pointer Events, so any test that fires one needs jsdom's constructor —
  // Node has none of its own.
  "PointerEvent",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "MutationObserver",
  "ResizeObserver",
  // Web Storage, from jsdom rather than from Node. Node exposes these only
  // behind a flag and only on some versions, so a test that touched
  // sessionStorage passed locally and failed on CI with "sessionStorage is not
  // defined" — the same shape as the platform gaps that have bitten this repo
  // before. Taking them from jsdom makes the harness answer the same way
  // everywhere, and gives each test file a storage that the teardown discards.
  "localStorage",
  "sessionStorage",
] as const;

/**
 * Install a DOM onto globalThis and return the function that removes it again.
 *
 * Tearing down matters: a leaked `document` makes a later test file behave
 * differently depending on what ran before it, which is the worst kind of flake
 * to chase.
 */
export function installDom(html = "<!doctype html><html><body></body></html>"): () => void {
  const dom = new JSDOM(html, { pretendToBeVisual: true, url: "http://localhost:8788/" });
  const g = globalThis as unknown as Record<string, unknown>;

  const previous = new Map<string, PropertyDescriptor | undefined>();
  const win = dom.window as unknown as Record<string, unknown>;
  // jsdom has no ResizeObserver, and a component that measures its own box —
  // every readout does — throws on mount without one. A no-op is the honest
  // stub: jsdom does no layout, so every element is 0x0 and there is nothing for
  // a real implementation to report. Tests here assert what a component RENDERS,
  // never what size it computed; a size assertion belongs in readout-size, which
  // is arithmetic and needs no DOM at all.
  if (!("ResizeObserver" in win)) {
    win.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }

  // jsdom's window.scrollTo only reports "not implemented" through the virtual
  // console. The same reasoning as ResizeObserver: there is no layout, so there
  // is nothing to scroll, and the router's scroll restoration calls it on every
  // navigation.
  win.scrollTo = () => {};

  for (const key of EXPOSED) {
    // defineProperty rather than assignment: some of these — `navigator` on
    // Node 26 — are getter-only on globalThis, and a plain `g[key] = …` throws
    // "Cannot set property navigator of #<Object> which has only a getter".
    previous.set(key, Object.getOwnPropertyDescriptor(g, key));
    Object.defineProperty(g, key, {
      value: win[key],
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }

  return () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(g, key, descriptor);
      else delete g[key];
    }
    dom.window.close();
  };
}

/**
 * installDom, plus the three things a REACT render needs on top of it.
 *
 * Three files in renderer/main opened with byte-identical copies of exactly
 * this: the act-environment flag, one clientHeight for every element, and a
 * do-nothing EventSource. StubEventSource alone is at eleven copies across the
 * repo. Each was correct; three copies of a correct thing is still three places
 * a platform gap has to be patched, and installDom already stubs ResizeObserver
 * for the same reason.
 *
 * What is NOT here is the fetch stub. The three differ — one records every
 * request, one answers a route the others do not — and a stub that took a
 * config object per caller would be a worse version of writing four lines.
 *
 * @param clientHeight what every element reports for clientHeight. jsdom does no
 *   layout, so the real answer is 0 and a component that sizes a child by
 *   MEASURING its box gets nothing to work with. One number for every element is
 *   enough: nothing here asserts a computed size — that is readout-size's job,
 *   and it is arithmetic with no DOM at all — only that a measurement was used
 *   instead of a fraction of the canvas.
 */
export function installRenderDom({ clientHeight }: { clientHeight?: number } = {}): () => void {
  const teardown = installDom();
  const g = globalThis as unknown as Record<string, unknown>;

  // React runs act() quietly only when told it is in a test environment; without
  // this every awaited render logs "not configured to support act(...)".
  g.IS_REACT_ACT_ENVIRONMENT = true;

  if (clientHeight !== undefined) {
    Object.defineProperty((g.HTMLElement as { prototype: object }).prototype, "clientHeight", {
      get: () => clientHeight,
      configurable: true,
    });
  }

  // jsdom ships no EventSource, and a render reaches one: the state hooks open
  // the state stream. Left unstubbed the hook throws on mount; left real it
  // outlives the test and settles after the DOM has gone, which surfaces as the
  // FILE failing while every test in it passes.
  g.EventSource = class {
    static readonly CONNECTING = 0;
    readyState = 0;
    onmessage: unknown = null;
    onerror: unknown = null;
    addEventListener(): void {}
    removeEventListener(): void {}
    close(): void {}
  };

  return () => {
    delete g.EventSource;
    delete g.IS_REACT_ACT_ENVIRONMENT;
    teardown();
  };
}

/**
 * Let React finish everything the last interaction started.
 *
 * A bare `await new Promise((r) => setTimeout(r, 0))` does not. React commits a
 * render and, when that commit leaves passive effects to run, hands the flush to
 * the `scheduler` package rather than running it inline — and the first thing
 * that deferred callback does is read `window.event`. The scheduler drives it
 * from a `setImmediate`, yielding whenever it exceeds its frame budget, so how
 * many macrotask turns it needs is a function of how busy the machine is. Two
 * turns is a guess that holds on an idle box.
 *
 * When it does not hold, the flush lands after the file's last hook has pulled
 * the DOM down, `window` is gone, and the file fails with
 * `ReferenceError: window is not defined` while every test in it passes — there
 * is no test left to attribute it to. That is a rare failure under `npm test`
 * alone and a repeatable one with several suites running at once.
 *
 * `act` is the fix rather than more turns, and it is a different KIND of answer:
 * inside an act scope React queues its work on act's own queue instead of the
 * scheduler, and awaiting the scope drains it. The wait is on the work being
 * done, not on a number of turns being enough.
 *
 * Call it wherever a test would otherwise wait a turn for a fetch, an SSE push
 * or an effect to land:
 *
 *   FakeEventSource.last.push("attendance:history", record);
 *   await settle();
 *
 * and once more in the hook that tears the DOM down — which is what
 * unmountAndTeardown below is for.
 */
export async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * The whole body of a component test file's final `after()` hook.
 *
 * Unmount, let React finish, THEN take the DOM away. That order is the point:
 * an unmount leaves its own passive effects on React's queue, and the flush
 * reads `window`. Tear the DOM down in the same tick and the flush lands on a
 * `window` that no longer exists — the file fails with
 * `ReferenceError: window is not defined` and every test in it passes, because
 * by then there is no test left to blame.
 *
 *   after(() => unmountAndTeardown(cleanup, teardown));
 *
 * `cleanup` is Testing Library's, `teardown` the one installDom returned. They
 * are arguments rather than something this module holds because `cleanup` comes
 * from an `await import("@testing-library/react")` that has not run yet when
 * installDom is called.
 *
 * This is four lines and it was four copies before it was one — the same count,
 * and the same reasoning, as the installRenderDom note above. One copy had
 * already drifted to naming its own test count in prose.
 */
export async function unmountAndTeardown(
  cleanup: () => void,
  teardown: () => void,
): Promise<void> {
  cleanup();
  await settle();
  teardown();
}
