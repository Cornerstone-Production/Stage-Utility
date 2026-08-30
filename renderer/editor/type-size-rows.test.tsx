// A control that does nothing must not be offered.
//
// Every type in IDIOM_TYPES draws through `Readout`, which works its caption,
// value and sub-line sizes out of the BOX HEIGHT and hard-codes their weights.
// It reads neither `style.fontSize` nor `style.fontWeight`. The inspector
// offered both anyway, so an operator could set an attendance or SPL widget to
// 48px and watch nothing move — reported exactly that way.
//
// Rendered, not read off the source. The inspector proper needs a stack of live
// integration hooks to mount, which is why the decision lives in its own
// component: this mounts the real rows and asks what is actually in the DOM.

import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

import type { LayoutObjectType } from "../../main/types/stage.js";
import { IDIOM_TYPES } from "../../main/types/readout-types.js";
import { LAYOUT_OBJECTS } from "../main/layout-objects.js";
import { installDom } from "../test-dom.js";

const teardown = installDom();

const { render, cleanup } = await import("@testing-library/react");
const React = await import("react");
const { TypeSizeRows, sizesTypeFromItsBox } = await import("./inspector-rows.js");

after(() => {
  cleanup();
  teardown();
});

/** The row labels the component put on screen for this type. */
function rowsFor(type: LayoutObjectType): string[] {
  const { container, unmount } = render(
    React.createElement(TypeSizeRows as never, {
      type,
      style: {},
      canvasHeight: 1080,
      onStyle: () => {},
    }),
  );
  // Row renders its label as the first span of the row; a note is a bare <p>.
  const labels = [...container.querySelectorAll("span.truncate")].map((el) => el.textContent ?? "");
  unmount();
  return labels;
}

describe("the type-size rows a widget is offered", () => {
  test("a plain Text object gets both, because it renders at the size they set", () => {
    const rows = rowsFor("text" as LayoutObjectType);
    assert.deepEqual(rows, ["Font size", "Weight"]);
  });

  test("every self-sizing readout gets NEITHER, and is told why", () => {
    // EVERY member, not the two that were reported. `people-counter` (attendance)
    // and `spl-meter` are the ones the operator named; the other thirteen were
    // just as dead.
    assert.equal(IDIOM_TYPES.size, 15, "IDIOM_TYPES changed size — re-check this list");
    for (const t of IDIOM_TYPES) {
      const rows = rowsFor(t);
      assert.deepEqual(rows, [], `${t} still offers ${rows.join(" + ")}, which it does not read`);
    }
  });

  test("the reason is on screen, not merely absent", () => {
    // A row that vanishes with no explanation reads as a missing feature. Both
    // widgets the operator named must SAY that they size themselves.
    for (const t of ["people-counter", "spl-meter"] as LayoutObjectType[]) {
      const { container, unmount } = render(
        React.createElement(TypeSizeRows as never, { type: t, style: {}, canvasHeight: 1080, onStyle: () => {} }),
      );
      const note = container.querySelector("p")?.textContent ?? "";
      assert.match(note, /sets its own type/, `${t} hides the rows without saying why`);
      assert.match(note, /bigger/, `${t} does not tell the operator what to do instead`);
      unmount();
    }
  });

  test("the predicate and the registry agree on who sizes itself", () => {
    const selfSizing = (Object.keys(LAYOUT_OBJECTS) as LayoutObjectType[]).filter(sizesTypeFromItsBox);
    assert.equal(selfSizing.length, 15);
    assert.deepEqual(new Set(selfSizing), IDIOM_TYPES);
    // And the control still exists for the objects that honour it, so this is a
    // narrowing rather than a removal.
    assert.equal(sizesTypeFromItsBox("text" as LayoutObjectType), false);
    assert.equal(sizesTypeFromItsBox("view-embed" as LayoutObjectType), false);
  });
});
