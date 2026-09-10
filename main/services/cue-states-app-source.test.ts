// A cue pair whose state comes from Stage Utility itself, end to end.
//
// cue-states.test.ts replaces `cueStatesDeps.read` outright, so it says nothing
// about WHICH read a variable gets. This file leaves that dep alone and drives
// the real dispatch — `app:reaper.recording` through app-state-reads.ts into the
// REAPER transport snapshot — because the seam is the whole feature: a pair that
// presses no Companion button has no Companion variable to read, and the settle
// re-read, the cache and the reason line all have to work over it unchanged.
//
// The only stub is REAPER's own snapshot. There is no REAPER to run.

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";

import type { ReaperStatusDTO } from "../types/stage.js";
import type { Rule } from "../types/automation.js";
import { CALL_TRIGGER_ID } from "./cue-aliases.js";
import { cueStates, cueStatesDeps, SETTLE_MS, SETTLE_POLL_MS } from "./cue-states.js";
import { reaperService } from "./reaper-service.js";

const RECORDING_REF = "app:reaper.recording";

let status: ReaperStatusDTO = {
  connected: true,
  recording: false,
  recordPaused: false,
  playing: false,
  positionSeconds: null,
  positionString: null,
};
reaperService.getLatest = () => status;

/** The Record/Stop pair, with NO stateVariable — the implicit binding is the point. */
function recordPair(): Rule[] {
  const cue = (name: string, command: string): Rule => ({
    id: `id-${name}`,
    name,
    enabled: true,
    trigger: { id: CALL_TRIGGER_ID, params: { name } },
    conditions: [],
    action: { id: "reaper.transport", params: { command } },
    cooldownSec: 0,
    oncePerService: false,
  });
  return [cue("reaper_record_on", "record"), cue("reaper_record_off", "stop")];
}

let clock = Date.parse("2026-09-10T15:00:00.000Z");
let rules: Rule[] = [];
interface FakeTimer {
  ms: number;
  fn: () => void;
}
let timers: FakeTimer[] = [];

async function tickSettle(): Promise<void> {
  const timer = timers.shift();
  assert.ok(timer, "no settle re-read was scheduled");
  assert.equal(timer.ms, SETTLE_POLL_MS);
  clock += timer.ms;
  timer.fn();
  await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  clock = Date.parse("2026-09-10T15:00:00.000Z");
  rules = recordPair();
  timers = [];
  status = { ...status, connected: true, recording: false };
  cueStates.invalidate();
  cueStates.__resetSettle();
  cueStatesDeps.now = () => clock;
  cueStatesDeps.rules = async () => rules;
  cueStatesDeps.setTimeout = (fn, ms) => {
    timers.push({ ms, fn });
    return {} as NodeJS.Timeout;
  };
  cueStatesDeps.clearTimeout = () => {};
});

describe("a pair bound to app:reaper.recording", () => {
  test("reads off while REAPER is connected and idle", async () => {
    const row = (await cueStates.read()).states.reaper_record!;
    assert.equal(row.variable, RECORDING_REF);
    assert.equal(row.state, "off");
    assert.equal(row.value, "off");
    assert.equal(row.reason, undefined);
  });

  test("reads on while REAPER is recording", async () => {
    status = { ...status, recording: true };
    const row = (await cueStates.read()).states.reaper_record!;
    assert.equal(row.state, "on");
    assert.equal(row.value, "on");
  });

  test("a REAPER nobody can reach is unknown, and says why", async () => {
    // NOT "off". An unreachable recorder reported as "not recording" is a switch
    // saying the service is not being recorded when the truth is nobody knows.
    status = { ...status, connected: false, recording: false };
    const row = (await cueStates.read()).states.reaper_record!;
    assert.equal(row.state, "unknown");
    assert.equal(row.value, null);
    assert.equal(row.reason, "REAPER is not connected");
  });

  test("the settle re-read notices REAPER catching up, over an app ref", async () => {
    // The same window a Companion press gets: what was COMMANDED outranks the
    // reading until the transport poll has been round again.
    await cueStates.read();
    cueStates.noteCommand({
      base: "reaper_record",
      want: "on",
      variable: RECORDING_REF,
      wantValue: "on",
    });

    const during = (await cueStates.read()).states.reaper_record!;
    assert.equal(during.settling, true);
    assert.equal(during.commanded, "on");
    assert.equal(during.state, "off", "REAPER has not been polled since the command");

    await tickSettle();
    assert.equal(timers.length, 1, "the re-read gave up while REAPER was still idle");

    status = { ...status, recording: true };
    await tickSettle();
    assert.equal(timers.length, 0, "a re-read outlived the value it was waiting for");
    assert.equal((await cueStates.read()).states.reaper_record!.state, "on");

    clock += SETTLE_MS;
    const after = (await cueStates.read()).states.reaper_record!;
    assert.equal(after.settling, undefined, "the row still claims to be settling after the window");
    assert.equal(after.state, "on");
  });

  test("an explicit state variable on the rule wins over the implicit one", async () => {
    const [on, off] = recordPair();
    on!.trigger.params.stateVariable = "reaper_state";
    rules = [on!, off!];
    const row = (await cueStates.read()).states.reaper_record!;
    assert.equal(row.variable, "reaper_state");
    // Read through the Companion half of the seam, which has no such variable.
    assert.equal(row.state, "unknown");
  });
});
