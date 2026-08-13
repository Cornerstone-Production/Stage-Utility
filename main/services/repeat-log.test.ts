import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RepeatLog } from "./repeat-log.js";

// The bug: a poller whose credentials went stale wrote one line per tick — 900
// an hour at the live cadence — into a 500-line ring buffer, evicting every
// other line including whatever you opened /log to read.

const T0 = 1_700_000_000_000;
const MIN = 60_000;

describe("RepeatLog", () => {
  it("logs the first failure and then goes quiet", () => {
    const r = new RepeatLog("[p]");
    assert.equal(r.fail("boom", T0).line, "[p] boom");
    for (let i = 1; i <= 100; i++) {
      assert.equal(r.fail("boom", T0 + i * 1000).line, null, `repeat ${i} must be silent`);
    }
  });

  it("a DIFFERENT failure is always news", () => {
    // Otherwise a stale-credentials error masks the network error that replaced
    // it, and the log says the wrong thing is broken.
    const r = new RepeatLog("[p]");
    r.fail("auth failed", T0);
    assert.equal(r.fail("network unreachable", T0 + 1000).line, "[p] network unreachable");
    // ...and the new message then collapses on its own terms.
    assert.equal(r.fail("network unreachable", T0 + 2000).line, null);
  });

  it("reminds every 15 minutes, with the count, so a long outage is not invisible", () => {
    const r = new RepeatLog("[p]");
    r.fail("boom", T0);
    assert.equal(r.fail("boom", T0 + 14 * MIN).line, null, "not yet");
    const remind = r.fail("boom", T0 + 15 * MIN);
    assert.match(remind.line ?? "", /still failing after 3 attempts \(15 min\)/);
    // The clock restarts from the reminder, not from the first failure.
    assert.equal(r.fail("boom", T0 + 20 * MIN).line, null);
    assert.match(r.fail("boom", T0 + 30 * MIN).line ?? "", /still failing after 5 attempts \(30 min\)/);
  });

  it("recovery names how many attempts failed and for how long", () => {
    const r = new RepeatLog("[p]");
    r.fail("boom", T0);
    r.fail("boom", T0 + 1000);
    assert.match(r.ok(T0 + 5 * MIN).line ?? "", /recovered after 2 failed attempts \(5 min\)/);
  });

  it("says nothing when nothing was wrong", () => {
    const r = new RepeatLog("[p]");
    assert.equal(r.ok(T0).line, null);
    assert.equal(r.ok(T0 + MIN).line, null);
  });

  it("a recovered run starts over — the next failure is news again", () => {
    const r = new RepeatLog("[p]");
    r.fail("boom", T0);
    r.ok(T0 + MIN);
    assert.equal(r.fail("boom", T0 + 2 * MIN).line, "[p] boom", "must not stay suppressed across a recovery");
  });
});
