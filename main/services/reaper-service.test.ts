// Tests for the pure REAPER /_/TRANSPORT parser.
//
// REAPER reports transport state as a bitmask (bit0 playing, bit1 paused,
// bit2 recording) in a tab-separated line. Getting the bit math wrong means the
// recording indicator is wrong during a service, so the playstate table below is
// exercised value by value.

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { parseTransport } from "./reaper-service.js";

const line = (playstate: number, pos = "12.5", repeat = "0", posStr = "0:12.500") =>
  `TRANSPORT\t${playstate}\t${pos}\t${repeat}\t${posStr}\t1.1.00`;

describe("parseTransport", () => {
  test("playstate 0 is stopped", () => {
    const s = parseTransport(line(0));
    assert.deepEqual({ playing: s.playing, recording: s.recording, recordPaused: s.recordPaused }, {
      playing: false,
      recording: false,
      recordPaused: false,
    });
  });

  test("playstate 1 is playing", () => {
    const s = parseTransport(line(1));
    assert.equal(s.playing, true);
    assert.equal(s.recording, false);
  });

  test("playstate 2 is paused, not playing", () => {
    const s = parseTransport(line(2));
    assert.equal(s.playing, false);
    assert.equal(s.recording, false);
  });

  test("playstate 5 is recording", () => {
    // bit2 (record) + bit0 (play) — REAPER's "rolling and recording".
    const s = parseTransport(line(5));
    assert.equal(s.recording, true);
    assert.equal(s.recordPaused, false);
    assert.equal(s.playing, false, "recording takes precedence over playing in the DTO");
  });

  test("playstate 6 is record-paused", () => {
    // bit2 (record) + bit1 (pause).
    const s = parseTransport(line(6));
    assert.equal(s.recording, true);
    assert.equal(s.recordPaused, true);
  });

  test("position is parsed as a number and the position string is passed through", () => {
    const s = parseTransport(line(1, "93.25", "0", "1:33.250"));
    assert.equal(s.positionSeconds, 93.25);
    assert.equal(s.positionString, "1:33.250");
  });

  test("reaching REAPER at all counts as connected", () => {
    assert.equal(parseTransport(line(0)).connected, true);
  });

  test("a malformed body still reports connected, since the HTTP request landed", () => {
    const s = parseTransport("something unexpected");
    assert.equal(s.connected, true);
    assert.equal(s.recording, false);
    assert.equal(s.positionSeconds, null);
  });

  test("an empty body does not throw", () => {
    assert.equal(parseTransport("").connected, true);
  });

  test("a TRANSPORT line with no fields after the tag is handled", () => {
    assert.equal(parseTransport("TRANSPORT").recording, false);
  });

  test("the TRANSPORT line is found among other lines", () => {
    const body = "SOMETHINGELSE\t1\nTRANSPORT\t5\t1.0\t0\t0:01.000\t1.1.00\nTRAILING\tx";
    assert.equal(parseTransport(body).recording, true);
  });

  test("an unparseable position becomes null rather than NaN", () => {
    const s = parseTransport(line(1, "abc"));
    assert.equal(s.positionSeconds, null);
  });

  test("an empty position field becomes null", () => {
    const s = parseTransport(line(1, ""));
    assert.equal(s.positionSeconds, null);
  });

  test("an empty position string becomes null rather than an empty string", () => {
    const s = parseTransport(line(1, "1.0", "0", ""));
    assert.equal(s.positionString, null);
  });
});
