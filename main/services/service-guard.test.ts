// The "allowed during a service" switch is a view over the `service.is-not-live`
// condition, not a second flag on the rule. These guard the three ways that view
// could drift from the condition it reads: reporting the wrong state, adding a
// second copy instead of leaving an existing one alone, and leaving a duplicate
// behind when the switch turns the guard off.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { hasServiceGuard, SERVICE_GUARD_CONDITION_ID, withServiceGuard } from "./service-guard.js";

describe("hasServiceGuard", () => {
  test("false for a rule with no conditions", () => {
    assert.equal(hasServiceGuard([]), false);
  });

  test("false when the rule's conditions do not include it", () => {
    assert.equal(hasServiceGuard([{ id: "service.type-is", params: {} }]), false);
  });

  test("true when it is present", () => {
    assert.equal(hasServiceGuard([{ id: SERVICE_GUARD_CONDITION_ID, params: {} }]), true);
  });

  test("true when it is present alongside other conditions", () => {
    assert.equal(
      hasServiceGuard([
        { id: "service.type-is", params: { serviceTypeId: "x" } },
        { id: SERVICE_GUARD_CONDITION_ID, params: {} },
      ]),
      true,
    );
  });
});

describe("withServiceGuard", () => {
  test("guarded=true on a rule with none adds exactly one, at the end", () => {
    const other = { id: "service.type-is", params: { serviceTypeId: "x" } };
    const next = withServiceGuard([other], true);
    assert.deepEqual(next, [other, { id: SERVICE_GUARD_CONDITION_ID, params: {} }]);
  });

  test("guarded=true on a rule that already has it leaves the list untouched", () => {
    const existing: { id: string; params: Record<string, string | number> }[] = [
      { id: "service.type-is", params: { serviceTypeId: "x" } },
      { id: SERVICE_GUARD_CONDITION_ID, params: {} },
    ];
    const next = withServiceGuard(existing, true);
    assert.deepEqual(next, existing);
  });

  test("guarded=false removes it and leaves every other condition untouched", () => {
    const other = { id: "service.type-is", params: { serviceTypeId: "x" } };
    const next = withServiceGuard([other, { id: SERVICE_GUARD_CONDITION_ID, params: {} }], false);
    assert.deepEqual(next, [other]);
  });

  test("guarded=false removes every instance when the rule has it more than once", () => {
    const other = { id: "service.type-is", params: { serviceTypeId: "x" } };
    const next = withServiceGuard(
      [
        { id: SERVICE_GUARD_CONDITION_ID, params: {} },
        other,
        { id: SERVICE_GUARD_CONDITION_ID, params: {} },
      ],
      false,
    );
    assert.deepEqual(next, [other]);
  });

  test("guarded=false on a rule that already has none is a no-op", () => {
    const other = { id: "service.type-is", params: { serviceTypeId: "x" } };
    assert.deepEqual(withServiceGuard([other], false), [other]);
  });
});
