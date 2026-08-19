// A nav row can carry a badge, and it must still say what the badge means.
//
// The dot on Advanced is the only visible signal in a COLLAPSED rail, where the
// label is `sr-only` — so it cannot hang off the text, and a screen reader
// cannot describe it. The row's accessible name has to carry the meaning.
//
// This renders the real component rather than asserting on the rail, because
// what is being pinned is the extension point: `children` positioned inside a
// row that is `relative`, and an overridable accessible name. The rail's use of
// it (which row, when) is availability logic, tested in update-notices.test.ts.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { installDom } from "../../test-dom.js";

const teardown = installDom();

const { render, cleanup } = await import("@testing-library/react");
const { SidebarListItem } = await import("./sidebar.js");

afterEach(() => cleanup());
after(() => teardown());

describe("a nav row with a badge", () => {
  test("renders the badge as a child of the row", () => {
    const view = render(
      <SidebarListItem title="Advanced">
        <span data-testid="dot" />
      </SidebarListItem>,
    );
    const row = view.getByRole("button");
    assert.ok(row.querySelector('[data-testid="dot"]'), "the badge is not inside the row");
  });

  test("the row is positioned, so a badge can pin to its corner", () => {
    // Without this the dot lands wherever flex puts it, which in a collapsed
    // rail is on top of the icon.
    const view = render(<SidebarListItem title="Advanced"><span /></SidebarListItem>);
    assert.match(view.getByRole("button").className, /\brelative\b/);
  });

  test("the accessible name can say why the badge is there", () => {
    const view = render(
      <SidebarListItem title="Advanced" ariaLabel="Advanced, update available">
        <span />
      </SidebarListItem>,
    );
    assert.ok(view.getByRole("button", { name: "Advanced, update available" }));
  });

  test("without an override the row is still named by its label", () => {
    const view = render(<SidebarListItem title="Advanced" />);
    assert.ok(view.getByRole("button", { name: /Advanced/ }));
  });
});
