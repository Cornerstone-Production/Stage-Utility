// The rules for what a Core's control is, against the Type strings and value
// shapes a Core reports (Q-SYS Designer 10.0.1 in Emulate, probed over QRC).

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { isOn, kindOf, unwritableReason } from "./qsys.js";

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

describe("isOn", () => {
  test("a Boolean as a Core sends it, as true/false, 1/0 or 1.0/0.0, and as text", () => {
    for (const v of [true, 1, 1.0, "true", "TRUE", " true "]) assert.equal(isOn(v), true, `${JSON.stringify(v)} is on`);
    for (const v of [false, 0, 0.0, -0, "false", "", null, undefined, Number.NaN, "muted", "unmuted"]) assert.equal(isOn(v), false, `${JSON.stringify(v)} is off`);
  });
});
