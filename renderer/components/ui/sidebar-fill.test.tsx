// The rail's colour has to cover the rail, however long it gets.
//
// Reported from a phone: scrolling the navigation drawer ran out of grey, and
// the last items and the footer sat on white. The cause is exact — `h-full`
// inside a SCROLLER sizes the box to the scroller's VISIBLE height, so the
// coloured box was one viewport tall while the content was taller, and
// everything past that scrolled onto the drawer's own background.
//
// jsdom has no layout engine, so this cannot measure the heights that made the
// bug visible; that was verified in a browser (grey box 844px against 844px of
// content, having been 700px). What it CAN do is render the real component and
// read what it actually emits, which is where the one-word difference lives.

import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

import { installDom } from "../../test-dom.js";

const teardown = installDom();

const { render, cleanup } = await import("@testing-library/react");
const { Sidebar } = await import("./sidebar.js");

after(() => {
  cleanup();
  teardown();
});

/** The classes the rendered sidebar root actually carries. */
function rootClasses(): string[] {
  const { container } = render(<Sidebar>nav</Sidebar>);
  const classes = (container.firstElementChild as HTMLElement).className.split(/\s+/);
  cleanup();
  return classes;
}

describe("the sidebar's coloured box", () => {
  test("grows with its content rather than stopping at the viewport", () => {
    // THE guard. min-h-full still fills a container taller than the content —
    // so the footer's mt-auto keeps pinning to the bottom — and grows when the
    // content is the taller of the two, which h-full cannot do.
    const classes = rootClasses();
    assert.ok(classes.includes("min-h-full"), "the sidebar no longer grows to its content");
    assert.ok(
      !classes.includes("h-full"),
      "h-full is back: inside a scroller it caps the coloured box at one viewport",
    );
  });

  test("it carries the rail colour at all", () => {
    // Guards the other half: a box of the right height with no background is
    // the same bug wearing different clothes.
    assert.ok(rootClasses().includes("bg-rail"), "the sidebar lost its background");
  });
});
