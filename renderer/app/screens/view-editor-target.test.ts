// The layout editor edits the view in the URL, and no other.
//
// useStageSettings is per-component — there is no shared context — so every
// caller gets its own selectedViewId, and its resync defaults that to the FIRST
// view. ViewEditorRoute resolved `view` from params.viewId for everything it
// rendered, but the slot editor reads `localSlots` and writes
// `views:setSlots {id: selectedViewId}` through the hook's selection.
//
// Opening /screens/B/edit on the second slots view therefore showed A's slots
// under B's name, and Save wrote them onto A. The AlignmentPanel directly above
// used view.id correctly, which is how two halves of one editor came to target
// two different views. screens-route calls setSelectedViewId before navigating,
// but on its OWN hook instance, which reaches nothing.
//
// SCOPE, stated so the gap is deliberate. Two checks, because the bug needed
// both halves to be wrong:
//   1. the RULE — selectViewId is the function the hook actually calls, not a
//      copy of it here. A test that re-implemented the rule would pass whether
//      or not the hook used it, which is exactly how this repo's sameOrigin
//      guard once went green while nothing called sameOrigin.
//   2. the WIRING — that the route hands its URL id to the hook at all. The rule
//      being right is worth nothing if nobody passes the id.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { selectViewId } from "../use-stage-settings.js";

describe("which view the layout editor writes to", () => {
  it("a pinned id wins over the hook's own default", () => {
    assert.equal(
      selectViewId("view-b", "view-a"),
      "view-b",
      "this is the bug: the hook defaulted to view-a and saved the slots there",
    );
  });

  it("and is never replaced when it does not resolve", () => {
    // Editing a view deleted in another tab must render nothing, not silently
    // retarget the save at whichever view happens to be first.
    assert.equal(selectViewId("gone", "view-a"), "gone");
  });

  it("with nothing pinned, the caller's own selection still governs", () => {
    // The Views master-detail has no URL to pin, and must keep working.
    assert.equal(selectViewId(undefined, "view-a"), "view-a");
  });

  it("the editor route actually passes its URL id to the hook", () => {
    // The wiring half. Matches on the CALL, which prose in a comment cannot
    // satisfy — a mention of params.viewId anywhere else in the file will not do.
    const src = readFileSync(new URL("./view-editor-route.tsx", import.meta.url), "utf8");
    assert.match(
      src,
      /useStageSettings\(\s*params\.viewId\s*\)/,
      "ViewEditorRoute must pin the hook to the view in the URL, or the slot editor " +
        "defaults to the first view and saves there",
    );
  });
});
