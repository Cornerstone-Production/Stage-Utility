// Duplicating a view that shows mic slot boards asks whether the copy gets boards of
// its own or shares them. A copy that quietly shares edits the original's slots from
// the copy's page; one that quietly copies leaves an operator wondering why the
// second screen did not change. So the question is asked, copying is the default,
// and the answer is what the caller sends.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND (see mic-slots-page.test).

import assert from "node:assert/strict";
import { after, afterEach, describe, test } from "node:test";

import { installRenderDom } from "../../test-dom.js";

const teardown = installRenderDom();

const { render, cleanup, act, screen, fireEvent } = await import("@testing-library/react");
const React = (await import("react")).default;
const { ConfirmHost } = await import("../../components/ui/confirm-dialog.js");
const { TooltipProvider } = await import("../../components/ui/tooltip-provider.js");
const { askDuplicateView, showsBoards } = await import("./screen-confirms.js");

const settle = async () => {
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
afterEach(cleanup);
after(() => teardown());

const slotsView = { id: "v1", name: "Left Display", kind: "slots", createdAt: "" } as View;
const widgetView = {
  id: "v2", name: "Stage Layout", kind: "custom", createdAt: "",
  layout: { version: 1, canvas: { width: 1920, height: 1080 }, objects: [{ id: "g", x: 0, y: 0, w: 1, h: 1, z: 0, config: { type: "slots-grid", boardId: "b" } }] },
} as unknown as View;
const plainView = { id: "v3", name: "Clock", kind: "custom", createdAt: "", layout: { version: 1, canvas: { width: 1920, height: 1080 }, objects: [] } } as unknown as View;

async function ask(view: View, answer: (() => void) | null): Promise<{ copyBoards?: boolean } | null> {
  render(React.createElement(TooltipProvider, null, React.createElement(ConfirmHost, null)));
  let result: { copyBoards?: boolean } | null | undefined;
  await act(async () => {
    void askDuplicateView(view).then((r) => (result = r));
  });
  await settle();
  answer?.();
  await settle();
  return result === undefined ? null : result;
}

describe("duplicating a view that shows boards", () => {
  test("which views those are", () => {
    assert.equal(showsBoards(slotsView), true);
    assert.equal(showsBoards(widgetView), true);
    assert.equal(showsBoards(plainView), false);
  });

  test("a view with no board has nothing to ask", async () => {
    assert.deepEqual(await askDuplicateView(plainView), {}, "and sends no copyBoards");
  });

  test("the default is a copy with boards of its own", async () => {
    const r = await ask(slotsView, () => fireEvent.click(screen.getByRole("button", { name: "Duplicate" })));
    assert.deepEqual(r, { copyBoards: true });
  });

  test("ticking the box shares the boards instead", async () => {
    const r = await ask(widgetView, () => {
      fireEvent.click(screen.getByRole("checkbox"));
      fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    });
    assert.deepEqual(r, { copyBoards: false });
  });

  test("backing out duplicates nothing", async () => {
    const r = await ask(slotsView, () => fireEvent.click(screen.getByRole("button", { name: "Cancel" })));
    assert.equal(r, null);
  });
});
