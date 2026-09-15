// Tests for the pure REAPER /_/TRANSPORT parser.
//
// REAPER reports transport state as a bitmask (bit0 playing, bit1 paused,
// bit2 recording) in a tab-separated line. Getting the bit math wrong means the
// recording indicator is wrong during a service, so the playstate table below is
// exercised value by value.

import assert from "node:assert/strict";
import { afterEach, test, describe } from "node:test";

import { parseTransport, reaperDeps, reaperService } from "./reaper-service.js";
import type { ReaperStatusDTO } from "../types/stage.js";

const line = (playstate: number, pos = "12.5", repeat = "0", posStr = "0:12.500") =>
  `TRANSPORT\t${playstate}\t${pos}\t${repeat}\t${posStr}\t1.1.00`;

/** The snapshot half, for the bit-math cases below — `read` has its own block. */
const statusOf = (body: string): ReaperStatusDTO => parseTransport(body).status;

describe("parseTransport", () => {
  test("playstate 0 is stopped", () => {
    const s = statusOf(line(0));
    assert.deepEqual({ playing: s.playing, recording: s.recording, recordPaused: s.recordPaused }, {
      playing: false,
      recording: false,
      recordPaused: false,
    });
  });

  test("playstate 1 is playing", () => {
    const s = statusOf(line(1));
    assert.equal(s.playing, true);
    assert.equal(s.recording, false);
  });

  test("playstate 2 is paused, not playing", () => {
    const s = statusOf(line(2));
    assert.equal(s.playing, false);
    assert.equal(s.recording, false);
  });

  test("playstate 5 is recording", () => {
    // bit2 (record) + bit0 (play) — REAPER's "rolling and recording".
    const s = statusOf(line(5));
    assert.equal(s.recording, true);
    assert.equal(s.recordPaused, false);
    assert.equal(s.playing, false, "recording takes precedence over playing in the DTO");
  });

  test("playstate 6 is record-paused", () => {
    // bit2 (record) + bit1 (pause).
    const s = statusOf(line(6));
    assert.equal(s.recording, true);
    assert.equal(s.recordPaused, true);
  });

  test("position is parsed as a number and the position string is passed through", () => {
    const s = statusOf(line(1, "93.25", "0", "1:33.250"));
    assert.equal(s.positionSeconds, 93.25);
    assert.equal(s.positionString, "1:33.250");
  });

  test("reaching REAPER at all counts as connected", () => {
    assert.equal(statusOf(line(0)).connected, true);
  });

  test("a malformed body still reports connected, since the HTTP request landed", () => {
    const s = statusOf("something unexpected");
    assert.equal(s.connected, true);
    assert.equal(s.recording, false);
    assert.equal(s.positionSeconds, null);
  });

  test("an empty body does not throw", () => {
    assert.equal(statusOf("").connected, true);
  });

  test("a TRANSPORT line with no fields after the tag is handled", () => {
    assert.equal(statusOf("TRANSPORT").recording, false);
  });

  test("the TRANSPORT line is found among other lines", () => {
    const body = "SOMETHINGELSE\t1\nTRANSPORT\t5\t1.0\t0\t0:01.000\t1.1.00\nTRAILING\tx";
    assert.equal(statusOf(body).recording, true);
  });

  test("an unparseable position becomes null rather than NaN", () => {
    const s = statusOf(line(1, "abc"));
    assert.equal(s.positionSeconds, null);
  });

  test("an empty position field becomes null", () => {
    const s = statusOf(line(1, ""));
    assert.equal(s.positionSeconds, null);
  });

  test("an empty position string becomes null rather than an empty string", () => {
    const s = statusOf(line(1, "1.0", "0", ""));
    assert.equal(s.positionString, null);
  });

  // `read` — "REAPER answered" as distinct from "REAPER said stopped". The two
  // used to be the same value, and transport("record") presses a TOGGLE on it.
  test("a well-formed line reads", () => {
    assert.equal(parseTransport(line(0)).read, true);
  });

  test("a 200 whose body is not REAPER's does NOT read", () => {
    // A captive-portal redirect on a re-DHCPed VLAN, a reverse proxy, a REAPER
    // build answering a login page on /_/. All of them are HTTP 200.
    assert.equal(parseTransport("<html>ok</html>").read, false);
    assert.equal(parseTransport("").read, false);
    // The tag with no fields after it is not a transport either — there is no
    // playstate to have read.
    assert.equal(parseTransport("TRANSPORT").read, false);
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

/** A stub answering `/_/TRANSPORT` with `playstate`, and any action with "".
 *  `transportBody` replaces the transport line outright, for the case where
 *  something other than REAPER answers the request with an HTTP 200. */
function stubReaper(opts: { playstate?: number; status?: number; transportBody?: string } = {}): void {
  calls = [];
  reaperDeps.fetch = (async (input: unknown) => {
    const url = String(input);
    calls.push({ url });
    const status = opts.status ?? 200;
    const body = url.endsWith("/TRANSPORT") ? (opts.transportBody ?? line(opts.playstate ?? 0)) : "";
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

  test("record REFUSES when the transport could not be read — 1013 is a toggle", async () => {
    // GUARD, and the more dangerous half of the toggle. The case above stubs a
    // well-formed line, so it only ever proved the "already recording" branch.
    // Here something in front of REAPER's web interface answers 200 with
    // non-TRANSPORT text while REAPER is recording the 9am service. Parsed as
    // `recording: false`, a "start recording" cue sent 1013 — which STOPS the
    // recording — and reported ok: true.
    stubReaper({ transportBody: "<html>ok</html>" });
    configured();
    const result = await reaperService.transport("record");
    assert.equal(result.ok, false, "an unreadable transport reported success");
    assert.match(result.detail, /could not read REAPER's transport/);
    assert.deepEqual(
      calls.map((c) => c.url),
      ["http://reaper.example:8080/_/TRANSPORT"],
      "1013 went out on an answer nothing could read — that stops a recording already running",
    );
  });

  test("stop and play still go out when the transport cannot be read", async () => {
    // The refusal is about the TOGGLE, not about REAPER being unreachable. Both
    // of these are idempotent in REAPER itself, and an operator pressing Stop
    // wants it pressed.
    stubReaper({ transportBody: "<html>ok</html>" });
    configured();
    assert.deepEqual(await reaperService.transport("stop"), { ok: true, detail: "sent 1016" });
    assert.deepEqual(await reaperService.transport("play"), { ok: true, detail: "sent 1007" });
    assert.deepEqual(calls.map((c) => c.url), [
      "http://reaper.example:8080/_/1016",
      "http://reaper.example:8080/_/1007",
    ]);
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

// ── the poll's own verdict ────────────────────────────────────────────────────
//
// The same distinction one level up. A 200 whose body is not REAPER's used to
// parse as `recording: false` and report "Connected to REAPER at …": a green
// badge and a confident "not recording" over a machine nothing could read, which
// is exactly what `test()` has always refused to call a working connection.

describe("the poll's connection verdict", () => {
  /** The poll and its schedulers. Stubbed so no real timer survives a case. */
  type Poll = {
    connect: () => Promise<void>;
    scheduleIn: (ms: number) => void;
    scheduleReconnect: () => void;
  };
  const poll = reaperService as unknown as Poll;
  let reports: { state: string; message: string | null }[] = [];

  afterEach(() => {
    reaperDeps.fetch = realFetch;
    reaperService.setConnectionListener(() => {});
    reaperService.configure("", 0);
    reaperService.stop();
  });

  /** Configure and drive ONE poll, with both schedulers stubbed out. */
  async function pollOnce(opts: Parameters<typeof stubReaper>[0]): Promise<void> {
    stubReaper(opts);
    reports = [];
    poll.scheduleIn = () => {};
    poll.scheduleReconnect = () => {};
    reaperService.setConnectionListener((state, message) => reports.push({ state, message }));
    reaperService.configure("reaper.example", 8080);
    await poll.connect();
  }

  test("a well-formed line reports connected", async () => {
    await pollOnce({ playstate: 5 });
    assert.deepEqual(reports, [
      { state: "connected", message: "Connected to REAPER at reaper.example:8080" },
    ]);
  });

  test("a 200 that is not REAPER's transport reports an error, not a green badge", async () => {
    // GUARD. With the verdict taken from `status.recording` alone this is
    // `connected`, and the REAPER card is green while every reading it shows is
    // invented.
    await pollOnce({ transportBody: "<html>ok</html>" });
    assert.deepEqual(
      reports.map((r) => r.state),
      ["error"],
      "a machine whose transport could not be read was reported as connected",
    );
    assert.match(reports[0].message ?? "", /was not REAPER's transport/);
  });
});
