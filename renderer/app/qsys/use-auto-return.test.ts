// useAutoReturn: the count from the last touch, and going home at zero.
//
// A tiny page in a real memory router, with a countdown second of a few
// milliseconds, so a minute passes in a few hundred. The cog, the banner's words
// and `?return=` are pinned in qsys-cog-menu.test.tsx, through the panel route.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { compileWithReactCompiler } from "../../test-fixtures/react-compiler-hook.js";
import { installDom, unmountAndTeardown } from "../../test-dom.js";

const compiled = compileWithReactCompiler((url) => /\/renderer\/app\/qsys\/use-auto-return\.ts$/.test(url));
const teardown = installDom();

const { render, cleanup, fireEvent, act } = await import("@testing-library/react");
const React = (await import("react")).default;
const { createRootRoute, createRoute, createRouter, createMemoryHistory, RouterProvider } = await import("@tanstack/react-router");
const { useAutoReturn, formatCountdown, __setAutoReturnSecondForTests } = await import("./use-auto-return.js");

after(() => unmountAndTeardown(cleanup, teardown));

const SECOND = 5; // ms: a minute is 300 ms
beforeEach(() => __setAutoReturnSecondForTests(SECOND));
afterEach(() => {
  cleanup();
  __setAutoReturnSecondForTests(null);
});

const wait = (ms: number) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });

let seen: (number | null)[] = [];
let router: { state: { location: { pathname: string } } };

async function open(homeSlug: string | null, minutes: number) {
  seen = [];
  function Away() {
    const { secondsLeft } = useAutoReturn(homeSlug, minutes);
    seen.push(secondsLeft);
    return React.createElement("div", { "data-away": true }, String(secondsLeft));
  }
  const root = createRootRoute();
  const routes = [
    createRoute({ getParentRoute: () => root, path: "/qsys/away", component: Away }),
    createRoute({ getParentRoute: () => root, path: "/qsys/$slug", component: () => React.createElement("div", { "data-home": true }) }),
  ];
  const r = createRouter({ routeTree: root.addChildren(routes), history: createMemoryHistory({ initialEntries: ["/qsys/away"] }) });
  router = r as unknown as typeof router;
  render(React.createElement(RouterProvider, { router: r }));
  await wait(20);
}

const path = () => router.state.location.pathname;

describe("useAutoReturn", () => {
  test("runs through the React Compiler here", () => {
    assert.deepEqual(compiled(), ["use-auto-return.ts"]);
  });

  test("after N minutes with no touch it navigates home", async () => {
    await open("zone-1", 1);
    assert.equal(seen[0], 60, "the count did not start at the full minute");
    await wait(150);
    assert.equal(path(), "/qsys/away", "it went home early");
    await wait(300);
    assert.equal(path(), "/qsys/zone-1");
  });

  test("any pointer event resets the countdown", async () => {
    await open("zone-1", 1);
    // Touch every 100 ms for 600 ms: twice the minute, and never 300 ms untouched.
    for (let i = 0; i < 6; i++) {
      await wait(100);
      // On a child, as a fader would see it; the listener is on window in the capture phase.
      fireEvent.pointerMove(document.querySelector("[data-away]")!);
    }
    assert.equal(path(), "/qsys/away", "a touch did not reset the count");
    await wait(450);
    assert.equal(path(), "/qsys/zone-1", "it never went home once the touches stopped");
  });

  test("a touch that stops propagation still counts: the listener is on window, capturing", async () => {
    await open("zone-1", 1);
    const el = document.querySelector("[data-away]")!;
    el.addEventListener("pointerdown", (e) => e.stopPropagation());
    for (let i = 0; i < 5; i++) {
      await wait(100);
      fireEvent.pointerDown(el);
    }
    assert.equal(path(), "/qsys/away", "a touch an object kept to itself did not reset the count");
  });

  test("a key press resets it too", async () => {
    await open("zone-1", 1);
    for (let i = 0; i < 5; i++) {
      await wait(100);
      fireEvent.keyDown(document.querySelector("[data-away]")!, { key: "a" });
    }
    assert.equal(path(), "/qsys/away");
  });

  test("returnAfterMin 0 never returns", async () => {
    await open("zone-1", 0);
    await wait(450);
    assert.equal(path(), "/qsys/away");
    assert.ok(seen.every((s) => s === null), `counted: ${JSON.stringify(seen)}`);
  });

  test("with no home there is nothing to count", async () => {
    await open(null, 5);
    await wait(100);
    assert.equal(path(), "/qsys/away");
    assert.ok(seen.every((s) => s === null));
  });

  test("m:ss", () => {
    assert.deepEqual([300, 61, 60, 9, 0, -3].map(formatCountdown), ["5:00", "1:01", "1:00", "0:09", "0:00", "0:00"]);
  });
});
