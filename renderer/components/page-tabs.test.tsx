// page-tabs.test.tsx — the strip Advanced and Automation share: which tab an arrow
// key reaches, and that a move does not select the way a click does.
//
// The reason `onMove` exists apart from `onSelect`: landing on Search by arrow key
// must not jump the cursor into its box mid-arrow. The page decides what each
// does; the strip's part is to call the right one.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND: see
// advanced-search-tab.test.tsx.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { installRenderDom, unmountAndTeardown } from "../test-dom.js";

const teardown = installRenderDom();

const { render, screen, cleanup, fireEvent } = await import("@testing-library/react");
const { PageTabBar, tabAfterKey } = await import("./page-tabs.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

const TABS = [
  { id: "a", name: "Alpha" },
  { id: "b", name: "Bravo" },
  { id: "c", name: "Charlie" },
] as const;
const ORDER = ["a", "b", "c", "search"] as const;

describe("tabAfterKey", () => {
  test("the arrows step along the strip, Search last, and wrap at both ends", () => {
    assert.equal(tabAfterKey(ORDER, "a", "ArrowRight"), "b");
    assert.equal(tabAfterKey(ORDER, "c", "ArrowRight"), "search");
    assert.equal(tabAfterKey(ORDER, "search", "ArrowRight"), "a");
    assert.equal(tabAfterKey(ORDER, "a", "ArrowLeft"), "search");
    assert.equal(tabAfterKey(ORDER, "b", "ArrowLeft"), "a");
  });

  test("Home and End go to the ends; any other key is none of its business", () => {
    assert.equal(tabAfterKey(ORDER, "b", "Home"), "a");
    assert.equal(tabAfterKey(ORDER, "b", "End"), "search");
    assert.equal(tabAfterKey(ORDER, "b", "Enter"), null);
    assert.equal(tabAfterKey(ORDER, "b", "ArrowDown"), null);
  });
});

describe("PageTabBar", () => {
  function mount(tab: string, calls: string[]) {
    render(
      <PageTabBar
        label="Demo"
        tabs={TABS}
        searchId="search"
        tab={tab}
        onSelect={(t) => calls.push(`select ${t}`)}
        onMove={(t) => calls.push(`move ${t}`)}
        idPrefix="demo-tab"
        panelId="demo-panel"
      />,
    );
  }

  test("Search is the last tab and the only one pushed right", () => {
    mount("a", []);
    const tabs = screen.getAllByRole("tab").map((t) => t.textContent);
    assert.deepEqual(tabs, ["Alpha", "Bravo", "Charlie", "Search"]);
    assert.ok(screen.getByRole("tab", { name: "Search" }).className.includes("ml-auto"));
    assert.ok(!screen.getByRole("tab", { name: "Alpha" }).className.includes("ml-auto"));
  });

  test("only the selected tab is in the tab order", () => {
    mount("b", []);
    assert.deepEqual(
      screen.getAllByRole("tab").map((t) => t.getAttribute("tabindex")),
      ["-1", "0", "-1", "-1"],
    );
  });

  test("a click selects", () => {
    const calls: string[] = [];
    mount("a", calls);
    fireEvent.click(screen.getByRole("tab", { name: "Charlie" }));
    assert.deepEqual(calls, ["select c"]);
  });

  test("an arrow key moves focus and reports a move, not a selection", () => {
    const calls: string[] = [];
    mount("a", calls);
    fireEvent.keyDown(screen.getByRole("tab", { name: "Alpha" }), { key: "ArrowRight" });
    assert.deepEqual(calls, ["move b"]);
    assert.equal(document.activeElement?.id, "demo-tab-b");
  });

  test("a key with a modifier is left to the browser", () => {
    const calls: string[] = [];
    mount("a", calls);
    fireEvent.keyDown(screen.getByRole("tab", { name: "Alpha" }), { key: "ArrowRight", metaKey: true });
    assert.deepEqual(calls, []);
  });
});
