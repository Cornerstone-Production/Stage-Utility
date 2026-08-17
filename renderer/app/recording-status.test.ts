import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { recordingStat, recorderStat, recorders, loudestSpl } from "./recording-status.js";

// Mid-service, recording and SPL are the two things you cannot recover after the
// fact, so these read the state rather than restate it. The distinction that
// matters: a recorder that is CONNECTED BUT STOPPED is a problem, and must not
// look the same as one that was never wired up.
describe("recordingStat", () => {
  test("no recorder connected says so, and is not an alarm", () => {
    const r = recordingStat(recorders(null, null));
    assert.equal(r.value, "—");
    assert.equal(r.tone, undefined, "an install with no recorder must not show red all service");
  });

  test("connected but stopped is flagged", () => {
    const r = recordingStat(recorders({ connected: true, recording: false, recordTimecode: null }, null));
    assert.equal(r.value, "STOPPED");
    assert.equal(r.tone, "danger");
  });

  test("recording shows the timecode", () => {
    const r = recordingStat(recorders({ connected: true, recording: true, recordTimecode: "00:12:31" }, null));
    assert.equal(r.value, "00:12:31");
    assert.equal(r.tone, "live");
  });

  test("either recorder counts, and both are named", () => {
    // A panel that watched only OBS would read as reassurance while REAPER sat
    // stopped, and vice versa.
    const onlyReaper = recordingStat(recorders({ connected: true, recording: false, recordTimecode: null }, { connected: true, recording: true }));
    assert.equal(onlyReaper.tone, "live");
    assert.equal(onlyReaper.sub, "REAPER");

    const both = recordingStat(recorders({ connected: true, recording: true, recordTimecode: null }, { connected: true, recording: true }));
    assert.equal(both.sub, "OBS + REAPER");
  });
});

describe("loudestSpl", () => {
  const meter = (metrics: Record<string, number>) => ({ metrics });

  test("offline Smaart reports offline, not a fake reading", () => {
    assert.equal(loudestSpl(null).value, "—");
    assert.equal(loudestSpl({ connected: false, meters: {} }).value, "—");
  });

  test("connected with no readings yet is not 0 dB", () => {
    // 0 dB is a claim about the room; "—" is honesty about the data.
    const r = loudestSpl({ connected: true, meters: {} });
    assert.equal(r.value, "—");
    assert.equal(r.sub, "no readings yet");
  });

  test("reports the loudest meter and names it", () => {
    const r = loudestSpl({
      connected: true,
      meters: {
        "dev::FOH": meter({ "SPL A Slow": 92.4 }),
        "dev::Lobby": meter({ "SPL A Slow": 71.2 }),
      },
    });
    assert.equal(r.value, "92 dB");
    assert.equal(r.sub, "FOH");
  });

  test("prefers the A-weighted metric when a meter reports several", () => {
    const r = loudestSpl({
      connected: true,
      meters: { "dev::FOH": meter({ "SPL C Fast": 120, "SPL A Slow": 90 }) },
    });
    assert.equal(r.value, "90 dB", "must not report the C-weighted number as the headline");
  });
});

describe("one recorder on its own", () => {
  test("says RECORDING with the elapsed time underneath", () => {
    // The word first and in colour, the duration as confirmation — a timecode
    // reads as fine at a glance whether or not it is actually moving.
    const r = recorderStat({ name: "OBS", connected: true, recording: true, timecode: "00:35:09" });
    assert.equal(r.value, "RECORDING");
    assert.equal(r.sub, "00:35:09");
    assert.equal(r.tone, "live");
  });

  test("REAPER carries a position, so its card is not blank underneath", () => {
    // REAPER reports the transport position rather than a record timer, and it
    // was simply not being passed through — the card said "REAPER" where the
    // time should be.
    const [, reaper] = recorders(null, { connected: true, recording: true, positionString: "0:02.123" });
    assert.equal(reaper.timecode, "0:02.123");
    assert.equal(recorderStat(reaper).sub, "0:02.123");
  });

  test("says so when the recorder reports no position at all", () => {
    const r = recorderStat({ name: "REAPER", connected: true, recording: true });
    assert.equal(r.value, "RECORDING");
    assert.equal(r.sub, "no position reported");
  });

  test("STOPPED is red, and names what is connected", () => {
    const r = recorderStat({ name: "OBS", connected: true, recording: false });
    assert.equal(r.value, "STOPPED");
    assert.equal(r.tone, "danger");
  });

  test("a recorder that is not connected is neither", () => {
    // "not connected" and "not recording" are different facts and must not
    // render the same, or a dead integration reads as a stopped one.
    const r = recorderStat({ name: "OBS", connected: false, recording: false });
    assert.equal(r.value, "—");
    assert.equal(r.tone, undefined);
  });
});
