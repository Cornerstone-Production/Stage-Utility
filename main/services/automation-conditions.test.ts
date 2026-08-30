// Conditions are the cross-cutting qualifiers — "only during a service", "only on
// Sundays". Without them the trigger list would explode into combinations like
// occupancy.crossed-above-during-service-on-sunday.

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { AUTOMATION_CONDITIONS, allConditionsHold } from "./automation-conditions.js";
import type { ConditionCtx } from "../types/automation.js";
import type { PvpLayerDTO } from "../types/pvp.js";

// Sunday 2026-07-26 is a Sunday; 10:00 local.
const SUNDAY_10AM = Date.parse("2026-07-26T10:00:00Z");
const ctx = (over: Partial<ConditionCtx> = {}): ConditionCtx => ({
  pcoLive: { mode: "item", serviceTimeId: "st1" },
  serviceTypeId: "weekend",
  integrations: {},
  obsRecording: false,
  reaperRecording: false,
  resiStreaming: false,
  youtubeStreaming: false,
  baptismPhase: null,
  pvpLayers: null,
  ...over,
});

describe("service.is-live", () => {
  const c = AUTOMATION_CONDITIONS["service.is-live"];
  test("holds while an item is live", () => {
    assert.equal(c.holds(ctx(), {}, SUNDAY_10AM), true);
  });
  test("does not hold pre-service or when nothing is live", () => {
    assert.equal(c.holds(ctx({ pcoLive: { mode: "preservice", serviceTimeId: null } }), {}, SUNDAY_10AM), false);
    assert.equal(c.holds(ctx({ pcoLive: null }), {}, SUNDAY_10AM), false);
  });
});

describe("service.type-is", () => {
  const c = AUTOMATION_CONDITIONS["service.type-is"];
  test("holds when the active service type matches", () => {
    assert.equal(c.holds(ctx(), { serviceTypeId: "weekend" }, SUNDAY_10AM), true);
    assert.equal(c.holds(ctx(), { serviceTypeId: "youth" }, SUNDAY_10AM), false);
  });
  test("does not hold when no service type is active", () => {
    assert.equal(c.holds(ctx({ serviceTypeId: null }), { serviceTypeId: "weekend" }, SUNDAY_10AM), false);
  });
});

describe("time.day-of-week", () => {
  const c = AUTOMATION_CONDITIONS["time.day-of-week"];
  test("holds on a selected day", () => {
    const sunday = new Date(SUNDAY_10AM).getDay(); // local day index
    assert.equal(c.holds(ctx(), { days: String(sunday) }, SUNDAY_10AM), true);
  });
  test("does not hold on an unselected day", () => {
    const notToday = (new Date(SUNDAY_10AM).getDay() + 1) % 7;
    assert.equal(c.holds(ctx(), { days: String(notToday) }, SUNDAY_10AM), false);
  });
  test("accepts a comma-separated list", () => {
    const today = new Date(SUNDAY_10AM).getDay();
    assert.equal(c.holds(ctx(), { days: `${(today + 3) % 7},${today}` }, SUNDAY_10AM), true);
  });
  test("an empty selection holds — an unconfigured condition must not block", () => {
    assert.equal(c.holds(ctx(), { days: "" }, SUNDAY_10AM), true);
  });
});

describe("time.between", () => {
  const c = AUTOMATION_CONDITIONS["time.between"];
  const at = (h: number, m = 0) => {
    const d = new Date(SUNDAY_10AM);
    d.setHours(h, m, 0, 0);
    return d.getTime();
  };
  test("holds inside the window", () => {
    assert.equal(c.holds(ctx(), { from: "09:00", to: "12:00" }, at(10)), true);
  });
  test("does not hold outside it", () => {
    assert.equal(c.holds(ctx(), { from: "09:00", to: "12:00" }, at(8)), false);
    assert.equal(c.holds(ctx(), { from: "09:00", to: "12:00" }, at(13)), false);
  });
  test("handles a window crossing midnight", () => {
    assert.equal(c.holds(ctx(), { from: "22:00", to: "02:00" }, at(23)), true);
    assert.equal(c.holds(ctx(), { from: "22:00", to: "02:00" }, at(1)), true);
    assert.equal(c.holds(ctx(), { from: "22:00", to: "02:00" }, at(12)), false);
  });
});

describe("allConditionsHold", () => {
  test("an empty list always holds", () => {
    assert.equal(allConditionsHold([], ctx(), SUNDAY_10AM), true);
  });
  test("every condition must hold", () => {
    const ok = { id: "service.is-live", params: {} };
    const no = { id: "service.type-is", params: { serviceTypeId: "youth" } };
    assert.equal(allConditionsHold([ok], ctx(), SUNDAY_10AM), true);
    assert.equal(allConditionsHold([ok, no], ctx(), SUNDAY_10AM), false);
  });
  test("an unknown condition id fails CLOSED", () => {
    // A rule referencing a condition this build does not have must not fire.
    assert.equal(allConditionsHold([{ id: "nope", params: {} }], ctx(), SUNDAY_10AM), false);
  });
});

// ── Integration connections ────────────────────────────────────────────────

const INTEGRATION_IDS = [
  "companion", "obs", "osc", "planning-center", "prodcom", "propresenter",
  "reaper", "ross-tsl", "rosstalk", "sensource", "smaart", "wireless",
] as const;

describe("integration connection conditions", () => {
  test("is-connected is registered for every integration", () => {
    for (const id of INTEGRATION_IDS) {
      assert.ok(AUTOMATION_CONDITIONS[`${id}.is-connected`], `${id}.is-connected must be registered`);
    }
  });

  test("holds only while that integration reports connected", () => {
    const c = AUTOMATION_CONDITIONS["obs.is-connected"];
    assert.equal(c.holds(ctx({ integrations: { obs: "connected" } }), {}, SUNDAY_10AM), true);
    assert.equal(c.holds(ctx({ integrations: { obs: "connecting" } }), {}, SUNDAY_10AM), false);
    assert.equal(c.holds(ctx({ integrations: {} }), {}, SUNDAY_10AM), false);
  });

  test("one integration's state does not satisfy another's condition", () => {
    const c = AUTOMATION_CONDITIONS["obs.is-connected"];
    assert.equal(c.holds(ctx({ integrations: { reaper: "connected" } }), {}, SUNDAY_10AM), false);
  });
});

// ── Recording state ────────────────────────────────────────────────────────

describe("recorder conditions", () => {
  test("obs.is-recording holds only while OBS records", () => {
    const c = AUTOMATION_CONDITIONS["obs.is-recording"];
    assert.ok(c, "obs.is-recording must be registered");
    assert.equal(c.holds(ctx({ obsRecording: true }), {}, SUNDAY_10AM), true);
    assert.equal(c.holds(ctx({ obsRecording: false }), {}, SUNDAY_10AM), false);
  });

  test("reaper.is-recording holds only while REAPER records", () => {
    const c = AUTOMATION_CONDITIONS["reaper.is-recording"];
    assert.ok(c, "reaper.is-recording must be registered");
    assert.equal(c.holds(ctx({ reaperRecording: true }), {}, SUNDAY_10AM), true);
    assert.equal(c.holds(ctx({ reaperRecording: false }), {}, SUNDAY_10AM), false);
  });

  test("the two recorders are independent", () => {
    assert.equal(
      AUTOMATION_CONDITIONS["obs.is-recording"].holds(ctx({ reaperRecording: true }), {}, SUNDAY_10AM),
      false,
    );
  });
});

describe("baptism.phase-is", () => {
  const c = () => AUTOMATION_CONDITIONS["baptism.phase-is"];
  test("holds only for the named phase", () => {
    assert.ok(c(), "baptism.phase-is must be registered");
    assert.equal(c().holds(ctx({ baptismPhase: "testimony" }), { phase: "testimony" }, SUNDAY_10AM), true);
    assert.equal(c().holds(ctx({ baptismPhase: "baptism" }), { phase: "testimony" }, SUNDAY_10AM), false);
  });
  test("does not hold when the timer has never run", () => {
    assert.equal(c().holds(ctx({ baptismPhase: null }), { phase: "idle" }, SUNDAY_10AM), false);
  });
});

describe("ProVideoPlayer conditions", () => {
  const layer = (over: Partial<PvpLayerDTO> = {}): PvpLayerDTO => ({
    uuid: "l1", name: "Graphics", index: 0, state: "video",
    mediaName: "loop_a.mp4", mediaUuid: "m1", lastCueName: "MAIN GRAPHIC", lastCueUuid: "c1", nextCueName: null,
    hidden: false, muted: false, opacity: 1, playbackRate: 1,
    anchorElapsedSec: 1, durationSec: 20,
    ...over,
  });
  const holds = (id: string, pvpLayers: PvpLayerDTO[] | null, params: Record<string, unknown> = {}) =>
    AUTOMATION_CONDITIONS[id].holds(ctx({ pvpLayers }), params, SUNDAY_10AM);

  test("a named layer has content", () => {
    assert.equal(holds("pvp.layer-has-content", [layer()], { layer: "Graphics" }), true);
    assert.equal(holds("pvp.layer-has-content", [layer({ state: "empty" })], { layer: "Graphics" }), false);
  });

  test("a residual cue name does NOT make an empty layer count as having content", () => {
    // The finding, as a condition. lastCueName survives on an empty layer, and
    // four idle layers were observed all naming the same cue.
    const stale = layer({ state: "empty", mediaUuid: null, mediaName: null, lastCueName: "MAIN GRAPHIC" });
    assert.equal(holds("pvp.layer-has-content", [stale], { layer: "Graphics" }), false);
  });

  test("a still image is content, but is NOT playing", () => {
    const still = layer({ state: "still", playbackRate: 0 });
    assert.equal(holds("pvp.layer-has-content", [still], { layer: "Graphics" }), true);
    assert.equal(holds("pvp.layer-is-playing", [still], { layer: "Graphics" }), false);
    assert.equal(holds("pvp.layer-is-playing", [layer()], { layer: "Graphics" }), true);
  });

  test("hidden and muted read the layer's own flags, and not each other's", () => {
    assert.equal(holds("pvp.layer-is-hidden", [layer({ hidden: true })], { layer: "Graphics" }), true);
    assert.equal(holds("pvp.layer-is-hidden", [layer()], { layer: "Graphics" }), false);
    assert.equal(holds("pvp.layer-is-muted", [layer({ muted: true })], { layer: "Graphics" }), true);
    assert.equal(holds("pvp.layer-is-muted", [layer({ hidden: true })], { layer: "Graphics" }), false);
    assert.equal(holds("pvp.layer-is-hidden", [layer({ muted: true })], { layer: "Graphics" }), false);
  });

  test("the layer name matches case-insensitively and ignores stray spaces", () => {
    assert.equal(holds("pvp.layer-has-content", [layer()], { layer: "  graphics " }), true);
  });

  test("the workspace condition asks about any layer at all", () => {
    assert.equal(holds("pvp.workspace-has-content", [layer({ state: "empty" }), layer({ uuid: "l2" })]), true);
    assert.equal(holds("pvp.workspace-has-content", [layer({ state: "empty" })]), false);
    assert.equal(holds("pvp.workspace-has-content", []), false);
  });

  test("a layer named by a rule that does not exist does not hold", () => {
    // It must not fall back to "any layer": a typo would then qualify a rule
    // against a layer the operator never meant.
    assert.equal(holds("pvp.layer-has-content", [layer()], { layer: "Typo" }), false);
  });

  test("an UNCONFIGURED layer param does not hold either", () => {
    // Deliberately unlike the triggers, where blank means "any". A condition is a
    // qualifier: "some layer, I did not say which, has content" is the workspace
    // condition, which exists separately and says so by name.
    assert.equal(holds("pvp.layer-has-content", [layer()], { layer: "" }), false);
    assert.equal(holds("pvp.layer-has-content", [layer()], {}), false);
  });

  test("NOTHING holds when PVP has never connected", () => {
    // null is "we do not know". An unreachable PVP must not make "the workspace
    // has nothing on screen" true and gate a rule on a fiction.
    //
    // A REGRESSION TEST, NOT A PROVED GUARD, said plainly. Replacing the null
    // checks with `ctx.pvpLayers ?? []` leaves this GREEN: an empty list finds no
    // named layer and satisfies no `some`, so both paths answer false today. The
    // null check earns its place against the condition nobody has written yet —
    // a negative one ("PVP has nothing on screen"), where `[]` must hold and null
    // must not — and against a refactor that changes what an empty list means.
    // It is kept and documented rather than deleted, and it is not claimed as a
    // guard that fails on its bug, because it does not.
    for (const id of Object.keys(AUTOMATION_CONDITIONS).filter((k) => k.startsWith("pvp.") && k !== "pvp.is-connected")) {
      assert.equal(
        AUTOMATION_CONDITIONS[id].holds(ctx({ pvpLayers: null }), { layer: "Graphics" }, SUNDAY_10AM),
        false,
        `${id} held on a null workspace`,
      );
    }
  });

  test("every PVP condition survives a malformed param without throwing", () => {
    for (const id of Object.keys(AUTOMATION_CONDITIONS).filter((k) => k.startsWith("pvp.") && k !== "pvp.is-connected")) {
      for (const params of [{}, { layer: null }, { layer: 7 }, { layer: {} }]) {
        assert.doesNotThrow(
          () => AUTOMATION_CONDITIONS[id].holds(ctx({ pvpLayers: [layer()] }), params as never, SUNDAY_10AM),
          `${id} threw on ${JSON.stringify(params)}`,
        );
      }
    }
  });
});
