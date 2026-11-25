// The rules for what a Core's control is, against the Type strings and value
// shapes a Core reports (Q-SYS Designer 10.0.1 in Emulate, probed over QRC).

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { kindOf, unwritableReason } from "./qsys.js";

describe("kindOf", () => {
  test("every Type a Core reports, one per line, sorted, is the kind its writes follow", () => {
    const table: [type: string, value: unknown, kind: string][] = [
      ["Boolean", false, "boolean"],
      ["Boolean", 1, "boolean"],
      ["Float", -10, "number"],
      ["Integer", 0, "number"],
      ["State Trigger", 0, "trigger"],
      ["State Trigger", 2, "trigger"],
      ["Text", "Lobby", "text"],
      ["Trigger", 0, "trigger"],
    ];
    assert.deepEqual(table.map(([t]) => t), table.map(([t]) => t).sort(), "the table is not sorted");
    for (const [Type, Value, kind] of table) assert.equal(kindOf({ Type, Value }), kind, `${Type} with value ${String(Value)}`);
  });

  test("a snapshot's load.N (State Trigger) needs no allowlist range: it is a trigger, not a number", () => {
    assert.equal(unwritableReason({ Type: "State Trigger", Value: 0, Direction: "Read/Write" }, { min: null, max: null }), null);
  });
});
