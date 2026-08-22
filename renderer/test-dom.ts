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
