// layout-editor-saved-groups.test.tsx — the editor's Saved groups library, when
// its read fails.
//
// The read used to `.catch(() => setGroups([]))`, and the library then showed
// its first-run hint, "Select a container and use the package icon … to save
// it as a reusable group", which tells an operator with a library full of
// groups that they have none.
//
// Driven through the real hook and the real block, wired the way the editor
// wires them (see saved-groups.tsx for why not the whole editor), with a
// stubbed fetch. NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND —
// node:assert inspects `actual` to build its failure message, and inspecting a
// live jsdom element does not finish in any useful time.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { installRenderDom, settle, unmountAndTeardown } from "../test-dom.js";
import { alerts, ok, stubFetchWithLog } from "../test-fixtures/fetch-log.js";

const teardown = installRenderDom();

const { render, screen, cleanup, fireEvent } = await import("@testing-library/react");
const React = await import("react");
const { SavedGroupsLibrary, useSavedGroups } = await import("./saved-groups.js");
const { TooltipProvider } = await import("../components/ui/index.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

const GROUP = { id: "g1", name: "Lower third", object: { id: "o1" } } as unknown as LayoutGroup;

function stubFetch(answer: "fail" | LayoutGroup[]) {
  return stubFetchWithLog((url) => {
    if (url.includes("/api/layout-groups")) {
      if (answer === "fail") throw new TypeError("fetch failed");
      return ok(answer);
    }
    return ok({});
  });
}

/** The editor's wiring, plus a button standing in for a save: saveSelectedAsGroup
 *  hands `replace` the whole list the server answered with. */
function Library() {
  const saved = useSavedGroups();
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(SavedGroupsLibrary, { saved, onInsert: () => {}, onDelete: () => {} }),
    React.createElement("button", { type: "button", onClick: () => saved.replace([GROUP]) }, "simulate a save"),
  );
}

async function mount(): Promise<void> {
  render(React.createElement(TooltipProvider, null, React.createElement(Library)));
  await settle();
  await settle();
}

const FIRST_RUN_HINT = /save it as a reusable group/i;

test("a failed library read says so, never the first-run hint, and reaches the log", async () => {
  const f = stubFetch("fail");
  try {
    await mount();
    assert.match(alerts(), /Couldn't load the saved groups/i);
    assert.equal(!!screen.queryByText(FIRST_RUN_HINT), false, "a failed read is not an empty library");
    assert.ok(
      f.logs.some((l) => l.tag === "layout-editor" && /saved groups/i.test(l.message)),
      `expected a [layout-editor] line naming the saved groups — got ${JSON.stringify(f.logs)}`,
    );
  } finally {
    f.restore();
  }
});

test("a save after a failed read shows the list it answered with, and stops alerting", async () => {
  const f = stubFetch("fail");
  try {
    await mount();
    assert.match(alerts(), /Couldn't load the saved groups/i);
    fireEvent.click(screen.getByRole("button", { name: "simulate a save" }));
    await settle();
    assert.equal(!!screen.queryByText("Lower third"), true);
    assert.equal(alerts(), "", "the library is known now");
  } finally {
    f.restore();
  }
});

test("control: an empty library shows the first-run hint, with no alert", async () => {
  const f = stubFetch([]);
  try {
    await mount();
    assert.equal(!!screen.queryByText(FIRST_RUN_HINT), true);
    assert.equal(alerts(), "");
    assert.deepEqual(f.logs, []);
  } finally {
    f.restore();
  }
});

test("control: a library that loads lists its groups", async () => {
  const f = stubFetch([GROUP]);
  try {
    await mount();
    assert.equal(!!screen.queryByText("Lower third"), true);
    assert.equal(alerts(), "");
  } finally {
    f.restore();
  }
});
