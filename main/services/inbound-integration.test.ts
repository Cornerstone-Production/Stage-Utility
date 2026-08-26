// An integration that DIALS US has no off switch, and the app must not pretend
// otherwise.
//
// Companion is the one: its module opens an HTTP/SSE connection to this server,
// and nothing in setEnabled ever gated that. So the row carried a switch that
// did nothing — turn it off and the Stream Deck went on controlling the app —
// and the `false` it left in settings became the app's own record of a state it
// was not in. Downstream, the context bar reads that record.
//
// Against the REAL descriptors, so a second inbound integration added later is
// held to the same rule rather than quietly getting a dead switch of its own.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

process.env.STAGE_UTILITY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "inbound-integration-"));

const { enabledFor, INTEGRATION_DESCRIPTORS } = await import("./integration-manager.js");

const byId = (id: string) => {
  const d = INTEGRATION_DESCRIPTORS.find((x) => x.id === id);
  assert.ok(d, `no ${id} descriptor — this guard is looking at the wrong list`);
  return d;
};

describe("which integrations dial us", () => {
  test("Companion does, and it is the only one", () => {
    // An EXACT set. A new inbound integration must come here and be considered,
    // because everything below follows from the flag.
    assert.deepEqual(
      INTEGRATION_DESCRIPTORS.filter((d) => d.inbound).map((d) => d.id),
      ["companion"],
    );
  });
});

describe("whether an integration is on at load", () => {
  test("an inbound one is on with a stored false — the server is listening either way", () => {
    assert.equal(
      enabledFor(byId("companion"), { companion: false }),
      true,
      "a stored false was honoured: the app claims to be off while it answers the module",
    );
  });

  test("and on with nothing stored at all", () => {
    assert.equal(enabledFor(byId("companion"), undefined), true);
    assert.equal(enabledFor(byId("companion"), {}), true);
  });

  test("an ordinary integration still honours its stored value, both ways", () => {
    // The flag is narrow. OBS dials out, so its switch means something.
    assert.equal(enabledFor(byId("obs"), { obs: false }), false);
    assert.equal(enabledFor(byId("obs"), { obs: true }), true);
    assert.equal(enabledFor(byId("obs"), undefined), false);
  });
});
