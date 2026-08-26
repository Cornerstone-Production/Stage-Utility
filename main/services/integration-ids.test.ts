// Every integration is either connection-managed or deliberately not.
//
// integration-manager used to carry TWO identical ladders -- one in setConfig,
// one in setEnabled -- each listing the same nine integrations. Adding Resi and
// YouTube meant remembering both. An integration added to only one would save
// its config and never reconnect, or reconnect on a toggle and not on a save,
// and neither failure says which half was missed.
//
// The ladders are one map now, typed as Record<ConnectionManagedId, …>, so
// LEAVING AN APPLIER OUT is a compile error. This covers the other direction,
// which the type cannot: a brand-new integration id that nobody classified.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { INTEGRATION_IDS, CONNECTION_MANAGED_IDS } from "./integration-ids.js";

/**
 * Integrations with no connection to re-apply, and why. An EXACT set, not a
 * floor: adding an id to INTEGRATION_IDS without deciding which side it belongs
 * on fails here, which is the moment to decide rather than months later.
 */
const NOT_CONNECTION_MANAGED = new Map([
  ["companion", "inbound — the module connects to us"],
  ["rosstalk", "inbound — the switcher connects to us"],
  ["osc", "fire-and-forget UDP, no session to rebuild"],
  ["planning-center", "setConfig and setEnabled do different work; written out at both"],
  ["wireless", "master toggle re-applies every device provider, not one connection"],
]);

describe("integration classification", () => {
  it("every connection-managed id is a real integration", () => {
    const known = new Set<string>(INTEGRATION_IDS);
    const strays = CONNECTION_MANAGED_IDS.filter((id) => !known.has(id));
    assert.deepEqual(strays, [], `not in INTEGRATION_IDS: ${strays.join(", ")}`);
  });

  it("every integration is classified, one way or the other", () => {
    const managed = new Set<string>(CONNECTION_MANAGED_IDS);
    const unclassified = INTEGRATION_IDS.filter(
      (id) => !managed.has(id) && !NOT_CONNECTION_MANAGED.has(id),
    );
    assert.deepEqual(
      unclassified,
      [],
      "these integrations are neither connection-managed nor listed as exempt — decide which, " +
        `and say why in the exempt list:\n  ${unclassified.join("\n  ")}`,
    );
  });

  it("and nothing is claimed to be both", () => {
    const managed = new Set<string>(CONNECTION_MANAGED_IDS);
    const both = [...NOT_CONNECTION_MANAGED.keys()].filter((id) => managed.has(id));
    assert.deepEqual(both, [], `listed as exempt AND connection-managed: ${both.join(", ")}`);
  });

  it("the two lists account for every id exactly once", () => {
    // An exact count rather than a subset check. A floor with slack is how three
    // config stores went missing from every backup with the suite green.
    assert.equal(
      CONNECTION_MANAGED_IDS.length + NOT_CONNECTION_MANAGED.size,
      INTEGRATION_IDS.length,
      `${CONNECTION_MANAGED_IDS.length} managed + ${NOT_CONNECTION_MANAGED.size} exempt ` +
        `should equal ${INTEGRATION_IDS.length} integrations`,
    );
  });
});
