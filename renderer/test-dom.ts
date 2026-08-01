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
