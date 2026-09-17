// The OBS recording and streaming actions, which drive the integration's own
// obs-websocket link and press no Companion button.
//
// WHY THE ADAPTER IS STUBBED RATHER THAN RUN AGAINST THE FakeObs HARNESS: what
// is under test is the DECISION — what goes on the wire, and what deliberately
// does not — and the only way to assert "nothing was sent" is to count sends.
// obs-record-clock.test.ts drives the real socket for the questions that need
// one. There is a real OBS on this LAN and nothing here may reach it, so the
// stub records the request type and never opens anything.
//
// The idempotency is the point. OBS answers StartRecord while recording with a
// request error, so without it a cue said twice is a red line in the Activity
// log over a recording that is running perfectly well.

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-obs-actions-"));
process.env.STAGE_UTILITY_DATA = path.join(TMP, "data");
process.env.HOME = path.join(TMP, "home");

const { AUTOMATION_ACTIONS } = await import("./automation-actions.js");
const { obsOutputDeps } = await import("./obs-service.js");
const { implicitStateBinding } = await import("./cue-pairs.js");

type ObsStatus = ReturnType<(typeof obsOutputDeps)["status"]>;

const OFFLINE: ObsStatus = {
  connected: false,
  recording: false,
  recordPaused: false,
  streaming: false,
  virtualCam: false,
  recordAnchorMs: null,
  recordSampledAt: null,
};

/** Every request type the action put on the wire, in order. */
let sent: string[] = [];
/** What the next request rejects with, or null to resolve. */
let rejectWith: Error | null = null;

function obsIs(patch: Partial<ObsStatus>): void {
  obsOutputDeps.status = () => ({ ...OFFLINE, connected: true, ...patch });
}

/** OBS unreachable: no socket AND no snapshot to read. */
function obsIsGone(): void {
  obsOutputDeps.status = () => OFFLINE;
  obsOutputDeps.adapter = () => null;
}

const record = () => AUTOMATION_ACTIONS["obs.record"]!;
const stream = () => AUTOMATION_ACTIONS["obs.stream"]!;
const live = { simulate: false };

beforeEach(() => {
  sent = [];
  rejectWith = null;
  obsOutputDeps.adapter = () => ({
    request: async (requestType: string) => {
      sent.push(requestType);
      if (rejectWith) throw rejectWith;
      return {};
    },
  });
  obsIs({});
});

describe("obs.record", () => {
  test("start while idle sends StartRecord", async () => {
    obsIs({ recording: false });
    const r = await record().run({ command: "start" }, live);
    assert.deepEqual(r, { ok: true, detail: "start: sent StartRecord" });
    assert.deepEqual(sent, ["StartRecord"]);
  });

  test("start while already recording sends nothing and says so", async () => {
    // THE BUG. OBS rejects a redundant StartRecord with a request error, so a
    // cue called twice would read as a failure over a healthy recording.
    obsIs({ recording: true });
    const r = await record().run({ command: "start" }, live);
    assert.deepEqual(r, { ok: true, detail: "start: already recording" });
    assert.deepEqual(sent, [], "a redundant start reached OBS");
  });

  test("a paused recording is already recording", async () => {
    obsIs({ recording: true, recordPaused: true });
    const r = await record().run({ command: "start" }, live);
    assert.equal(r.ok, true);
    assert.deepEqual(sent, []);
  });

  test("stop while recording sends StopRecord", async () => {
    obsIs({ recording: true });
    const r = await record().run({ command: "stop" }, live);
    assert.deepEqual(r, { ok: true, detail: "stop: sent StopRecord" });
    assert.deepEqual(sent, ["StopRecord"]);
  });

  test("stop while idle sends nothing and says so", async () => {
    obsIs({ recording: false });
    const r = await record().run({ command: "stop" }, live);
    assert.deepEqual(r, { ok: true, detail: "stop: already stopped" });
    assert.deepEqual(sent, [], "a redundant stop reached OBS");
  });

  test("streaming is not recording", async () => {
    // The two actions share one snapshot. Reading the wrong field would make a
    // Start recording during a stream answer "already recording" and record
    // nothing at all.
    obsIs({ streaming: true, recording: false });
    const r = await record().run({ command: "start" }, live);
    assert.deepEqual(sent, ["StartRecord"]);
    assert.equal(r.ok, true);
  });

  test("a disconnected OBS is a failure that names it, not a throw", async () => {
    obsIsGone();
    const r = await record().run({ command: "start" }, live);
    assert.equal(r.ok, false);
    assert.match(r.detail, /OBS is not connected/);
    assert.deepEqual(sent, []);
  });

  test("a socket that has not finished its handshake is not a connection", async () => {
    // The adapter exists from the moment connect() builds it, so "there is an
    // object" is not "OBS is listening": a request written into a socket that
    // never identified rejects on a timeout seconds later, and a cue answering
    // in ten seconds is a cue nobody waits for. The SNAPSHOT is the authority.
    obsOutputDeps.status = () => OFFLINE;
    const r = await record().run({ command: "start" }, live);
    assert.equal(r.ok, false);
    assert.match(r.detail, /OBS is not connected/);
    assert.deepEqual(sent, [], "a request went into a socket that never connected");
  });

  test("an OBS that refuses the request fails with OBS's own words", async () => {
    rejectWith = new Error("Output is already active");
    obsIs({ recording: false });
    const r = await record().run({ command: "start" }, live);
    assert.equal(r.ok, false);
    assert.match(r.detail, /Output is already active/);
  });

  test("simulate contacts OBS not at all", async () => {
    // A simulated cue that reaches the socket is a cue that cannot be tested
    // with OBS shut, which is when a rule is usually written. The adapter from
    // beforeEach is left in place ON PURPOSE: one that threw would have the
    // failure swallowed into a simulated "would", and the count is the only
    // thing that can tell a suppressed send from a failed one.
    obsIs({ recording: false });
    const r = await record().run({ command: "start" }, { simulate: true });
    assert.deepEqual(r, { ok: true, detail: "would start recording" });
    assert.deepEqual(sent, [], "a simulated cue sent a request to OBS");
  });

  test("refuses a command it does not have", async () => {
    const r = await record().run({ command: "pause" }, live);
    assert.equal(r.ok, false);
    assert.match(r.detail, /not an OBS record command/);
    assert.deepEqual(sent, []);
  });

  test("refuses an empty command rather than guessing at one", async () => {
    const r = await record().run({}, live);
    assert.deepEqual(r, { ok: false, detail: "no command chosen" });
    assert.deepEqual(sent, []);
  });
});

describe("obs.stream", () => {
  test("start while idle sends StartStream", async () => {
    obsIs({ streaming: false });
    const r = await stream().run({ command: "start" }, live);
    assert.deepEqual(r, { ok: true, detail: "start: sent StartStream" });
    assert.deepEqual(sent, ["StartStream"]);
  });

  test("start while already streaming sends nothing and says so", async () => {
    obsIs({ streaming: true });
    const r = await stream().run({ command: "start" }, live);
    assert.deepEqual(r, { ok: true, detail: "start: already streaming" });
    assert.deepEqual(sent, []);
  });

  test("stop while not streaming sends nothing", async () => {
    obsIs({ streaming: false });
    const r = await stream().run({ command: "stop" }, live);
    assert.deepEqual(r, { ok: true, detail: "stop: already stopped" });
    assert.deepEqual(sent, []);
  });

  test("stop while streaming sends StopStream", async () => {
    obsIs({ streaming: true });
    const r = await stream().run({ command: "stop" }, live);
    assert.deepEqual(sent, ["StopStream"]);
    assert.equal(r.ok, true);
  });

  test("recording is not streaming", async () => {
    obsIs({ recording: true, streaming: false });
    await stream().run({ command: "start" }, live);
    assert.deepEqual(sent, ["StartStream"]);
  });

  test("a disconnected OBS is a failure that names it", async () => {
    obsIsGone();
    const r = await stream().run({ command: "stop" }, live);
    assert.equal(r.ok, false);
    assert.match(r.detail, /OBS is not connected/);
    assert.deepEqual(sent, []);
  });

  test("simulate contacts OBS not at all", async () => {
    obsIs({ streaming: true });
    const r = await stream().run({ command: "stop" }, { simulate: true });
    assert.deepEqual(r, { ok: true, detail: "would stop streaming" });
    assert.deepEqual(sent, [], "a simulated cue sent a request to OBS");
  });
});

describe("the state a pair of these cues reads", () => {
  test("an ON half that starts an OBS recording reads app:obs.recording", () => {
    assert.deepEqual(implicitStateBinding({ id: "obs.record", params: { command: "start" } }), {
      variable: "app:obs.recording",
      onValue: "on",
      offValue: "off",
    });
  });

  test("an ON half that starts an OBS stream reads app:obs.streaming", () => {
    assert.deepEqual(implicitStateBinding({ id: "obs.stream", params: { command: "start" } }), {
      variable: "app:obs.streaming",
      onValue: "on",
      offValue: "off",
    });
  });

  test("the two are not crossed", () => {
    // One table drives both. A source pasted from the line above would give the
    // stream pair the recording's state — a switch reporting the wrong device.
    assert.notEqual(
      implicitStateBinding({ id: "obs.record", params: { command: "start" } })?.variable,
      implicitStateBinding({ id: "obs.stream", params: { command: "start" } })?.variable,
    );
  });

  test("REAPER's implicit binding still stands", () => {
    assert.equal(
      implicitStateBinding({ id: "reaper.transport", params: { command: "record" } })?.variable,
      "app:reaper.recording",
    );
  });

  test("a STOP half implies nothing — the pair is bound from its ON half", () => {
    assert.equal(implicitStateBinding({ id: "obs.record", params: { command: "stop" } }), null);
    assert.equal(implicitStateBinding({ id: "obs.stream", params: { command: "stop" } }), null);
    assert.equal(implicitStateBinding({ id: "reaper.transport", params: { command: "stop" } }), null);
  });

  test("an action with a matching command but a different id implies nothing", () => {
    // `command: "start"` is not rare. The id has to be checked too, or a future
    // action carrying one would silently claim OBS's state.
    assert.equal(implicitStateBinding({ id: "log.message", params: { command: "start" } }), null);
  });
});
