// The bug these exist to prevent: the 60-minute post-service taper was configured,
// read from settings every tick, and unreachable. PCO reports mode "preservice"
// whenever a service time exists and no item is live — the normal state the moment
// an operator drops out of live mode after the benediction — and the preservice
// branch returned before the taper check could run. Every Sunday's attendance
// curve stopped dead at the last item instead of tracking the room emptying.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PcoLiveDTO } from "../types/stage.js";
import { RAMP_GRACE_MS, classifyPhase, type PhaseContext } from "./attendance-phase.js";

const SERVICE_START = Date.parse("2026-08-09T15:30:00Z"); // 10:30 America/Chicago
const HOUR = 60 * 60_000;

/** No item live, but PCO still reports the service time — the post-benediction state. */
function preservice(over: Partial<PcoLiveDTO> = {}): PcoLiveDTO {
  return {
    mode: "preservice",
    currentItemId: null,
    label: "Service starts",
    lengthSec: null,
    liveStartAt: null,
    targetAt: new Date(SERVICE_START).toISOString(),
    serverNow: new Date().toISOString(),
    currentItemTitle: null,
    nextItemTitle: null,
    serviceTimeId: "st-1",
    serviceTimeStartsAt: new Date(SERVICE_START).toISOString(),
    ...over,
  } as PcoLiveDTO;
}

/** A live plan item running. */
function item(over: Partial<PcoLiveDTO> = {}): PcoLiveDTO {
  return { ...preservice(), mode: "item", currentItemId: "item-1", label: "Sermon", ...over } as PcoLiveDTO;
}

const ctx = (over: Partial<PhaseContext> = {}): PhaseContext => ({
  hasOpenRecord: false,
  endedAt: null,
  preMs: 60 * 60_000,
  postMs: 60 * 60_000,
  ...over,
});

describe("post-service taper", () => {
  // The regression. Service ended 11:50, we are at 12:05, PCO says "preservice"
  // because the service time is still set. The taper has 45 minutes left to run.
  const ENDED = Date.parse("2026-08-09T16:50:00Z"); // 11:50 local
  const ended = new Date(ENDED).toISOString();

  it("keeps sampling in preservice mode after the service ends", () => {
    const phase = classifyPhase(preservice(), ctx({ endedAt: ended }), ENDED + 15 * 60_000);
    assert.equal(phase, "post", "the taper must not be shadowed by the preservice branch");
  });

  it("runs for the full configured window", () => {
    const c = ctx({ endedAt: ended });
    assert.equal(classifyPhase(preservice(), c, ENDED + 59 * 60_000), "post");
    assert.equal(classifyPhase(preservice(), c, ENDED + HOUR), "post", "inclusive at the boundary");
  });

  it("stops once the window has passed", () => {
    const phase = classifyPhase(preservice(), ctx({ endedAt: ended }), ENDED + HOUR + 60_000);
    assert.equal(phase, null);
  });

  it("still works in mode none, as it always did", () => {
    const live = preservice({ mode: "none", serviceTimeStartsAt: null, targetAt: null });
    assert.equal(classifyPhase(live, ctx({ endedAt: ended }), ENDED + 15 * 60_000), "post");
  });

  it("does not run when the taper is disabled", () => {
    const phase = classifyPhase(preservice(), ctx({ endedAt: ended, postMs: 0 }), ENDED + 60_000);
    assert.equal(phase, null);
  });

  it("does not run for a record that was never closed", () => {
    assert.equal(classifyPhase(preservice(), ctx({ endedAt: null }), ENDED), null);
  });
});

describe("arrival ramp", () => {
  it("samples inside the lead window", () => {
    assert.equal(classifyPhase(preservice(), ctx(), SERVICE_START - 30 * 60_000), "pre");
  });

  it("does not sample before the lead window opens", () => {
    assert.equal(classifyPhase(preservice(), ctx(), SERVICE_START - 90 * 60_000), null);
  });

  it("wins over a previous service's taper when the two overlap", () => {
    // 9am ends 10:15, 10:30 starts: at 10:20 both windows are open. The room is
    // filling for the next service, not emptying from the last.
    const ended = new Date(SERVICE_START - 15 * 60_000).toISOString();
    const phase = classifyPhase(preservice(), ctx({ endedAt: ended }), SERVICE_START - 10 * 60_000);
    assert.equal(phase, "pre");
  });

  it("gives way to the taper once the start has passed by more than the grace", () => {
    const ended = new Date(SERVICE_START - 15 * 60_000).toISOString();
    const phase = classifyPhase(
      preservice(),
      ctx({ endedAt: ended }),
      SERVICE_START + RAMP_GRACE_MS + 60_000,
    );
    assert.equal(phase, "post", "an unreachable ramp must fall through, not return null");
  });
});

describe("the latch", () => {
  it("records the service proper while an item is live", () => {
    assert.equal(classifyPhase(item(), ctx({ hasOpenRecord: true }), SERVICE_START + HOUR), "service");
  });

  it("is never demoted to the taper by a stale endedAt", () => {
    // The outage in one line: a live item with an open record outranks every clock.
    const c = ctx({ hasOpenRecord: true, endedAt: new Date(SERVICE_START).toISOString() });
    assert.equal(classifyPhase(item(), c, SERVICE_START + 3 * HOUR), "service");
  });

  it("reclassifies to post on the plan's own SERVICE END header", () => {
    const c = ctx({ hasOpenRecord: true });
    assert.equal(classifyPhase(item({ serviceEnded: true }), c, SERVICE_START + HOUR), "post");
  });

  it("reclassifies to pre for an item above the SERVICE START header", () => {
    const c = ctx({ hasOpenRecord: true });
    assert.equal(classifyPhase(item({ beforeServiceStart: true }), c, SERVICE_START), "pre");
  });
});
