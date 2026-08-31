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

import { JSDOM } from "jsdom";

/** Globals a React render expects to find. */
const EXPOSED = [
  "window",
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
