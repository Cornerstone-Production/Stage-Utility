// Leaving the Mic slots page with unsaved work asks first, and refusing keeps the
// page and its edits where they were.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND (see mic-slots-page.test).

import assert from "node:assert/strict";
import { after, afterEach, describe, test } from "node:test";

import { installRenderDom, isPlumbing } from "../../test-dom.js";

const teardown = installRenderDom();

(globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown) => {
  if (isPlumbing(String(input))) return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
  return { ok: true, status: 200, statusText: "OK", json: async () => ({}), text: async () => "{}" };
};

const { render, cleanup, act, fireEvent, screen, within } = await import("@testing-library/react");
const React = (await import("react")).default;
const { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter, Link } = await import("@tanstack/react-router");
const { LeaveGuard } = await import("./mic-slots-page.js");
const { ConfirmHost } = await import("../../components/ui/confirm-dialog.js");
const { TooltipProvider } = await import("../../components/ui/tooltip-provider.js");

afterEach(cleanup);
after(() => teardown());

const settle = async () => {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

async function mount(dirty: boolean) {
  const root = createRootRoute({
    component: () =>
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(LeaveGuard, { dirty, count: 2 }),
        React.createElement(Link, { to: "/elsewhere" as never }, "go elsewhere"),
        React.createElement(ConfirmHost, null),
      ),
  });
  const here = createRoute({ getParentRoute: () => root, path: "/", component: () => React.createElement("span", null, "on the page") });
  const there = createRoute({ getParentRoute: () => root, path: "/elsewhere", component: () => React.createElement("span", null, "elsewhere") });
  const router = createRouter({ routeTree: root.addChildren([here, there]), history: createMemoryHistory({ initialEntries: ["/"] }) });
  render(React.createElement(RouterProvider, { router }));
  await settle();
  return router;
}

const go = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole("link", { name: "go elsewhere" }));
  });
  await settle();
};

describe("leaving with unsaved work", () => {
  test("asks, naming how many boards, and Cancel keeps the page", async () => {
    const router = await mount(true);
    await go();
    const dialog = screen.getByRole("alertdialog");
    assert.ok((dialog.textContent ?? "").includes("2 boards have changes that are not saved"));
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    });
    await settle();
    assert.equal(router.state.location.pathname, "/", "Cancel must leave the operator where the edits are");
  });

  test("Leave goes", async () => {
    const router = await mount(true);
    await go();
    await act(async () => {
      fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Leave" }));
    });
    await settle();
    assert.equal(router.state.location.pathname, "/elsewhere");
  });

  test("with nothing unsaved it does not ask", async () => {
    const router = await mount(false);
    await go();
    assert.equal(document.querySelector("[role=alertdialog]"), null);
    assert.equal(router.state.location.pathname, "/elsewhere");
  });
});
