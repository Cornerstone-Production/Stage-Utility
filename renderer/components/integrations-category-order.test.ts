// Every integration has a place in the integrations grid.
//
// `CATEGORY_ORDER` in integrations-panel.tsx lays the cards out by purpose, and
// `rank()` answers `ORDER.length` for an id that is not in it — the right answer
// for an id a NEWER server has and this build does not, and the wrong one for an
// integration this build ships. Nothing could tell the two apart, so `companion`
// sorted to the end of its half for as long as it has existed, silently, with
// the doc comment two lines above the list saying "sixteen integrations" over a
// list of fifteen.
//
// THE SECOND OF TWO GUARDS. The first is the type checker: `EveryIntegrationIsPlaced`
// in that file constrains `Exclude<IntegrationId, Placed>` to `never`, so a
// missing integration is a compile error naming the id. `npm test` runs under
// tsx, which strips types without checking them, so that half only fires under
// `npx tsc --noEmit`.
//
// EXACT SET EQUALITY, both ways, and an exact count. A subset would pass on
// exactly the bug this exists for, and the panel's own comment already knew the
// real number while the list did not.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { INTEGRATION_IDS } from "@main/services/integration-ids";

import { CATEGORY_ORDER_IDS } from "./integrations-panel.js";

describe("the integrations grid's category order", () => {
  test("places exactly the integrations this build ships", () => {
    assert.deepEqual([...CATEGORY_ORDER_IDS].sort(), [...INTEGRATION_IDS].sort());
  });

  test("sixteen, exactly, and each named once", () => {
    // An exact count, not a floor. The duplicate check is separate because a
    // list holding one id twice and missing another has the right length and
    // the right set is not enough to say so.
    assert.equal(INTEGRATION_IDS.length, 16);
    assert.equal(CATEGORY_ORDER_IDS.length, 16);
    assert.equal(new Set(CATEGORY_ORDER_IDS).size, 16);
  });
});
