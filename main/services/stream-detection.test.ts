// What counts as "live", for each platform, in isolation.
//
// These are the judgements every streaming widget in the app rests on, and each
// one is a place where an API's vocabulary meets ours. They are pure on purpose:
// a mistake here is a red LIVE slab on a wall screen over a stream nobody is
// receiving, and that is worth pinning without a server in the way.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { encoderIsLive, selectedEncoders, startedAtFrom } from "./resi-service.js";
import {
  broadcastIsLive,
  configComplete,
  earliestStart,
  uploadsPlaylistFrom,
  videoIsLive,
  type YouTubeConfig,
} from "./youtube-service.js";

describe("Resi encoders", () => {
  test("only `started` is live", () => {
    assert.equal(encoderIsLive({ uuid: "a", status: "started" }), true);
    for (const status of ["stopped", "starting", "idle", "error", "", null, undefined]) {
      assert.equal(encoderIsLive({ uuid: "a", status }), false, `${status} must not read as live`);
    }
  });

  test("casing and whitespace do not decide whether we are on air", () => {
    // An undocumented API is free to change either without telling anybody, and
    // a live indicator that goes dark over a capital letter is the worst
    // possible failure here.
    assert.equal(encoderIsLive({ uuid: "a", status: " Started " }), true);
    assert.equal(encoderIsLive({ uuid: "a", status: "STARTED" }), true);
  });

  test("an unparseable start time is treated as absent, not passed on", () => {
    // Better no clock than a wrong one: a garbage stamp would render as a
    // duration measured from 1970.
    assert.equal(startedAtFrom({ uuid: "a", startedAt: "not a date" }), null);
    assert.equal(startedAtFrom({ uuid: "a", startTime: "" }), null);
    assert.equal(startedAtFrom({ uuid: "a" }), null);
    assert.equal(
      startedAtFrom({ uuid: "a", startTime: "2026-08-20T14:00:00Z" }),
      "2026-08-20T14:00:00.000Z",
    );
  });

  test("no selection means every encoder, not none", () => {
    // The opposite reading would show an operator who has not chosen yet a
    // confident "not streaming" while the service went out.
    const all = [{ uuid: "a" }, { uuid: "b" }];
    assert.deepEqual(selectedEncoders(all, []), all);
    assert.deepEqual(selectedEncoders(all, ["b"]), [{ uuid: "b" }]);
    assert.deepEqual(selectedEncoders(all, ["gone"]), []);
  });
});

describe("YouTube broadcasts (OAuth path)", () => {
  test("only `live` is live — testing and liveStarting are not", () => {
    assert.equal(broadcastIsLive({ status: { lifeCycleStatus: "live" } }), true);
    for (const s of ["testing", "liveStarting", "testStarting", "ready", "complete", "revoked"]) {
      assert.equal(broadcastIsLive({ status: { lifeCycleStatus: s } }), false, `${s} must not read as live`);
    }
  });

  test("the earliest start wins, and none means null", () => {
    // Two broadcasts a minute apart report the stream, not the most recent
    // button press.
    assert.equal(
      earliestStart([
        { snippet: { actualStartTime: "2026-08-20T14:05:00Z" } },
        { snippet: { actualStartTime: "2026-08-20T14:00:00Z" } },
      ]),
      "2026-08-20T14:00:00.000Z",
    );
    assert.equal(earliestStart([{ snippet: {} }]), null);
    assert.equal(earliestStart([]), null);
  });
});

describe("YouTube videos (API-key path)", () => {
  test("the flag alone is enough", () => {
    assert.equal(videoIsLive({ snippet: { liveBroadcastContent: "live" } }), true);
    assert.equal(videoIsLive({ snippet: { liveBroadcastContent: "upcoming" } }), false);
    assert.equal(videoIsLive({ snippet: { liveBroadcastContent: "none" } }), false);
  });

  test("a start with no end is enough, so a lagging flag does not cost the first minutes", () => {
    assert.equal(
      videoIsLive({
        snippet: { liveBroadcastContent: "none" },
        liveStreamingDetails: { actualStartTime: "2026-08-20T14:00:00Z" },
      }),
      true,
    );
  });

  test("a finished stream is not live, however it is labelled", () => {
    // This is the case that matters: last Sunday's service keeps its
    // actualStartTime forever, and reading that as live would light the wall
    // every day of the week.
    assert.equal(
      videoIsLive({
        snippet: { liveBroadcastContent: "none" },
        liveStreamingDetails: {
          actualStartTime: "2026-08-20T14:00:00Z",
          actualEndTime: "2026-08-20T15:30:00Z",
        },
      }),
      false,
    );
  });

  test("an ordinary upload is not live", () => {
    assert.equal(videoIsLive({ snippet: { title: "Sermon clip" } }), false);
    assert.equal(videoIsLive({}), false);
  });

  test("the uploads playlist is only guessed from a real channel id", () => {
    assert.equal(uploadsPlaylistFrom("UCabcdefghijklmnopqrstuv"), "UUabcdefghijklmnopqrstuv");
    // A handle is not a channel id, and inventing UU@name would send a request
    // that fails in a way nobody could read.
    assert.equal(uploadsPlaylistFrom("@yourchurch"), null);
    assert.equal(uploadsPlaylistFrom("UCshort"), null);
    assert.equal(uploadsPlaylistFrom(""), null);
  });
});

describe("what counts as configured", () => {
  const base: YouTubeConfig = {
    mode: "key",
    apiKey: "",
    channel: "",
    clientId: "",
    clientSecret: "",
    refreshToken: "",
  };

  test("each mode needs its own fields and ignores the other's", () => {
    // The card and the service must agree, or the page reads "configured" over
    // a service that will not start.
    assert.equal(configComplete({ ...base, apiKey: "k", channel: "@c" }), true);
    assert.equal(configComplete({ ...base, apiKey: "k" }), false);
    assert.equal(configComplete({ ...base, clientId: "i", clientSecret: "s", refreshToken: "r" }), false);

    const oauth: YouTubeConfig = { ...base, mode: "oauth" };
    assert.equal(configComplete({ ...oauth, clientId: "i", clientSecret: "s", refreshToken: "r" }), true);
    assert.equal(configComplete({ ...oauth, clientId: "i", clientSecret: "s" }), false);
    assert.equal(configComplete({ ...oauth, apiKey: "k", channel: "@c" }), false);
  });
});
