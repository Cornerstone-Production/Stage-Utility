import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { installDom } from "../../test-dom.js";

const teardown = installDom();
const { bindableViews } = await import("./outputs-section.js");

// What the picker OFFERS. Still convenience, not the safety property — the
// server refuses a console view on a display screen regardless, and that
// refusal is tested separately by attempting it.
//
// It used to HIDE console views from a display screen, which meant the only
// route to a control surface was to know to flip the screen's mode first, in a
// different menu, before the view you wanted appeared at all. Everything is
// offered now; picking a console view offers to switch the screen, and the
// switch is awaited before the binding is sent so the server never sees the
// pair in the order it refuses.
//
// Asserted on the offered SET rather than on markup: which options render is
// the behaviour, and a markup assertion breaks every time the pill is restyled.

const view = (id: string, surface?: "display" | "console") =>
  ({ id, name: id, kind: "custom", createdAt: "", ...(surface ? { surface } : {}) }) as View;

const VIEWS = [
  view("wall", "display"),
  view("legacy"), // no surface field at all — an existing views.json
  view("foh", "console"),
];

describe("bindableViews", () => {
  test("a display screen IS offered a console, so the switch can be offered", () => {
    // This asserted the opposite, and that was the friction: the view you were
    // reaching for was missing until you had already found a second switch.
    const offered = bindableViews(VIEWS, { id: "o", name: "Lobby", viewId: null } as Output);
    assert.deepEqual(offered.map((v) => v.id), ["wall", "legacy", "foh"]);
  });

  test("a screen with no mode field is offered everything too", () => {
    // The default that matters: an Output written before this field existed.
    const offered = bindableViews(VIEWS, {} as Output);
    assert.ok(offered.some((v) => v.id === "foh"));
  });

  test("a panel is offered everything", () => {
    // A panel is a superset - it renders read-only content perfectly well.
    const offered = bindableViews(VIEWS, { mode: "panel" } as Output);
    assert.deepEqual(offered.map((v) => v.id), ["wall", "legacy", "foh"]);
  });

  test("a view with no surface field is offered to a display screen", () => {
    // Every existing view is surface-less until the migration runs. If these
    // vanished from the picker, an install would look like it had lost its
    // views.
    const offered = bindableViews([view("legacy")], {} as Output);
    assert.deepEqual(offered.map((v) => v.id), ["legacy"]);
  });

  test("does not mutate or alias the list it was given", () => {
    const input = [view("a", "display")];
    const offered = bindableViews(input, { mode: "panel" } as Output);
    offered.push(view("b", "display"));
    assert.equal(input.length, 1, "the caller's array must not be shared with the result");
  });
});

teardown();
