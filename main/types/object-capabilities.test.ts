import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { CAPABILITIES, DRILLDOWN, hasCapability, isControl } from "./object-capabilities.js";

// Exhaustiveness is the compiler's job here — CAPABILITIES is
// Record<LayoutObjectType, ...>, so a new object type with no entry fails tsc.
// These cover what the type system cannot: that the entries are RIGHT, not
// merely present.
//
// The failure that matters is a control object treated as a readout. It would
// render ungated on every wall display, and nothing would fail.

describe("capability registry", () => {
  test("covers every object type, and the count is exact", () => {
    // A floor with slack is how three config stores went missing from every
    // backup while the suite stayed green.
    assert.equal(
      Object.keys(CAPABILITIES).length,
      41,
      "41 object types exist — if this number changed, decide the new type's capabilities deliberately",
    );
  });

  test("the three existing interactive objects are controls", () => {
    // These render on real screens today. Demoting one to a readout would make
    // a working control surface silently stop responding.
    for (const t of ["osc-button", "rosstalk-button", "live-controls"] as const) {
      assert.ok(isControl(t), `${t} must be a control`);
    }
  });

  test("nothing else is a control", () => {
    // The other half. A readout wrongly marked as a control would pull its View
    // to "console" during migration and drag a wall display into panel mode.
    const controls = Object.entries(CAPABILITIES)
      .filter(([, caps]) => caps.includes("control"))
      .map(([t]) => t)
      .sort();
    assert.deepEqual(controls, ["action-button", "live-controls", "osc-button", "rosstalk-button"]);
  });

  test("every drill-down target belongs to an object that declares drilldown", () => {
    // A target on an object without the capability is dead configuration - it
    // reads as wired up and does nothing.
    for (const type of Object.keys(DRILLDOWN)) {
      assert.ok(
        hasCapability(type as never, "drilldown"),
        `${type} has a drill-down route but does not declare the capability`,
      );
    }
  });

  test("every drilldown-capable object has somewhere to go", () => {
    // The other direction: a capability with no route renders as a link to
    // nowhere.
    for (const [type, caps] of Object.entries(CAPABILITIES)) {
      if (caps.includes("drilldown")) {
        assert.ok(DRILLDOWN[type as never], `${type} declares drilldown but names no route`);
      }
    }
  });

  test("drill-down routes are paths", () => {
    for (const [type, route] of Object.entries(DRILLDOWN)) {
      assert.ok(route?.startsWith("/"), `${type}: ${route} is not a path`);
    }
  });

  test("every object renders something", () => {
    // An object with no capabilities at all would be invisible in every context.
    for (const [type, caps] of Object.entries(CAPABILITIES)) {
      assert.ok(caps.length > 0, `${type} declares no capabilities`);
    }
  });
});
