// The Readiness card shows as many checks as its box has room for, measured, not
// guessed. jsdom has no layout, so the box is given a height by hand; that the
// rows then look right at that height was driven in a browser.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { NoStream } from "../../test-fixtures/no-stream.js";
import { installRenderDom, settle, unmountAndTeardown } from "../../test-dom.js";

const teardown = installRenderDom();
(globalThis as unknown as { EventSource: unknown }).EventSource = NoStream;
// The plan's checklist and the stage state never answer: the checks passed in
// are all the card has to show.
globalThis.fetch = (() => new Promise<Response>(() => {})) as typeof fetch;

const { render, cleanup } = await import("@testing-library/react");
const React = await import("react");
const { ReadinessCard } = await import("./cards.js");
const { RouterContextProvider, createRootRoute, createRouter, createMemoryHistory } = await import("@tanstack/react-router");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/"] }) });
await router.load();

const CHECKS = Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, label: `Check ${i}`, detail: "not yet", ok: false, route: "/" }));

/** The checks drawn in a card whose box is `h` tall. */
async function rowsAt(h: number): Promise<number> {
  const proto = (globalThis as unknown as { HTMLElement: { prototype: object } }).HTMLElement.prototype;
  Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => h });
  try {
    const { container, unmount } = render(
      React.createElement(RouterContextProvider as never, { router }, React.createElement(ReadinessCard, { checks: CHECKS })),
    );
    await settle();
    const n = CHECKS.filter((c) => container.textContent?.includes(c.label)).length;
    unmount();
    return n;
  } finally {
    delete (proto as Record<string, unknown>).clientHeight;
  }
}

test("the Readiness card draws fewer checks in a shorter box", async () => {
  // Header 45px, a check 52px: 45 + 2*52 = 149 holds two, 45 + 4*52 = 253 four.
  assert.deepEqual([await rowsAt(149), await rowsAt(253)], [2, 4]);
});
