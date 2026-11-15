// The phone drawer and the pinned sidebar Customize mode uses.
//
// Pinning replaces the modal drawer with a plain panel. The drawer has to close
// for good when that happens: it is how Customize is usually reached on a phone
// (the drawer's own long-press menu), and a drawer left "open" underneath came
// straight back when Done unpinned it, over the page the operator was returning to.
//
// Not tested here: that the closing drawer stops drawing the sidebar the moment
// it is pinned. jsdom runs no exit animation, so the drawer's content is gone at
// once either way; in a browser it lingered, and its second copy of every
// draggable row stopped a touch drag on the pinned sidebar. Driven at 390 px.

import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";

import { installRenderDom, unmountAndTeardown } from "../../test-dom.js";

const teardown = installRenderDom();
// A phone: every max-width query matches, so SplitView takes its drawer branch.
window.matchMedia = ((query: string) => ({
  matches: query.includes("max-width"),
  media: query,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  onchange: null,
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const { render, screen, cleanup, act, fireEvent } = await import("@testing-library/react");
const { SplitView } = await import("./split-view.js");
const { TooltipProvider } = await import("./index.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

function View({ pinned }: { pinned: boolean }) {
  return (
    <TooltipProvider>
      <SplitView pinned={pinned} sidebar={<nav>the rail</nav>}>
        <main>the page</main>
      </SplitView>
    </TooltipProvider>
  );
}

test("a drawer open when the sidebar is pinned does not come back when it is unpinned", async () => {
  const { rerender } = render(<View pinned={false} />);
  fireEvent.click(screen.getAllByRole("button", { name: "Open navigation" })[0]);
  assert.equal(screen.queryAllByRole("dialog").length, 1, "the drawer did not open");

  await act(async () => rerender(<View pinned />));
  assert.equal(screen.queryAllByRole("dialog").length, 0, "the modal drawer is still open beside the pinned sidebar");

  await act(async () => rerender(<View pinned={false} />));
  assert.equal(screen.queryAllByRole("dialog").length, 0, "Done reopened the drawer");
});
