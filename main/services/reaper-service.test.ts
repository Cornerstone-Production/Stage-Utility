// Tests for the pure REAPER /_/TRANSPORT parser.
//
// REAPER reports transport state as a bitmask (bit0 playing, bit1 paused,
// bit2 recording) in a tab-separated line. Getting the bit math wrong means the
// recording indicator is wrong during a service, so the playstate table below is
// exercised value by value.

import assert from "node:assert/strict";
import { afterEach, test, describe } from "node:test";

import { parseTransport, reaperDeps, reaperService } from "./reaper-service.js";

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

// ── transport commands ────────────────────────────────────────────────────────
//
// The `reaper.transport` action drives the same web interface the poll reads,
// through `reaperService.transport()`. What is worth a test here is the toggle:
// REAPER's Record (1013) STOPS a running recording, so "start recording" said
// twice — by a voice assistant, or by a Home Assistant switch repeating
// `turn_on` — would end the recording of the service. The service reads the
// transport first and sends nothing when REAPER is already rolling.
//
// The service is configured and then STOPPED in every case below: `configure`
// starts the poll, and a stopped service keeps its host and port, still runs a
// command, and schedules no timer — so nothing here leaves a timer behind or
// depends on one firing.

interface Call {
  url: string;
}

let calls: Call[] = [];
const realFetch = reaperDeps.fetch;

/** A stub answering `/_/TRANSPORT` with `playstate`, and any action with "". */
function stubReaper(opts: { playstate?: number; status?: number } = {}): void {
  calls = [];
  reaperDeps.fetch = (async (input: unknown) => {
    const url = String(input);
    calls.push({ url });
    const status = opts.status ?? 200;
    const body = url.endsWith("/TRANSPORT") ? line(opts.playstate ?? 0) : "";
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
    } as unknown as Response;
  }) as typeof fetch;
}

/**
 * A configured, STOPPED service: `configure` starts the poll, whose first read
 * goes out synchronously, so the calls are reset afterwards and every assertion
 * below is about the command alone.
 */
const configured = (): void => {
  reaperService.configure("reaper.example", 8080);
  reaperService.stop();
  calls = [];
};

describe("reaperService.transport", () => {
  afterEach(() => {
    reaperDeps.fetch = realFetch;
    reaperService.configure("", 0);
    reaperService.stop();
  });

  test("record while stopped reads the transport and sends 1013", async () => {
    stubReaper({ playstate: 0 });
    configured();
    const result = await reaperService.transport("record");
    assert.deepEqual(result, { ok: true, detail: "sent 1013" });
    assert.deepEqual(
      calls.map((c) => c.url),
      ["http://reaper.example:8080/_/TRANSPORT", "http://reaper.example:8080/_/1013"],
    );
  });

  test("record while ALREADY recording sends nothing — 1013 is a toggle", async () => {
    stubReaper({ playstate: 5 });
    configured();
    const result = await reaperService.transport("record");
    assert.deepEqual(result, { ok: true, detail: "already recording" });
    assert.deepEqual(
      calls.map((c) => c.url),
      ["http://reaper.example:8080/_/TRANSPORT"],
      "a second 1013 would have stopped the recording",
    );
  });

  test("stop sends 1016 unconditionally, with no transport read", async () => {
    stubReaper({ playstate: 5 });
    configured();
    const result = await reaperService.transport("stop");
    assert.deepEqual(result, { ok: true, detail: "sent 1016" });
    assert.deepEqual(calls.map((c) => c.url), ["http://reaper.example:8080/_/1016"]);
  });

  test("play sends 1007", async () => {
    stubReaper({ playstate: 0 });
    configured();
    assert.deepEqual(await reaperService.transport("play"), { ok: true, detail: "sent 1007" });
    assert.deepEqual(calls.map((c) => c.url), ["http://reaper.example:8080/_/1007"]);
  });

  test("an unconfigured REAPER fails, and contacts nothing", async () => {
    stubReaper();
    reaperService.configure("", 0);
    reaperService.stop();
    assert.deepEqual(await reaperService.transport("record"), {
      ok: false,
      detail: "REAPER is not configured",
    });
    assert.equal(calls.length, 0);
  });

  test("an HTTP error is a returned failure, never a throw", async () => {
    stubReaper({ status: 500 });
    configured();
    const result = await reaperService.transport("stop");
    assert.equal(result.ok, false);
    assert.match(result.detail, /HTTP 500/);
  });
});
