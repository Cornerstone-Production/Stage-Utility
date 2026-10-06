// The two pure readers of pre-rename shapes. The routes they sit on (a views.json
// load, a view import) are driven in servicecue-migration.test.ts; this holds the
// edge cases that are cheaper to state directly.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { adoptLegacyViewFields, bundledServiceCueLayouts } from "./servicecue-legacy-names.js";

describe("adoptLegacyViewFields", () => {
  test("renames the preset field on a view that has the old one", () => {
    assert.deepEqual(adoptLegacyViewFields([{ id: "a", scriptViewLayoutId: "L1" }]), [{ id: "a", serviceCueLayoutId: "L1" }]);
  });

  test("keeps null, which means all columns", () => {
    assert.deepEqual(adoptLegacyViewFields([{ id: "a", scriptViewLayoutId: null }]), [{ id: "a", serviceCueLayoutId: null }]);
  });

  test("the new field wins when a view has both", () => {
    assert.deepEqual(
      adoptLegacyViewFields([{ id: "a", scriptViewLayoutId: "old", serviceCueLayoutId: "new" }]),
      [{ id: "a", serviceCueLayoutId: "new" }],
    );
  });

  test("a list with nothing to migrate comes back as the same array", () => {
    const views = [{ id: "a" }, { id: "b", serviceCueLayoutId: "L" }];
    assert.equal(adoptLegacyViewFields(views), views);
  });

  test("leaves the other views in a mixed list as they were", () => {
    const keep = { id: "b", name: "B" };
    const out = adoptLegacyViewFields([{ id: "a", scriptViewLayoutId: "L" }, keep]);
    assert.equal(out[1], keep);
  });

  test("is total: whatever a file held passes through without throwing", () => {
    for (const junk of [null, undefined, 3, "x", {}, [null, 4, "y", []]]) {
      assert.doesNotThrow(() => adoptLegacyViewFields(junk), `threw on ${JSON.stringify(junk)}`);
    }
    assert.deepEqual(adoptLegacyViewFields([null, { id: "a", scriptViewLayoutId: "L" }]), [null, { id: "a", serviceCueLayoutId: "L" }]);
  });
});

describe("bundledServiceCueLayouts", () => {
  const L = [{ id: "svl", name: "Audio" }];

  test("reads the current key", () => {
    assert.deepEqual(bundledServiceCueLayouts({ serviceCueLayouts: L }), L);
  });

  test("reads the key an export from before the rename wrote", () => {
    assert.deepEqual(bundledServiceCueLayouts({ scriptviewLayouts: L }), L);
  });

  test("the current key wins when both are present, even if it is empty", () => {
    assert.deepEqual(bundledServiceCueLayouts({ serviceCueLayouts: [], scriptviewLayouts: L }), []);
  });

  test("is empty for a missing, absent or malformed sideData", () => {
    for (const side of [undefined, null, {}, { serviceCueLayouts: "no" }, 5]) {
      assert.deepEqual(bundledServiceCueLayouts(side), []);
    }
  });
});
