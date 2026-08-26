// The page header's action slot.
//
// It exists because Home's Edit control used to sit on a row of its own below
// the header — two bands of chrome before any content, on the page that most
// wants the height. On a phone it is worse than that: the top bar already shows
// the destination's name, so the header repeated it, and the controls landed a
// third band down.
//
// The property that matters most is the one about LEAVING: a route's actions
// must go when the route does, or the next page inherits a control that edits
// something you are no longer looking at.

import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

const { render, cleanup } = await import("@testing-library/react");
const { PageActionsProvider, PageActionsSlot, usePageActions } = await import("./page-actions.js");

after(() => {
  cleanup();
  teardown();
});

/** A route that puts a button in the header for as long as it is mounted. */
function RouteWithActions({ label }: { label: string }) {
  usePageActions(<button type="button">{label}</button>, [label]);
  return <p>route body</p>;
}

/** A route that supplies nothing, like most of them. */
function PlainRoute() {
  return <p>route body</p>;
}

function shell(route: React.ReactNode) {
  return render(
    <PageActionsProvider>
      <header>
        <PageActionsSlot />
      </header>
      {route}
    </PageActionsProvider>,
  );
}

describe("a route that supplies actions", () => {
  test("they render in the header, not in the route", () => {
    // The whole point: the control is declared by the page and drawn by the
    // chrome above it, which is what lets the phone put it in the top bar and
    // the desktop put it on the title row.
    const { container } = shell(<RouteWithActions label="Edit widgets" />);
    const header = container.querySelector("header")!;
    assert.match(header.textContent ?? "", /Edit widgets/);
    cleanup();
  });

  test("changing them replaces rather than accumulates", () => {
    const { container, rerender } = shell(<RouteWithActions label="Edit widgets" />);
    rerender(
      <PageActionsProvider>
        <header>
          <PageActionsSlot />
        </header>
        <RouteWithActions label="Done" />
      </PageActionsProvider>,
    );
    const header = container.querySelector("header")!;
    assert.equal(header.querySelectorAll("button").length, 1, "the old action is still there");
    assert.match(header.textContent ?? "", /Done/);
    cleanup();
  });
});

describe("a route that does not", () => {
  test("the header draws nothing", () => {
    const { container } = shell(<PlainRoute />);
    assert.equal(container.querySelector("header")!.textContent, "");
    cleanup();
  });

  test("actions LEAVE when the route that supplied them unmounts", () => {
    // THE guard. Without the effect's cleanup, navigating from Home to Plan
    // would leave Home's Edit button sitting on Plan's header, wired to a page
    // that is no longer on screen.
    const { container, rerender } = shell(<RouteWithActions label="Edit widgets" />);
    assert.match(container.querySelector("header")!.textContent ?? "", /Edit widgets/);
    rerender(
      <PageActionsProvider>
        <header>
          <PageActionsSlot />
        </header>
        <PlainRoute />
      </PageActionsProvider>,
    );
    assert.equal(
      container.querySelector("header")!.textContent,
      "",
      "the previous route's actions are still in the header",
    );
    cleanup();
  });
});
