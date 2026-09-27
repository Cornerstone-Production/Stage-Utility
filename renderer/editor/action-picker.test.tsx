// The Action select on an action-button object.
//
// RENDERED, not asserted over the array it builds — see cue-picker.test.tsx
// for why: a picker that built the right list and rendered none of it would
// pass a guard over the array alone.

import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

const { render, cleanup, fireEvent } = await import("@testing-library/react");
const React = await import("react");
const { ActionPicker } = await import("./action-picker.js");

after(() => {
  cleanup();
  teardown();
});

const ACTIONS = [
  { id: "baptism.advance", label: "Advance the baptism timer" },
  { id: "baptism.back", label: "Step the baptism timer back" },
  { id: "log.message", label: "Write a log message" },
];

describe("the action picker", () => {
  test("lists every action, labelled — the same list and the same labels the rule editor shows", () => {
    const { container } = render(
      React.createElement(ActionPicker as never, { actions: ACTIONS, value: "", onChange: () => {} }),
    );
    const options = [...container.querySelectorAll("option")].filter((o) => o.value !== "");
    assert.deepEqual(
      options.map((o) => [o.value, o.textContent]),
      [
        ["baptism.advance", "Advance the baptism timer"],
        ["baptism.back", "Step the baptism timer back"],
        ["log.message", "Write a log message"],
      ],
    );
  });

  test("picking one reports the action's id", () => {
    const picked: string[] = [];
    const { container } = render(
      React.createElement(ActionPicker as never, { actions: ACTIONS, value: "", onChange: (v: string) => picked.push(v) }),
    );
    fireEvent.change(container.querySelector("select")!, { target: { value: "baptism.advance" } });
    assert.deepEqual(picked, ["baptism.advance"]);
  });

  test("a stored id the registry no longer has is still shown as its own option, not blanked", () => {
    const { container } = render(
      React.createElement(ActionPicker as never, { actions: ACTIONS, value: "baptism.retired", onChange: () => {} }),
    );
    const select = container.querySelector("select")!;
    assert.equal(select.value, "baptism.retired");
  });

  test("with no registry answer yet, still renders a usable (empty) select rather than throwing", () => {
    const { container } = render(
      React.createElement(ActionPicker as never, { actions: null, value: "", onChange: () => {} }),
    );
    assert.ok(container.querySelector("select"));
  });
});
