import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { MAX_LABEL, allowEntryFor } from "./qsys-allow-entry.js";

describe("allowEntryFor", () => {
  test("takes the Core's range, and none when the Core reports none or half of one", () => {
    assert.deepEqual(allowEntryFor("Lobby_Mixer", { Name: "output.1.gain", ValueMin: -100, ValueMax: 20 }), {
      component: "Lobby_Mixer",
      control: "output.1.gain",
      label: "Lobby_Mixer output.1.gain",
      min: -100,
      max: 20,
      confirm: "none",
    });
    for (const c of [{ Name: "x" }, { Name: "x", ValueMin: 0 }, { Name: "x", ValueMin: 5, ValueMax: 1 }]) {
      const e = allowEntryFor("Zone 1", c);
      assert.deepEqual([e.min, e.max], [null, null]);
    }
  });

  test("two components' gain get distinct labels", () => {
    const a = allowEntryFor("Mixer A", { Name: "gain" });
    const b = allowEntryFor("Mixer B", { Name: "gain" });
    assert.notEqual(a.label, b.label);
  });

  test("a long name is cut to the label limit", () => {
    assert.equal(allowEntryFor("C", { Name: "n".repeat(500) }).label.length, MAX_LABEL);
  });
});
