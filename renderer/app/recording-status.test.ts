import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { recordIndicator, loudestSpl } from "./recording-status.js";

// Mid-service, recording and SPL are the two things you cannot recover after the
// fact, so these read the state rather than restate it. The distinction that
// matters: a recorder that is CONNECTED BUT NOT ROLLING must not look the same
// as one that was never wired up.
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


describe("the recording indicator", () => {
  // The SAME three states, in the same shape, as the streaming indicator beside
  // it. They were answering in two vocabularies — a recorder said "—" with a
  // line of prose under it while a platform said "OFF AIR" — which is what "OBS
  // and REAPER should match Resi" meant.
  const rec = (over: Partial<{ name: string; connected: boolean; recording: boolean; timecode: string | null }> = {}) =>
    ({ name: "OBS", connected: true, recording: false, timecode: null, ...over });

  test("nothing connected reads Offline", () => {
    const ind = recordIndicator([rec({ connected: false })]);
    assert.equal(ind.value, "Offline");
    assert.equal(ind.state, "offline");
  });

  test("connected and not rolling is its own state, and it is quiet", () => {
    const ind = recordIndicator([rec({ connected: true })]);
    assert.equal(ind.value, "Standby");
    assert.equal(ind.state, "idle", "a recorder sat waiting is not an alarm — it is most of the week");
  });

  test("rolling reads Recording, with the timecode underneath", () => {
    const ind = recordIndicator([rec({ recording: true, timecode: "00:35:09" })]);
    assert.equal(ind.value, "Recording");
    assert.equal(ind.sub, "00:35:09");
    assert.equal(ind.state, "live");
  });

  test("one rolling recorder is enough, whatever the other is doing", () => {
    const ind = recordIndicator([rec({ name: "OBS", recording: false }), rec({ name: "REAPER", recording: true })]);
    assert.equal(ind.state, "live");
  });

  test("a single named recorder says which one is not connected", () => {
    assert.equal(recordIndicator([rec({ name: "REAPER", connected: false })]).sub, "REAPER not connected");
  });

  test("with several, it does not claim one of them", () => {
    // "OBS not connected" under a card labelled Recording would be naming one
    // recorder for a question asked about all of them.
    assert.equal(recordIndicator([rec({ connected: false }), rec({ name: "REAPER", connected: false })]).sub, null);
  });
});
