// The dialog must not promise a restart the server cannot perform.
//
// "The displays go blank and reload for a few seconds while the server restarts"
// was shown before a config restore on an install with no service manager. The
// server stopped instead, and the operator had been told the opposite.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { restartConsequence, restartOutcome } from "./restart-warning.js";

describe("what the operator is told before an action that exits", () => {
  it("says the server will STOP when nothing will restart it", () => {
    const msg = restartConsequence(false);
    assert.match(msg, /STOP/, "must say the server stops");
    assert.match(msg, /start it yourself/i, "must say who has to start it");
    assert.doesNotMatch(msg, /few seconds/i, "must not promise a brief blip");
  });

  it("promises the brief blip only when something will restart it", () => {
    assert.match(restartConsequence(true), /few seconds/i);
    assert.doesNotMatch(restartConsequence(true), /STOP/);
  });

  it("an older server that does not report it keeps the old wording", () => {
    // undefined = the field predates this build. Every supervised install did
    // come back, so assuming otherwise would warn every operator about nothing.
    assert.equal(restartConsequence(undefined), restartConsequence(true));
  });
});

describe("what the operator is told afterwards", () => {
  it("does not claim to be restarting when it has stopped", () => {
    const msg = restartOutcome(false, "Restored.");
    assert.match(msg, /stopped/i);
    assert.doesNotMatch(msg, /restarting/i, "the server is not restarting - it is off");
  });

  it("says restarting when it is", () => {
    assert.match(restartOutcome(true, "Restored."), /restarting/i);
  });

  it("keeps the caller's own sentence", () => {
    assert.ok(restartOutcome(false, "Restored.").startsWith("Restored."));
    assert.ok(restartOutcome(true, "Restored.").startsWith("Restored."));
  });
});
