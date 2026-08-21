// Every integration must be reachable from a rule.
//
// Entries are hand-written per integration, which is deliberate — each reads in
// its own words. The cost is drift: a new integration would otherwise have no
// automation until somebody remembered. This turns that from "noticed months
// later" into "fails on the pull request", and names the id that is missing.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { AUTOMATION_CONDITIONS } from "./automation-conditions.js";
import { AUTOMATION_TRIGGERS, INTEGRATIONS } from "./automation-triggers.js";
import { INTEGRATION_IDS } from "./integration-ids.js";

/**
 * Channels something actually broadcasts.
 *
 * Most are `broadcast("...")` call sites; the integration channels
 * (`obs:status`, `reaper:status`, `resi:status`, `youtube:status`,
 * `spl:metrics`, `people:count`) are passed to the IntegrationBase constructor
 * and published from there, so grepping for a literal will not find them.
 */
const BROADCAST_CHANNELS = new Set([
  "attendance:history",
  "baptism:state",
  "displays:presence",
  "integrations:state-changed",
  "obs:status",
  "osc:feedback",
  "patch:updated",
  "pco:live",
  "people:count",
  "prodcom:transcript",
  "propresenter:instances",
  "reaper:status",
  "resi:status",
  "service-timeline:history",
  "slots:devices",
  "spl:history",
  "spl:metrics",
  "stage:state-changed",
  "update:status",
  "youtube:status",
]);

describe("automation coverage", () => {
  test("every integration appears in at least one trigger or condition", () => {
    const ids = [...Object.keys(AUTOMATION_TRIGGERS), ...Object.keys(AUTOMATION_CONDITIONS)];
    const missing = INTEGRATION_IDS.filter((id) => !ids.some((k) => k.startsWith(`${id}.`)));
    assert.deepEqual(
      missing,
      [],
      `No automation entries for: ${missing.join(", ")}. ` +
        "Add a trigger or condition for each, or this integration cannot be automated.",
    );
  });

  test("the trigger registry's integration list matches the shipped one", () => {
    // INTEGRATIONS carries the labels rules are written against; INTEGRATION_IDS
    // is what the manager ships. If they drift, an integration silently loses its
    // connect/disconnect pair or gains one for something that does not exist.
    assert.deepEqual(
      INTEGRATIONS.map((i) => i.id).sort(),
      [...INTEGRATION_IDS].sort(),
    );
  });

  test("every integration has a label, so no rule reads as a raw id", () => {
    for (const i of INTEGRATIONS) {
      assert.ok(i.label.trim().length > 0, `${i.id} has no label`);
      assert.notEqual(i.label, i.id, `${i.id} needs a human label, not its id`);
    }
  });

  test("every registered trigger names a channel that something broadcasts", () => {
    // A typo'd channel is a trigger that can never fire, and nothing else
    // would ever say so.
    for (const t of Object.values(AUTOMATION_TRIGGERS)) {
      assert.ok(
        BROADCAST_CHANNELS.has(t.channel),
        `${t.id} watches unknown channel "${t.channel}"`,
      );
    }
  });

  test("no two entries share an id", () => {
    for (const [key, t] of Object.entries(AUTOMATION_TRIGGERS)) {
      assert.equal(key, t.id, `trigger registered as "${key}" but declares id "${t.id}"`);
    }
    for (const [key, c] of Object.entries(AUTOMATION_CONDITIONS)) {
      assert.equal(key, c.id, `condition registered as "${key}" but declares id "${c.id}"`);
    }
  });
});
