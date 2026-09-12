import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { recordIndicator, lateBySec, streamIndicator, loudestSpl, pinnedSpl, meterOptions, LOUDEST_METER, STREAMER_FOR, RECORDER_FOR, sourceOptions } from "./recording-status.js";
import type { Streamer } from "./recording-status.js";

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


describe("pinning one SPL meter", () => {
  const meter = (metrics: Record<string, number>) => ({ metrics });
  const two = {
    connected: true,
    meters: {
      "dev::FOH": meter({ "SPL A Slow": 92.4 }),
      "dev::Balcony": meter({ "SPL A Slow": 71.2 }),
    },
  };

  test("reads the meter it was given, not the loudest one", () => {
    const r = pinnedSpl(two, "dev::Balcony");
    assert.equal(r.value, "71 dB", "a pinned quiet channel must not report the loud one");
    assert.equal(r.sub, "Balcony");
  });

  test("a pinned meter that stopped reporting says so instead of quietly showing another", () => {
    // The failure this exists for: falling back to the loudest meter here reads
    // as "the channel you asked for is fine", which is the opposite of the truth
    // when Smaart has restarted and dropped it. The number would be real and
    // about somewhere else in the building.
    const r = pinnedSpl(two, "dev::Missing");
    assert.equal(r.value, "—");
    assert.equal(r.sub, "Missing not reporting");
    assert.notEqual(r.value, loudestSpl(two).value, "must not silently become the loudest meter");
  });

  test("offline Smaart reports offline, the same as the unpinned card", () => {
    assert.equal(pinnedSpl(null, "dev::FOH").value, "—");
    assert.equal(pinnedSpl(null, "dev::FOH").sub, "Smaart offline");
  });

  test("prefers the A-weighted metric, the same as the unpinned card", () => {
    const r = pinnedSpl(
      { connected: true, meters: { "dev::FOH": meter({ "SPL C Fast": 120, "SPL A Slow": 90 }) } },
      "dev::FOH",
    );
    assert.equal(r.value, "90 dB", "pinning must change WHICH meter is read, not what SPL means");
  });
});

describe("the meter submenu's options", () => {
  const spl = {
    meters: {
      "dev::FOH": { deviceName: "Console", channelName: "FOH" },
      "dev::Balcony": { deviceName: "Console", channelName: "" },
    },
  };

  test("leads with the loudest-meter default, then every meter reporting", () => {
    const o = meterOptions(spl, LOUDEST_METER);
    assert.equal(o[0].value, LOUDEST_METER);
    assert.deepEqual(o.map((x) => x.value), [LOUDEST_METER, "dev::FOH", "dev::Balcony"]);
    assert.equal(o[2].label, "Console", "a channel with no name falls back to the device");
  });

  test("a pinned meter that is gone is still listed, so it can be seen and changed", () => {
    // Dropping it leaves the submenu with nothing ticked while the card reads
    // "not reporting" — the operator would see an unset menu and have to guess
    // what the card is pinned to.
    const o = meterOptions(spl, "dev::Gone");
    assert.ok(o.some((x) => x.value === "dev::Gone"), "the pinned meter must still appear");
    assert.equal(o.find((x) => x.value === "dev::Gone")?.label, "Gone (not reporting)");
  });

  test("does not duplicate a pinned meter that IS reporting", () => {
    const o = meterOptions(spl, "dev::FOH");
    assert.equal(o.filter((x) => x.value === "dev::FOH").length, 1);
  });
});

describe("the source vocabularies", () => {
  // One table per family, because the same lowercase config value has to resolve
  // to the same operator-facing name on Home, on a wall and in the inspector.
  test("every value names the source an operator reads", () => {
    assert.deepEqual(STREAMER_FOR, { any: null, resi: "Resi", youtube: "YouTube" });
    assert.deepEqual(RECORDER_FOR, { any: null, obs: "OBS", reaper: "REAPER" });
  });

  test("an unknown value resolves to nothing, not to another source", () => {
    // The failure this exists for: the wall object did this with
    // `platform === "resi" ? "Resi" : "YouTube"`, so ANY value that was not
    // "resi" — a typo, a hand-edited views.json, a platform added later and
    // wired in only one place — drew a widget labelled YouTube reporting
    // something else. A lookup cannot do that; a two-way ternary always can.
    assert.equal(STREAMER_FOR["twitch"], undefined);
    assert.equal(RECORDER_FOR["protools"], undefined);
    assert.notEqual(STREAMER_FOR["twitch"], "YouTube");
  });

  test("the submenu options are the table, in its order, with the any-choice named", () => {
    assert.deepEqual(sourceOptions(RECORDER_FOR, "Every recorder"), [
      { value: "any", label: "Every recorder" },
      { value: "obs", label: "OBS" },
      { value: "reaper", label: "REAPER" },
    ]);
    assert.deepEqual(sourceOptions(STREAMER_FOR, "Any platform")[0], {
      value: "any",
      label: "Any platform",
    });
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
    // recorder for a question asked about all of them — but there is still a
    // third line, because the card next to it has one.
    assert.equal(
      recordIndicator([rec({ connected: false }), rec({ name: "REAPER", connected: false })]).sub,
      "no recorder connected",
    );
  });
});

// ── Off air past a scheduled start ──────────────────────────────────────────
//
// The state the app could not describe: a broadcast was scheduled, the time has
// gone, and nothing is going out. Only YouTube reports a scheduled start, and
// only the API-key path can see one for a broadcast that has not begun — see
// docs/integrations/youtube.md.
//
// Judged on the CLIENT from a fixed timestamp the server pushed once, for the
// reason the OBS record clock is: the number grows every second, and computing
// it on the server would be an SSE frame a second to every browser.

describe("lateBySec", () => {
  const NOW = Date.parse("2026-09-06T14:05:00.000Z");
  const at = (offsetSec: number) => new Date(NOW + offsetSec * 1000).toISOString();

  test("counts the seconds since a start that did not happen", () => {
    assert.equal(lateBySec({ live: false, scheduledStartAt: at(-300) }, NOW), 300);
  });

  test("something live is never late, however long after its scheduled time it began", () => {
    // It IS going out. A red widget over a stream with an audience is the worst
    // reading this could produce.
    assert.equal(lateBySec({ live: true, scheduledStartAt: at(-3600) }, NOW), null);
  });

  test("a start still to come is not late", () => {
    assert.equal(lateBySec({ live: false, scheduledStartAt: at(600) }, NOW), null);
  });

  test("the first minute is grace, not an alarm", () => {
    // A stream that goes out forty seconds after its scheduled time is not a
    // problem anyone needs telling about, and a widget that flashes red at every
    // start is one nobody reads by the third Sunday.
    assert.equal(lateBySec({ live: false, scheduledStartAt: at(-59) }, NOW), null);
    assert.equal(lateBySec({ live: false, scheduledStartAt: at(-61) }, NOW), 61);
  });

  test("a broadcast scheduled and abandoned months ago stops being an alarm", () => {
    // THE RED THAT WOULD NEVER GO OUT. An upcoming broadcast keeps its scheduled
    // time for as long as it sits on the channel, so with no upper bound one
    // cancelled in March leaves the widget red until somebody deletes it.
    assert.equal(lateBySec({ live: false, scheduledStartAt: at(-3 * 60 * 60) }, NOW), null);
    assert.equal(lateBySec({ live: false, scheduledStartAt: at(-119 * 60) }, NOW), 119 * 60);
  });

  test("nothing scheduled, and an unparseable time, are both simply not an alarm", () => {
    assert.equal(lateBySec({ live: false, scheduledStartAt: null }, NOW), null);
    assert.equal(lateBySec({ live: false, scheduledStartAt: "shortly" }, NOW), null);
  });
});

describe("the streaming indicator, off air past a scheduled start", () => {
  const NOW = Date.parse("2026-09-06T14:05:00.000Z");
  const at = (offsetSec: number) => new Date(NOW + offsetSec * 1000).toISOString();
  const yt = (over: Partial<Streamer> = {}): Streamer =>
    ({ name: "YouTube", connected: true, live: false, ...over });

  test("off air with nothing scheduled stays quiet", () => {
    // It is what the page sits in all week. A colour here is a colour that means
    // nothing by the third Sunday.
    const ind = streamIndicator([yt()], NOW);
    assert.equal(ind.value, "Off air");
    assert.equal(ind.state, "idle");
  });

  test("off air past a scheduled start is its own state, and says how late", () => {
    const ind = streamIndicator([yt({ scheduledStartAt: at(-372) })], NOW);
    assert.equal(ind.value, "Off air", "the state word is unchanged — it IS off air");
    assert.equal(ind.state, "late", "the one off-air moment that has earned a colour");
    assert.equal(ind.sub, "6:12 late");
  });

  test("a platform that is not connected cannot be late", () => {
    // Unreachable is a different failure with a different fix, and reporting it
    // as a missed start would send the operator to the wrong box.
    const ind = streamIndicator([yt({ connected: false, scheduledStartAt: at(-372) })], NOW);
    assert.equal(ind.state, "offline");
  });

  test("one platform live is enough, whatever another had scheduled", () => {
    const ind = streamIndicator(
      [yt({ scheduledStartAt: at(-372) }), { name: "Resi", connected: true, live: true, startedAt: at(-90) }],
      NOW,
    );
    assert.equal(ind.state, "live");
  });

  test("with two overdue, it reports the one that should have started first", () => {
    const ind = streamIndicator(
      [yt({ scheduledStartAt: at(-120) }), yt({ name: "Resi", scheduledStartAt: at(-600) })],
      NOW,
    );
    assert.equal(ind.sub, "10:00 late");
  });
});

describe("the streaming indicator, viewers", () => {
  const NOW = Date.parse("2026-09-06T14:05:00.000Z");
  const live = (over: Partial<Streamer> = {}): Streamer =>
    ({ name: "YouTube", connected: true, live: true, startedAt: new Date(NOW - 95_000).toISOString(), ...over });

  test("the audience rides the same line as the clock", () => {
    // A wall widget has exactly one slot for a running reading — a second line
    // is paid for out of the size of the word above it.
    assert.equal(streamIndicator([live({ viewers: 137 })], NOW).sub, "1:35 · 137 watching");
  });

  test("no viewer count leaves the clock exactly as it was", () => {
    assert.equal(streamIndicator([live()], NOW).sub, "1:35");
  });

  test("a reported zero is shown, because YouTube said it", () => {
    assert.equal(streamIndicator([live({ viewers: 0 })], NOW).sub, "1:35 · 0 watching");
  });

  test("the elapsed switch drops the whole reading, audience included", () => {
    assert.equal(streamIndicator([live({ viewers: 137 })], NOW, { showElapsed: false }).sub, null);
  });
});
