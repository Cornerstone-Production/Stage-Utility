// The page's text size and its address under a real TanStack router.
//
// servicecue-view-text-size.test.tsx drives the page with no router above it, where
// the address is rewritten directly. Under the router that would be wrong: a write
// behind its back leaves `router.state.location.search` on the old size, and the
// next navigation that copies it (choosing a plan, say) puts the old size back.
// So the size goes through the router, which this file drives over a memory
// history.
//
// NOT asserted: the real browser address bar. A memory history has none; that was
// driven in a browser instead.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { installDom, settle, unmountAndTeardown } from "../test-dom.js";

const teardown = installDom();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { render, cleanup, fireEvent, act, screen } = await import("@testing-library/react");
const React = (await import("react")).default;
const { createRootRoute, createRoute, createRouter, createMemoryHistory, RouterProvider } = await import("@tanstack/react-router");
const { useTextSize } = await import("./use-servicecue-text-size.js");
const { useSearchParam } = await import("../lib/use-search-param.js");
const { PAGE_TEXT_SIZE_KEY } = await import("./servicecue-text-size.js");

afterEach(() => {
  cleanup();
  localStorage.clear();
});
after(() => unmountAndTeardown(cleanup, teardown));

/** What ServiceCuePlan does with its size and its `?plan=`, and nothing else. */
function Probe() {
  const [size, setSize] = useTextSize(PAGE_TEXT_SIZE_KEY, { syncAddress: true });
  const [plan, setPlan] = useSearchParam("plan");
  return React.createElement(
    "div",
    null,
    React.createElement("span", { "data-testid": "state" }, `${size}/${plan ?? "-"}`),
    React.createElement("button", { onClick: () => setSize(size + 10) }, "bigger"),
    React.createElement("button", { onClick: () => setPlan("p2") }, "other plan"),
  );
}

async function mountAt(url: string) {
  const rootRoute = createRootRoute({});
  const route = createRoute({ getParentRoute: () => rootRoute, path: "/probe", component: Probe });
  const history = createMemoryHistory({ initialEntries: [url] });
  const router = createRouter({ routeTree: rootRoute.addChildren([route]), history });
  render(React.createElement(RouterProvider, { router } as never));
  for (let i = 0; i < 4; i++) await settle();
  return { router, history };
}

test("under the router, a size set from the control reaches the router's own address and survives choosing a plan", async () => {
  window.history.replaceState({}, "", "/probe?text=150&plan=p1");
  const { router, history } = await mountAt("/probe?text=150&plan=p1#top");
  const entries = history.length;
  const search = () => router.state.location.search as Record<string, unknown>;

  await act(async () => void fireEvent.click(screen.getByText("bigger")));
  assert.equal(search().text, 160, "the router still holds the size the link was opened with");
  assert.equal(search().plan, "p1", "another param was lost");
  assert.equal(router.state.location.hash, "top", "the hash was lost");
  assert.equal(history.length, entries, "a press added a history entry");

  // The navigation that copies the router's search must not bring 150 back.
  await act(async () => void fireEvent.click(screen.getByText("other plan")));
  assert.equal(search().plan, "p2");
  assert.equal(search().text, 160, "choosing a plan put the old size back in the address");
});

test("under the router, an address with no ?text= is left without one", async () => {
  window.history.replaceState({}, "", "/probe?plan=p1");
  const { router } = await mountAt("/probe?plan=p1");
  await act(async () => void fireEvent.click(screen.getByText("bigger")));
  assert.equal("text" in (router.state.location.search as Record<string, unknown>), false);
});
