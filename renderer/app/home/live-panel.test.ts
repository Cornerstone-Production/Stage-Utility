import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { recordingStat, loudestSpl } from "./live-panel.js";

// Mid-service, recording and SPL are the two things you cannot recover after the
// fact, so these read the state rather than restate it. The distinction that
// matters: a recorder that is CONNECTED BUT STOPPED is a problem, and must not
// look the same as one that was never wired up.
describe("recordingStat", () => {
  test("no recorder connected says so, and is not an alarm", () => {
    const r = recordingStat(null, null);
    assert.equal(r.value, "—");
    assert.equal(r.tone, undefined, "an install with no recorder must not show red all service");
  });

  test("connected but stopped is flagged", () => {
    const r = recordingStat({ connected: true, recording: false, recordTimecode: null }, null);
    assert.equal(r.value, "stopped");
    assert.equal(r.tone, "danger");
  });

  test("recording shows the timecode", () => {
    const r = recordingStat({ connected: true, recording: true, recordTimecode: "00:12:31" }, null);
    assert.equal(r.value, "00:12:31");
    assert.equal(r.tone, "live");
  });

  test("either recorder counts, and both are named", () => {
    // A panel that watched only OBS would read as reassurance while REAPER sat
    // stopped, and vice versa.
    const onlyReaper = recordingStat({ connected: true, recording: false, recordTimecode: null }, { connected: true, recording: true });
    assert.equal(onlyReaper.tone, "live");
    assert.equal(onlyReaper.sub, "REAPER");

    const both = recordingStat({ connected: true, recording: true, recordTimecode: null }, { connected: true, recording: true });
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
