// Tests for the three update modes and the migration off the old boolean.
//
// Two things here are worth protecting. The migration runs exactly once per
// install, silently, against config written by a previous version — get it wrong
// and a site that had auto-updates on quietly stops receiving them, or worse, a
// site that had them OFF starts restarting itself. And the auto-apply gate decides
// whether a machine restarts on its own, so every reason it should decline is
// pinned individually.

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import type { UpdateMode } from "../types/stage.js";
import { autoApplyDecision, migrateAutoUpdate } from "./auto-apply-gate.js";

const migrate = migrateAutoUpdate;

/** The gate, from the fields these tests vary. `now` is the app-zone weekday and hour. */
function shouldAutoApply(opts: {
  mode: UpdateMode;
  behind: number;
  updating: boolean;
  serviceLive: boolean;
  liveKnown?: boolean;
  windowUntil?: number | null;
  dayOfWeek: number | null;
  hour: number;
  now: { weekday: number; hour: number };
}): boolean {
  return autoApplyDecision({
    cfg: { mode: opts.mode, dayOfWeek: opts.dayOfWeek, hour: opts.hour },
    behind: opts.behind,
    updating: opts.updating,
    serviceLive: opts.serviceLive,
    liveKnown: opts.liveKnown ?? true,
    windowUntil: opts.windowUntil ?? null,
    now: opts.now,
  }).apply;
}

describe("migration off the pre-mode boolean", () => {
  test("enabled:true becomes auto-full — the old behavior was apply AND restart", () => {
    assert.equal(migrate({ enabled: true, dayOfWeek: 2, hour: 4 }).mode, "auto-full");
  });

  test("enabled:false becomes manual", () => {
    assert.equal(migrate({ enabled: false, dayOfWeek: null, hour: 3 }).mode, "manual");
  });

  test("absent config becomes manual — a fresh install must not self-restart", () => {
    assert.equal(migrate(undefined).mode, "manual");
    assert.equal(migrate({}).mode, "manual");
    assert.equal(migrate(null).mode, "manual");
  });

  test("the schedule survives migration", () => {
    const m = migrate({ enabled: true, dayOfWeek: 0, hour: 2 });
    assert.equal(m.dayOfWeek, 0);
    assert.equal(m.hour, 2);
  });

  test("an explicit mode wins over a stale boolean", () => {
    // Once migrated, the boolean may linger in the file; it must not override.
    assert.equal(migrate({ mode: "manual", enabled: true }).mode, "manual");
    assert.equal(migrate({ mode: "auto-install", enabled: false }).mode, "auto-install");
  });

  test("a nonsense mode falls back rather than propagating", () => {
    assert.equal(migrate({ mode: "banana" }).mode, "manual");
    assert.equal(migrate({ mode: "banana", enabled: true }).mode, "auto-full");
  });

  test("migration is idempotent", () => {
    const once = migrate({ enabled: true, dayOfWeek: 3, hour: 5 });
    assert.deepEqual(migrate(once), once);
  });
});

describe("the auto-apply gate", () => {
  const SUNDAY = 0;
  const base = { behind: 2, updating: false, serviceLive: false, dayOfWeek: null, hour: 3, now: { weekday: SUNDAY, hour: 3 } };

  test("manual never auto-applies, even in the window", () => {
    assert.equal(shouldAutoApply({ ...base, mode: "manual" }), false);
  });

  test("auto-install and auto-full both apply in the window", () => {
    assert.equal(shouldAutoApply({ ...base, mode: "auto-install" }), true);
    assert.equal(shouldAutoApply({ ...base, mode: "auto-full" }), true);
  });

  test("nothing applies when there is nothing to pull", () => {
    assert.equal(shouldAutoApply({ ...base, mode: "auto-full", behind: 0 }), false);
  });

  test("nothing applies mid-service, in ANY automatic mode", () => {
    // The whole point: a display must not restart during a service.
    for (const mode of ["auto-install", "auto-full"] as const) {
      assert.equal(shouldAutoApply({ ...base, mode, serviceLive: true }), false, mode);
    }
  });

  test("nothing applies while an update is already running", () => {
    assert.equal(shouldAutoApply({ ...base, mode: "auto-full", updating: true }), false);
  });

  test("the hour must match", () => {
    assert.equal(shouldAutoApply({ ...base, mode: "auto-full", now: { weekday: SUNDAY, hour: 4 } }), false);
  });

  test("a day restriction is honoured, and null means any day", () => {
    const sunday = { weekday: SUNDAY, hour: 3 };
    assert.equal(shouldAutoApply({ ...base, mode: "auto-full", dayOfWeek: SUNDAY, now: sunday }), true);
    assert.equal(shouldAutoApply({ ...base, mode: "auto-full", dayOfWeek: SUNDAY + 1, now: sunday }), false);
    assert.equal(shouldAutoApply({ ...base, mode: "auto-full", dayOfWeek: null, now: sunday }), true);
  });

  test("with the live state unknown, a cached service window open now holds it", () => {
    // Planning Center not answering: the last reading said nothing was live, but a
    // service may have started since. The cached plan says one is on now.
    const d = autoApplyDecision({
      cfg: { mode: "auto-full", dayOfWeek: null, hour: 3 },
      behind: 2, updating: false, serviceLive: false, liveKnown: false, windowUntil: Date.now() + 60_000,
      now: { weekday: SUNDAY, hour: 3 },
    });
    assert.deepEqual(d, { apply: false, why: "window" });
  });

  test("with the live state unknown and no cached window open, the schedule applies", () => {
    // An outage, or bad credentials, must not hold every update for as long as it lasts.
    assert.equal(shouldAutoApply({ ...base, mode: "auto-full", liveKnown: false, windowUntil: null }), true);
  });

  test("with the live state known, a window alone does not hold it", () => {
    // The reading is current and says nothing is live: the pre-service lead is
    // the operator's chosen hour to update, as before.
    assert.equal(shouldAutoApply({ ...base, mode: "auto-full", liveKnown: true, windowUntil: Date.now() + 60_000 }), true);
  });
});
