// LeaveGuard's `flush`: before a link or Back asks about unsaved work, it is given the chance
// to store it somewhere safe (the plot editor's kept draft). Stored, the page is left without a
// question; not stored, it asks as it always did. The editor's own leave test drives this
// through the whole page; this pins the guard on its own, with a message per case, so a guard
// that stops calling `flush` fails here on an assertion and not on a timeout.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND (see mic-slots-page.test).

import assert from "node:assert/strict";
import { after, afterEach, describe, test } from "node:test";

import { installRenderDom, isPlumbing } from "../test-dom.js";

const teardown = installRenderDom();

(globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown) => {
  if (isPlumbing(String(input))) return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
  return { ok: true, status: 200, statusText: "OK", json: async () => ({}), text: async () => "{}" };
};

const { render, cleanup, act, fireEvent, screen, within } = await import("@testing-library/react");
const React = (await import("react")).default;
const { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter, Link } = await import("@tanstack/react-router");
const { LeaveGuard } = await import("./leave-guard.js");
const { ConfirmHost } = await import("./ui/confirm-dialog.js");
const { TooltipProvider } = await import("./ui/tooltip-provider.js");

afterEach(cleanup);
after(() => teardown());

const settle = async () => {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

async function mount(flush: () => Promise<boolean>) {
  const root = createRootRoute({
    component: () =>
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(LeaveGuard, { dirty: true, message: "Your latest changes have not reached the server.", flush }),
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

/** Click the link, and let the guard decide. Never awaits the navigation itself: a guard that asks holds it. */
const go = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole("link", { name: "go elsewhere" }));
  });
  await settle();
};

/** A question left open would hold the navigation past the test: answered Cancel. */
async function answerAnyQuestion() {
  const dialog = screen.queryByRole("alertdialog");
  if (!dialog) return;
  await act(async () => {
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  });
  await settle();
}

describe("leaving with work a flush can store", () => {
  test("a flush that stores it lets the link go without asking", async () => {
    let flushes = 0;
    const router = await mount(async () => {
      flushes++;
      return true;
    });
    try {
      await go();
      assert.equal(flushes, 1, "the guard did not try to store the work before deciding");
      assert.equal(screen.queryByRole("alertdialog") === null, true, "it asked although the flush stored the work");
      assert.equal(router.state.location.pathname, "/elsewhere");
    } finally {
      await answerAnyQuestion();
    }
  });

  test("a flush that cannot store it asks, and Cancel stays", async () => {
    let flushes = 0;
    const router = await mount(async () => {
      flushes++;
      return false;
    });
    try {
      await go();
      assert.equal(flushes, 1);
      const dialog = screen.queryByRole("alertdialog");
      assert.equal(dialog === null, false, "it let the work go without asking although the flush could not store it");
      assert.ok((dialog?.textContent ?? "").includes("have not reached the server"));
    } finally {
      await answerAnyQuestion();
    }
    assert.equal(router.state.location.pathname, "/", "Cancel must leave the operator where the work is");
  });
});
