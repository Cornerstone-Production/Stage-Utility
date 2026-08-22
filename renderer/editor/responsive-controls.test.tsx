// Two controls that were doing nothing, or doing something to themselves.

import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

// The DOM has to exist before the component module is evaluated — see
// number-input.test.tsx for why this is not a `before` hook.
import { installDom } from "../test-dom.js";

const teardown = installDom();

const { render, cleanup, fireEvent } = await import("@testing-library/react");
const { ResponsiveControls } = await import("./responsive-controls.js");

after(() => {
  cleanup();
  teardown();
});

describe("the pin grid", () => {
  test("cannot be squeezed by the sentence beside it", () => {
    // Reported as "it heavily smushed together when I clicked one of the
    // options", and that is exactly what it did: pinning swaps the hint for a
    // LONGER sentence, and a shrinkable flex item gives up its width to make
    // room. The grid is what got narrower — the control squashing itself as a
    // direct result of being used.
    const { container } = render(<ResponsiveControls settings={{}} onChange={() => {}} />);
    const grid = container.querySelector('[aria-label="Pin to edges"]')!;
    assert.ok(grid, "the pin grid is gone");
    assert.match(grid.className, /\bshrink-0\b/, "the pin grid can be shrunk by its neighbour again");
    cleanup();
  });

  test("the hint really does get longer when a cell is pinned", () => {
    // The other half of the same fact: without this, the test above is guarding
    // a squeeze that nothing applies.
    const unpinned = render(<ResponsiveControls settings={{}} onChange={() => {}} />);
    const short = unpinned.container.textContent ?? "";
    cleanup();

    const pinned = render(
      <ResponsiveControls settings={{ anchor: { x: "right", y: "bottom" } }} onChange={() => {}} />,
    );
    const long = pinned.container.textContent ?? "";
    cleanup();

    assert.ok(long.length > short.length, "pinning no longer lengthens the hint");
  });

  test("clicking a cell pins it, and clicking it again lets go", () => {
    let last: unknown = null;
    const { container } = render(
      <ResponsiveControls settings={{}} onChange={(patch) => { last = patch; }} />,
    );
    const cell = container.querySelector('[aria-label="Pin bottom right"]') as HTMLElement;
    fireEvent.click(cell);
    assert.deepEqual(last, { anchor: { x: "right", y: "bottom" } });
    cleanup();

    const on = render(
      <ResponsiveControls
        settings={{ anchor: { x: "right", y: "bottom" } }}
        onChange={(patch) => { last = patch; }}
      />,
    );
    fireEvent.click(on.container.querySelector('[aria-label="Pin bottom right"]') as HTMLElement);
    assert.deepEqual(last, { anchor: {} }, "there is no way back to proportional");
    cleanup();
  });
});
