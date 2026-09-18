// A context menu with nothing in it.
//
// Reached for real: the History Overview builds its items from the Smaart
// metrics in scope, and a scope with none produced an empty array. The card
// guards its own render, but a component that takes `items` and is handed `[]`
// should not be the reason a page misbehaves — the caller is one refactor away
// from forgetting, and "an empty menu" is the kind of thing nobody tries.
//
// Written after a red proof in this session failed as a 31-second whole-FILE
// timeout rather than an assertion, which is the shape of a hang and worth
// pinning down rather than leaving as a note.

import assert from "node:assert/strict";
import { after, afterEach, describe, test } from "node:test";

import { installRenderDom } from "../../test-dom.js";

const teardown = installRenderDom();

const { render, cleanup } = await import("@testing-library/react");
const React = (await import("react")).default;
const { ContextMenu } = await import("./context-menu.js");

afterEach(cleanup);
after(() => {
  cleanup();
  teardown();
});

describe("a context menu with no items", () => {
  test("renders nothing at all, rather than an empty box", () => {
    // An empty bordered rectangle following the pointer is worse than no menu:
    // it looks like a menu that failed to load, and it swallows the next click
    // through its own dismiss listener.
    const r = render(
      React.createElement(ContextMenu, { x: 10, y: 10, items: [], onClose: () => {} }),
    );
    assert.equal(r.container.innerHTML, "", `an empty menu drew something: ${r.container.innerHTML}`);
    r.unmount();
  });

  test("a menu WITH items still draws", () => {
    // The positive half: the guard must not be "render nothing, ever".
    const r = render(
      React.createElement(ContextMenu, {
        x: 10,
        y: 10,
        items: [{ label: "Metric", onSelect: () => {} }],
        onClose: () => {},
      }),
    );
    assert.ok(r.container.textContent?.includes("Metric"), "the guard took a real menu with it");
    r.unmount();
  });
});
