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
    // An exact sorted list, not a bare count. The duplicate check is separate
    // because a list holding one id twice and missing another has the right
    // length and the right set is not enough to say so.
    const EXPECTED = [
      "companion",
      "obs",
      "osc",
      "planning-center",
      "prodcom",
      "propresenter",
      "pvp",
      "reaper",
      "resi",
      "ross-tsl",
      "rosstalk",
      "scores",
      "sensource",
      "smaart",
      "wireless",
      "youtube",
    ];
    assert.deepEqual(
      [...INTEGRATION_IDS].sort(),
      EXPECTED,
      "an integration was added or removed; update this list deliberately",
    );
    assert.deepEqual([...CATEGORY_ORDER_IDS].sort(), EXPECTED);
    assert.deepEqual([...new Set(CATEGORY_ORDER_IDS)].sort(), EXPECTED, "a duplicate id shares a slot with a missing one");
  });
});
