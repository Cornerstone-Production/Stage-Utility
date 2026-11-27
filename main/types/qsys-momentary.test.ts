// panelHasMomentary: the server leases a held control only for a button saved as momentary.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { panelHasMomentary } from "./qsys.js";
import type { LayoutObjectConfig, View } from "./views.js";

const A = { component: "Lobby_Mixer", control: "talk" };
const view = (config: LayoutObjectConfig, nested = false): View =>
  ({
    id: "p1",
    layout: { objects: nested ? [{ id: "c", config: { type: "container" }, children: [{ id: "b", config }] }] : [{ id: "b", config }] },
  }) as unknown as View;
const button = (press?: "trigger" | "momentary"): LayoutObjectConfig => ({ type: "qsys-button", binding: A, label: "", hold: false, ...(press ? { press } : {}) });

describe("panelHasMomentary", () => {
  test("only a button saved as momentary takes a lease", () => {
    assert.equal(panelHasMomentary([view(button("momentary"))], "p1", A), true);
    assert.equal(panelHasMomentary([view(button("trigger"))], "p1", A), false);
    assert.equal(panelHasMomentary([view(button())], "p1", A), false, "absent is a trigger");
  });

  test("found inside a container, and only on its own control and panel", () => {
    assert.equal(panelHasMomentary([view(button("momentary"), true)], "p1", A), true);
    assert.equal(panelHasMomentary([view(button("momentary"))], "p1", { ...A, control: "other" }), false);
    assert.equal(panelHasMomentary([view(button("momentary"))], "p2", A), false);
    assert.equal(panelHasMomentary([view(button("momentary"))], null, A), false);
  });
});
