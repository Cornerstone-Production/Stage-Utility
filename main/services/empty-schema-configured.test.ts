// An integration with no config fields must still be able to say it is set up.
//
// `configured` used to end at `Object.values(state.config).some(…)`. For an
// integration that declares `configSchema: []` and keeps its setup in its own
// store, `state.config` is `{}` and that expression is false forever — so it was
// NEVER configured. Live scores is the one the operator hit: its card reopened
// itself on every visit to the Integrations page, because an unconfigured card
// opens by default, and it never left "Not set up" no matter how many teams were
// followed. wireless and osc had the same hole and had been patched one at a
// time; rosstalk, added later, had not.
//
// Against the REAL descriptors, so the next schema-less integration is held to
// the rule rather than shipping the same way.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

process.env.STAGE_UTILITY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "empty-schema-configured-"));

const { INTEGRATION_DESCRIPTORS, OUT_OF_BAND_CONFIGURED_IDS, configuredFor } = await import(
  "./integration-manager.js"
);

/** Nothing set up anywhere — the state a fresh install is in. */
const NOTHING = {
  wirelessConnections: 0,
  oscTargets: 0,
  rossTalkTargets: 0,
  followedTeams: 0,
};

describe("integrations whose setup is not in state.config", () => {
  test("every schema-less integration has an answer, and no other one claims to", () => {
    // EXACT, both ways. A new integration declaring `configSchema: []` without an
    // entry would be permanently "not set up"; an entry for an integration that
    // does have fields would quietly override them.
    const schemaLess = INTEGRATION_DESCRIPTORS
      .filter((d) => d.configSchema.length === 0 && !d.inbound)
      .map((d) => d.id)
      .sort();
    assert.deepEqual(
      [...OUT_OF_BAND_CONFIGURED_IDS].sort(),
      schemaLess,
      "a schema-less integration with no out-of-band answer can never read as set up",
    );
  });

  test("live scores is configured once a team is followed", () => {
    // The reported bug, stated directly. Scores has no config fields at all, so
    // this is false under the `state.config` fallback whatever the operator does.
    assert.equal(
      configuredFor({ id: "scores", config: {} }, { ...NOTHING, followedTeams: 2 }, false),
      true,
      "scores with followed teams read as not set up — its card reopens on every visit",
    );
  });

  test("and not configured with no teams followed", () => {
    assert.equal(configuredFor({ id: "scores", config: {} }, NOTHING, false), false);
  });

  test("wireless, osc and rosstalk answer from their own lists", () => {
    for (const [id, setup] of [
      ["wireless", { ...NOTHING, wirelessConnections: 1 }],
      ["osc", { ...NOTHING, oscTargets: 1 }],
      ["rosstalk", { ...NOTHING, rossTalkTargets: 1 }],
    ] as const) {
      assert.equal(configuredFor({ id, config: {} }, setup, false), true, `${id} with a list entry`);
      assert.equal(configuredFor({ id, config: {} }, NOTHING, false), false, `${id} with an empty list`);
    }
  });

  test("an integration WITH fields still answers from its config", () => {
    // The out-of-band table must not have swallowed the ordinary path.
    assert.equal(configuredFor({ id: "obs", config: { host: "192.168.1.50" } }, NOTHING, false), true);
    assert.equal(configuredFor({ id: "obs", config: {} }, NOTHING, false), false);
  });

  test("an inbound integration is set up by existing", () => {
    assert.equal(configuredFor({ id: "companion", config: {} }, NOTHING, true), true);
  });
});
