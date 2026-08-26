import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { canEditInPlace } from "./can-edit.js";

// The chrome must not mount outside the operator shell. This is the same rule
// Phase 3 established for capabilities, applied to editing — and reusing that
// function rather than restating it, so the two cannot drift.

const console_ = { surface: "console" } as View;
const display = { surface: "display" } as View;
const legacy = {} as View; // no surface field: an existing views.json

describe("canEditInPlace", () => {
  test("a console in the shell can be edited in place", () => {
    assert.equal(canEditInPlace(console_, "shell"), true);
  });

  test("a console on a PANEL cannot", () => {
    // A panel is pinned to a wall. Whoever is standing at it must not be able to
    // rearrange it — that is the whole reason editing is shell-only.
    assert.equal(canEditInPlace(console_, "panel"), false);
  });

  test("a wall display cannot, in any context", () => {
    assert.equal(canEditInPlace(display, "display"), false);
    assert.equal(canEditInPlace(display, "panel"), false);
    // Not even in the shell: a display's layout is edited on its own page,
    // where there is no live surface to overlay.
    assert.equal(canEditInPlace(display, "shell"), false);
  });

  test("a view with no surface field cannot be edited in place", () => {
    // Absent means display, the safe default. An existing layout must not
    // suddenly gain editing chrome because it was opened in the shell.
    assert.equal(canEditInPlace(legacy, "shell"), false);
  });
});
