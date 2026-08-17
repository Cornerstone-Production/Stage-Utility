// The idiom aligns left by DEFAULT, not by force.
//
// The first cut of Task 9 hard-coded left into the composition. That kept Home
// looking right and silently broke the alignment control for every readout on
// every custom view — a field still in the inspector, still saving, doing
// nothing. These are the two halves of the fix: left when nothing says
// otherwise, and whatever is stored when something does.

import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

import { LAYOUT_OBJECTS } from "./layout-objects.js";
import { IDIOM_TYPES } from "@main/types/readout-types.js";

// The DOM has to exist before the component module is evaluated — see
// number-input.test.tsx for why this is not a `before` hook.
import { installDom } from "../test-dom.js";

const teardown = installDom();

const { render, cleanup } = await import("@testing-library/react");
const { Readout } = await import("./readout.js");
const { defaultStyle } = await import("./layout-objects.js");

after(() => {
  cleanup();
  teardown();
});

/** The composition's own alignment, read off what it rendered. */
function alignOf(container: HTMLElement): string {
  const root = container.firstElementChild as HTMLElement;
  return root.style.alignItems;
}

describe("a readout with no alignment stored", () => {
  test("aligns left", () => {
    // What makes three stacked lines read as one object rather than three things
    // near each other, and what Home's cards look like.
    const { container } = render(<Readout caption="OBS" value="STANDBY" sub="idle" />);
    assert.equal(alignOf(container), "flex-start");
    cleanup();
  });
});

describe("a readout with an alignment stored", () => {
  test("centre is honoured", () => {
    // THE guard. This is the control that stopped working: a custom view wanting
    // a centred clock as a centrepiece could not have one.
    const { container } = render(<Readout caption="OBS" value="STANDBY" align="center" />);
    assert.equal(alignOf(container), "center");
    cleanup();
  });

  test("right is honoured", () => {
    const { container } = render(<Readout value="STANDBY" align="right" />);
    assert.equal(alignOf(container), "flex-end");
    cleanup();
  });

  test("every line follows, not just the box", () => {
    // The three lines are different widths, and each is positioned by a
    // different element: the caption and sub are full-width spans that align
    // their own text, while the value is an inline-block positioned by the
    // wrapper it sits in. Aligning the flex box alone leaves a centred caption
    // over a left-set value, which reads as a bug rather than a choice.
    //
    // So this walks the three elements that actually do the positioning, in
    // order — not every element with text in it, which is how the first version
    // of this test came out looking at the value's span instead of its wrapper.
    const { container } = render(<Readout caption="OBS" value="STANDBY" sub="idle" align="center" />);
    const root = container.firstElementChild as HTMLElement;
    const positioners = Array.from(root.children).filter(
      (n): n is HTMLElement => n instanceof HTMLElement && (n.textContent ?? "").trim().length > 0,
    );
    assert.equal(positioners.length, 3, "expected a caption, a value wrapper and a sub");
    assert.deepEqual(
      positioners.map((n) => n.style.textAlign),
      ["center", "center", "center"],
    );
    cleanup();
  });
});

describe("new objects", () => {
  test("no readout type ships a stored alignment", () => {
    // Every style preset spreads TEXT(), which writes `textAlign: "center"`, so
    // without stripping it a NEW readout would arrive centred and the default
    // could never be left. An exact walk of the set — a type that slipped
    // through would be the one widget that behaves differently.
    const carrying = [...IDIOM_TYPES].filter((t) => "textAlign" in defaultStyle(t));
    assert.deepEqual(carrying, [], "these readouts still ship a never-chosen alignment");
  });

  test("everything else still ships one", () => {
    // The other half: the strip must be narrow. Text, slide text and service
    // items are centred by design, and quietly left-aligning them would move
    // content on every existing display for no reason anybody asked for.
    const others = Object.keys(LAYOUT_OBJECTS).filter(
      (t) => !IDIOM_TYPES.has(t as never) && "fontSize" in defaultStyle(t as never),
    );
    const missing = others.filter((t) => !("textAlign" in defaultStyle(t as never)));
    assert.deepEqual(missing, [], "the strip reached past the readouts");
  });
});
