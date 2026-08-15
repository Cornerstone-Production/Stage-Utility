import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { screenRows } from "./screen-rows.js";

const state = {
  views: [
    { id: "v1", name: "Mic board", kind: "slots" },
    { id: "v2", name: "Stage display", kind: "custom" },
  ],
  outputs: [
    { id: "d1", name: "Booth", viewId: "v1" },
    { id: "d2", name: "Stage right", viewId: "v2", slug: "stage-right" },
    { id: "d3", name: "Lobby", viewId: null },
  ],
} as unknown as StageState;

describe("screen rows", () => {
  test("pairs every screen with the view it shows", () => {
    // The join that was previously in the operator's head.
    const rows = screenRows(state, ["d1"]);
    assert.equal(rows.find((r) => r.outputId === "d1")?.viewName, "Mic board");
    assert.equal(rows.find((r) => r.outputId === "d2")?.viewName, "Stage display");
  });

  test("an unassigned screen reports no view, not an empty name", () => {
    // "no view" and "a view named nothing" must not render identically - one
    // needs fixing and the other does not.
    const row = screenRows(state, [])!.find((r) => r.outputId === "d3")!;
    assert.equal(row.viewName, null);
    assert.equal(row.missingView, false);
  });

  test("a dangling view reference is flagged, not silently blank", () => {
    // A View can be deleted while an Output still points at it. Rendering that
    // as "no view assigned" hides a broken reference behind a normal-looking
    // empty state; the screen shows a placeholder and nobody knows why.
    const dangling = {
      ...state,
      outputs: [{ id: "d9", name: "Ghost", viewId: "deleted-view" }],
    } as unknown as StageState;
    const row = screenRows(dangling, [])[0];
    assert.equal(row.missingView, true);
    assert.equal(row.viewName, null);
  });

  test("presence comes through per screen", () => {
    const rows = screenRows(state, ["d1", "d3"]);
    assert.equal(rows.find((r) => r.outputId === "d1")?.online, true);
    assert.equal(rows.find((r) => r.outputId === "d2")?.online, false);
    assert.equal(rows.find((r) => r.outputId === "d3")?.online, true);
  });

  test("the path prefers a friendly slug, and falls back to the id", () => {
    // The card opens this. `/<id>` always resolves; a slug is optional.
    const rows = screenRows(state, []);
    assert.equal(rows.find((r) => r.outputId === "d2")?.path, "stage-right");
    assert.equal(rows.find((r) => r.outputId === "d1")?.path, "d1");
  });

  test("only a custom view offers a layout to edit", () => {
    // The built-in kinds have no free-form layout, so an Edit layout action on
    // them leads nowhere.
    const rows = screenRows(state, []);
    assert.equal(rows.find((r) => r.outputId === "d1")?.editableLayout, false);
    assert.equal(rows.find((r) => r.outputId === "d2")?.editableLayout, true);
    assert.equal(rows.find((r) => r.outputId === "d3")?.editableLayout, false);
  });

  test("no outputs is an empty list, not a throw", () => {
    assert.deepEqual(screenRows({} as StageState, []), []);
  });
});
