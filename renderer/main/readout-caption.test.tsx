// The idiom's composition, rendered rather than read out of the source.
//
// The property is the one existing layouts depend on: a readout with no caption
// shows no caption. It was a regex over layout-renderer.tsx, which broke when
// ObjectContent was rewritten in a way that preserved the behaviour exactly —
// a source-text guard cannot tell those apart, so this renders the component and
// looks at what came out.

import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

// The DOM has to exist before the component module is evaluated, which is why
// this is not a `before` hook — see number-input.test.tsx.
import { installDom } from "../test-dom.js";

const teardown = installDom();

const { render, cleanup } = await import("@testing-library/react");
const { Readout } = await import("./readout.js");

after(() => {
  cleanup();
  teardown();
});

/** The rendered text of each line, top to bottom, blanks dropped. */
function linesOf(el: HTMLElement): string[] {
  return Array.from(el.querySelectorAll("span, div"))
    .map((n) => (n.children.length === 0 ? (n.textContent ?? "").trim() : ""))
    .filter(Boolean);
}

describe("a readout with no caption", () => {
  test("renders the value alone", () => {
    // THE guard. Captions ship on six types and only on NEW objects, so every
    // countdown on every stage display that exists today has none. If the idiom
    // supplied one, all of them would sprout a line nobody asked for.
    const { container } = render(<Readout value="0:04:12" />);
    assert.deepEqual(linesOf(container), ["0:04:12"]);
    cleanup();
  });

  test("an empty-string caption counts as none", () => {
    // The stored value is `string | null`, and "" is what an operator clearing
    // the field leaves behind. A blank caption line is a gap in the composition
    // that pushes the value off-centre.
    const { container } = render(<Readout caption="" value="0:04:12" />);
    assert.deepEqual(linesOf(container), ["0:04:12"]);
    cleanup();
  });
});

describe("the composition", () => {
  test("caption, value and sub render in that order", () => {
    // The order is the idiom. Caption under the value reads as a footnote, and
    // the sub above it reads as a second caption.
    const { container } = render(<Readout caption="OBS" value="RECORDING" sub="00:35:09" />);
    assert.deepEqual(linesOf(container), ["OBS", "RECORDING", "00:35:09"]);
    cleanup();
  });

  test("a sub-line without a caption is allowed", () => {
    const { container } = render(<Readout value="RECORDING" sub="00:35:09" />);
    assert.deepEqual(linesOf(container), ["RECORDING", "00:35:09"]);
    cleanup();
  });
});
