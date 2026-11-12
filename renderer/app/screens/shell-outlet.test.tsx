// shell-outlet.test.tsx — the shell draws the Screens page, once, and only on
// Screens.
//
// The router's own `/screens` component draws nothing (ScreensRouteSlot): the page
// is drawn by ShellOutlet beside the <Outlet/>, kept across navigation. So nothing
// else in renderer/app would notice if the shell stopped drawing it: every route
// test stays green with an empty Screens page. This renders ShellOutlet, which is
// exactly what the shell renders in its page pane, under a real memory router.
// (The shell itself cannot render in jsdom: its live wiring's reconnect loop never
// settles, see page-scroll-reset.test.tsx.)
//
// A stand-in page is passed for Screens: the real one needs the whole stage state,
// and the question here is how many get drawn, and where.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { installRenderDom, unmountAndTeardown } from "../../test-dom.js";

const teardown = installRenderDom();

const { render, cleanup, act } = await import("@testing-library/react");
const React = await import("react");
const { RouterProvider, createRootRoute, createRoute, createRouter, createMemoryHistory, useRouterState } = await import(
  "@tanstack/react-router"
);
const { ShellOutlet, ScreensRouteSlot } = await import("./kept-screens.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

function Root() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return React.createElement(ShellOutlet, {
    pathname,
    resetKey: 0,
    screens: React.createElement("section", { "data-testid": "screens-page" }, "Screens page"),
  });
}

async function renderAt(path: string): Promise<number> {
  const root = createRootRoute({ component: Root });
  const home = createRoute({ getParentRoute: () => root, path: "/", component: () => React.createElement("p", null, "Home") });
  const screens = createRoute({ getParentRoute: () => root, path: "/screens", component: ScreensRouteSlot });
  const router = createRouter({
    routeTree: root.addChildren([home, screens]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(React.createElement(RouterProvider, { router }));
    await router.load();
  });
  return view.container.querySelectorAll('[data-testid="screens-page"]').length;
}

for (const [path, pages] of [
  ["/screens", 1],
  ["/screens/", 1],
  ["/", 0],
] as const) {
  test(`at ${path} the shell draws ${pages} Screens page${pages === 1 ? "" : "s"}`, async () => {
    assert.equal(await renderAt(path), pages);
  });
}
