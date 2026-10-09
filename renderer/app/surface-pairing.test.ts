// What the view card's handler is, now that the server does the work.
//
// A screen's mode and its view's surface are two fields, and the view card used
// to write both itself: a loop over every screen showing the view, calling the
// mode route for each in an order chosen to satisfy two guards that each wait
// for the other side, and stopping half-way with no rollback when one refused.
// That is one call to POST /api/views/:id/surface now. The order, the rollback
// and the custom-view rule are the server's, driven against the real guards in
// main/services/view-role.test.ts; the question asked first is driven in
// renderer/settings/view-role-change.test.ts.
//
// Source text, because the handler is a closure over a query client inside a
// hook, and what has to hold is which write it makes and that it asks first.
// The text read has its comments blanked, so prose cannot satisfy a match.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

// See the module for why one cut rule, shared.
import { handlerBody, handlerBodyRaw, SETTINGS_SRC } from "./settings-handler-source.js";

describe("the view card's handler", () => {
  const src = handlerBody("handleSetViewSurface");

  test("is ONE call to the view-role route, not a loop over screens", () => {
    assert.match(src, /writeState\("views:setRole"/);
    assert.doesNotMatch(src, /for \(|\.forEach\(|outputs:/, "the handler writes screens itself again");
  });

  test("asks which screens would change before it sends", () => {
    assert.match(src, /changeViewRole\(\{/);
    assert.match(src, /ask: confirm/);
  });

  test("decides from the cache at CALL TIME, not a snapshot the hook closed over", () => {
    // NOT a claim that it re-reads between writes: there is one. What it catches
    // is the real regression, replacing stateNow() with a value destructured in
    // the hook body, which is stale by the time a click arrives and would name
    // the wrong screens in the question.
    assert.match(SETTINGS_SRC, /const stateNow = \(\) => queryClient\.getQueryData<StageState>/);
    assert.match(src, /state: stateNow\(\)/, "handleSetViewSurface works from a stale snapshot");
  });
});

describe("the cut these assertions run over", () => {
  test("THE GUARD: a handler's text stops before the JSDoc of the next one", () => {
    // A source-text assertion satisfied by PROSE is the exact failure CLAUDE.md
    // lists, and this file used to cut at the next `async function` only, so the
    // block comment introducing the NEXT handler was inside this one's "body".
    // The cut was also the ONLY defence: a `//` line inside the handler naming an
    // IPC channel satisfied a match for that channel with the write deleted,
    // which is no longer possible because the text every assertion here reads has
    // its comments blanked.
    //
    // The RAW cut for the boundary, because the blanked one has no comment left
    // to find and the question here is where the cut LANDS.
    // handleSetOutputRole is followed by a handler with a JSDoc, which is the
    // boundary this checks.
    const raw = handlerBodyRaw("handleSetOutputRole");
    assert.ok(
      !raw.includes("/**"),
      "the cut swallowed a block comment, so a sentence can satisfy an assertion about code",
    );
    assert.ok(
      !raw.includes("async function handleSetViewShowInSidebar"),
      "the cut ran into the next handler entirely",
    );
    const src = handlerBody("handleSetOutputRole");
    assert.doesNotMatch(src, /\/\/|\/\*/, "a comment survived into the text the assertions read");
    // And it did not cut so early that there is nothing left to assert on.
    assert.match(src, /outputs:setRole/);
  });
});
