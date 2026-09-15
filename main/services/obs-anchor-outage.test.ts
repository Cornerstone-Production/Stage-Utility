// The record anchor's failure log: once per OUTAGE, not once per flap and not
// once ever.
//
// This shipped as `if (this.anchorFailures++ === 0)` with a reset on every
// success — in the same release that built OutageLog to replace exactly that
// shape. repeat-log.ts's own header documents what it costs: a transition guard
// assumes an outage is a solid block, and a flaky upstream does not fail that
// way. Both halves are wrong here, in opposite directions:
//
//   - a GetRecordStatus timing out one call in three resets the counter on every
//     success, so every failure is a fresh "first failure" — roughly 180 lines
//     over a 90-minute service at the 30s keepalive, plus a "recovered" line
//     between each pair;
//   - a STEADY failure writes one line and then ninety minutes of silence, while
//     the timecode on every display drifts away from OBS.
//
// Driven through the real anchor() with a stub adapter in place of the socket —
// the same seam reaperDeps.fetch is. The socket itself is exercised by
// obs-record-clock.test.ts against the FakeObs harness; what is under test here
// is the decision about what to write, which is deterministic and wants a
// controlled clock rather than real timers.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-obs-anchor-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { obsService } = await import("./obs-service.js");
import type { ObsStatusDTO } from "../types/stage.js";

/** The private surface this drives. anchor() is the whole subject. */
type Anchorer = {
  adapter: unknown;
  last: ObsStatusDTO;
  anchor: (adapter: unknown, why: string) => Promise<string | null>;
  clearPoll: () => void;
};
const svc = obsService as unknown as Anchorer;

/** Whatever the socket would have answered. Swapped per case. */
let answer: () => Record<string, unknown> = () => ({
  outputActive: true,
  outputPaused: false,
  outputDuration: 754_000,
  outputTimecode: "00:12:34.000",
});
const adapter = {
  request: async (): Promise<Record<string, unknown>> => answer(),
};

const RECORDING: ObsStatusDTO = {
  connected: true,
  recording: true,
  recordPaused: false,
  streaming: false,
  virtualCam: false,
  recordAnchorMs: 754_000,
  recordSampledAt: "2026-09-11T15:20:00.000Z",
};

const realNow = Date.now;
const realWarn = console.warn;
const realLog = console.log;
let clock = Date.parse("2026-09-11T15:20:00.000Z");
let logs: string[] = [];

const failed = (): string[] => logs.filter((l) => l.includes("record anchor") && l.includes("failed"));
const recovered = (): string[] => logs.filter((l) => l.includes("the record anchor is being read again"));

/** One anchor read that OBS rejects. */
const miss = (why = "timed out"): Promise<string | null> => {
  answer = () => {
    throw new Error(why);
  };
  return svc.anchor(adapter, "keepalive");
};

/** One anchor read that succeeds, with a duration that has genuinely moved so
 *  the publish is a real change rather than a no-op. */
const hit = (durationMs: number): Promise<string | null> => {
  answer = () => ({
    outputActive: true,
    outputPaused: false,
    outputDuration: durationMs,
    outputTimecode: "00:12:34.000",
  });
  return svc.anchor(adapter, "keepalive");
};

describe("the record anchor's failure log", () => {
  beforeEach(() => {
    clock = Date.parse("2026-09-11T15:20:00.000Z");
    Date.now = () => clock;
    logs = [];
    console.warn = (...a: unknown[]) => void logs.push(a.join(" "));
    console.log = (...a: unknown[]) => void logs.push(a.join(" "));
    svc.clearPoll();
    svc.adapter = adapter;
    svc.last = { ...RECORDING };
  });

  afterEach(() => {
    Date.now = realNow;
    console.warn = realWarn;
    console.log = realLog;
    svc.clearPoll();
    svc.adapter = null;
    obsService.stop();
  });

  test("an OBS failing every other read is ONE outage, not one line per miss", async () => {
    // GUARD. The production shape: GetRecordStatus timing out roughly one call in
    // three. With a consecutive-failure counter every success resets it, so this
    // writes a warning AND a "recovered" line on each pair.
    for (let i = 0; i < 6; i++) {
      await miss();
      clock += 30_000;
      await hit(754_000 + (i + 1) * 30_000);
      clock += 30_000;
    }

    assert.equal(failed().length, 1, `six alternating misses wrote ${failed().length} lines:\n${logs.join("\n")}`);
    assert.equal(
      recovered().length,
      0,
      `a success inside the settle window was announced as a recovery:\n${logs.join("\n")}`,
    );
  });

  test("a steady failure reminds, rather than going quiet for the rest of the service", async () => {
    // GUARD, the other direction. One line and then silence is what a
    // first-failure flag gives on an OBS that is simply gone, while every display
    // keeps counting forward from an anchor that stopped being true.
    await miss("timed out");
    for (let i = 0; i < 20; i++) {
      clock += 60_000;
      await miss("timed out");
    }

    assert.equal(
      failed().length,
      2,
      `twenty minutes of steady failure wrote ${failed().length} lines:\n${logs.join("\n")}`,
    );
    assert.match(failed()[1], /still failing after 16 attempts/);
  });

  test("a different failure is always news, so one cannot mask the other", async () => {
    await miss("timed out");
    clock += 10_000;
    await miss("Not connected");

    assert.equal(failed().length, 2, "a new kind of failure was hidden behind the first");
    assert.match(failed()[1], /Not connected/);
  });

  test("a recovery that HOLDS is announced once, and accounts for the run", async () => {
    await miss();
    clock += 30_000;
    await miss();
    // Past the settle window, so this success is the end of the run rather than a
    // gap in a flapping one.
    clock += 3 * 60_000;
    await hit(900_000);

    assert.equal(recovered().length, 1, `expected one recovery line:\n${logs.join("\n")}`);
    assert.match(recovered()[0], /after 2 failed attempts/);
  });

  test("the failure is still returned to the caller, logged or not", async () => {
    // anchor()'s contract: the callers are a timer tick and an event handler, so
    // the log is how an operator learns — but the reason still goes back, and a
    // suppressed line must not become a suppressed return value.
    assert.equal(await miss("timed out"), "timed out");
    clock += 1000;
    assert.equal(await miss("timed out"), "timed out", "a quiet repeat swallowed the reason");
    assert.equal(failed().length, 1, "the quiet repeat was not quiet");
  });

  test("a disconnect forgets the run, so the next connection's first miss is news", async () => {
    await miss();
    assert.equal(failed().length, 1);

    svc.clearPoll(); // what a close or a stop does
    logs = [];
    clock += 1000;
    await miss();

    assert.equal(failed().length, 1, "a run carried across a disconnect suppressed the next one's first line");
  });
});
