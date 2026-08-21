import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { elapsedSince, streamers, streamingStat, type Streamer } from "./recording-status.js";

// The streaming twin of the recording judgement. What matters here is the same
// thing that mattered there: that "connected but NOT live" is its own answer.
// Mid-service, "Resi is reachable and is not streaming" is the single most
// useful thing this can say, and a boolean would lose it.

const NOW = Date.parse("2026-08-20T15:30:00.000Z");
const at = (min: number) => new Date(NOW - min * 60_000).toISOString();

const s = (over: Partial<Streamer>): Streamer =>
  ({ name: "X", connected: true, live: false, startedAt: null, ...over });

describe("elapsed since a start", () => {
  test("under an hour reads MM:SS", () => {
    assert.equal(elapsedSince(at(3), NOW), "3:00");
  });

  test("over an hour grows an hours field rather than counting past 60", () => {
    assert.equal(elapsedSince(at(75), NOW), "1:15:00");
  });

  test("no start time is null, not 0:00", () => {
    // A platform that says it is live without saying since when is UNKNOWN, and
    // 0:00 would read as "it just started" on a stream an hour in.
    assert.equal(elapsedSince(null, NOW), null);
    assert.equal(elapsedSince(undefined, NOW), null);
  });

  test("an unparseable stamp is null rather than NaN", () => {
    assert.equal(elapsedSince("not a date", NOW), null);
  });

  test("a start in the future reads as just-started", () => {
    // Our clock and the platform's disagree by a few seconds; that is a clock
    // problem, not a negative duration, and "-0:03" on a wall is nonsense.
    assert.equal(elapsedSince(at(-1), NOW), "0:00");
  });
});

describe("are we live", () => {
  test("nothing connected is not the same as not live", () => {
    const r = streamingStat([s({ connected: false }), s({ connected: false })], NOW);
    assert.equal(r.value, "—");
    assert.equal(r.tone, undefined, "an absent platform must not read as an alarm");
  });

  test("connected and not live is its OWN state, and is toned", () => {
    // THE case this exists for.
    const r = streamingStat([s({ name: "Resi", connected: true, live: false })], NOW);
    assert.equal(r.value, "OFFLINE");
    assert.equal(r.tone, "danger");
    assert.match(r.sub, /Resi/);
  });

  test("live reports the elapsed time, not the word", () => {
    const r = streamingStat([s({ name: "Resi", live: true, startedAt: at(42) })], NOW);
    assert.equal(r.value, "42:00");
    assert.equal(r.tone, "live");
  });

  test("live with no start time still says it is live", () => {
    // Resi's encoder payload may carry no start time at all. Falling back to
    // "LIVE" beats showing a duration we do not have.
    const r = streamingStat([s({ name: "Resi", live: true, startedAt: null })], NOW);
    assert.equal(r.value, "LIVE");
    assert.equal(r.tone, "live");
  });

  test("two platforms live report the EARLIEST start", () => {
    // YouTube joins a Resi stream already running. The question is how long the
    // service has been streaming, not when the second platform caught up.
    const r = streamingStat(
      [s({ name: "Resi", live: true, startedAt: at(50) }), s({ name: "YouTube", live: true, startedAt: at(5) })],
      NOW,
    );
    assert.equal(r.value, "50:00");
    assert.match(r.sub, /Resi \+ YouTube/);
  });

  test("one live and one merely connected reads as live", () => {
    // Not an alarm: something IS going out. The offline one is named in the sub.
    const r = streamingStat(
      [s({ name: "Resi", live: true, startedAt: at(2) }), s({ name: "YouTube", live: false })],
      NOW,
    );
    assert.equal(r.tone, "live");
    assert.equal(r.sub, "Resi");
  });
});

describe("who counts as a streamer", () => {
  test("OBS is one, because it already reports streaming", () => {
    // The same connection that says OBS is recording says it is live. Leaving
    // it out would mean the app knew and did not say.
    const list = streamers(null, null, { connected: true, streaming: true });
    const obs = list.find((x) => x.name === "OBS");
    assert.equal(obs?.live, true);
    assert.equal(obs?.startedAt, null, "obs-websocket reports no stream start time");
  });

  test("a null platform is absent, not offline", () => {
    const list = streamers(null, null, null);
    assert.ok(list.every((x) => !x.connected));
    assert.equal(streamingStat(list, NOW).tone, undefined);
  });

  test("every platform is present in the list even when unconfigured", () => {
    // The surfaces render from this; a platform that vanished when unconfigured
    // would make the widget change shape as gear is set up.
    assert.deepEqual(streamers(null, null, null).map((x) => x.name), ["Resi", "YouTube", "OBS"]);
  });
});
