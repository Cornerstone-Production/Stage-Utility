// What a caught failure is allowed to say.
//
// `fetchFailureMessage` exists because Node's message for EVERY network failure
// is the two words "fetch failed" — the address, the port and the errno are one
// level down on `cause`. Companion's button picker put "Could not read
// Companion's configuration: fetch failed" on screen for a dead port, which is a
// sentence an operator can do nothing with; the REAPER transport action would
// have said the same for a booth machine that is switched off.
//
// It lived as a private method on CompanionApi and is shared now, so these are
// its tests rather than a second copy of them.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { errorMessage, fetchFailureMessage } from "./errors.js";

describe("fetchFailureMessage", () => {
  test("says the CAUSE, which is the only part that names the errno", () => {
    const err = new Error("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:8874") });
    assert.equal(fetchFailureMessage(err, "127.0.0.1:8874"), "connect ECONNREFUSED 127.0.0.1:8874");
  });

  test("a bare fetch failure names what was being dialled", () => {
    // No cause at all — some runtimes and some polyfills throw it bare. Without
    // the target this is the useless sentence the helper exists to remove.
    assert.equal(
      fetchFailureMessage(new Error("fetch failed"), "127.0.0.1:8874"),
      "could not reach 127.0.0.1:8874",
    );
  });

  test("any other message is passed through, with the target appended once", () => {
    assert.equal(
      fetchFailureMessage(new Error("REAPER returned HTTP 500"), "10.0.0.9:8080"),
      "REAPER returned HTTP 500 (10.0.0.9:8080)",
    );
  });

  test("a message that already names the address is not told twice", () => {
    // The cause usually carries the address, and two copies of it read as two
    // different failures.
    const err = new Error("fetch failed", { cause: new Error("connect EHOSTUNREACH 10.0.0.9:8080") });
    assert.equal(fetchFailureMessage(err, "http://10.0.0.9:8080"), "connect EHOSTUNREACH 10.0.0.9:8080");
  });

  test("a non-Error is still said, rather than swallowed", () => {
    assert.equal(fetchFailureMessage("nope", "10.0.0.9:8080"), "nope (10.0.0.9:8080)");
    assert.equal(errorMessage("nope"), "nope");
  });
});
