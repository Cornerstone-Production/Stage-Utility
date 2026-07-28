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

import type { AutoUpdateSettings, UpdateMode } from "../types/stage.js";

/** Mirrors migrateAutoUpdate in stage-controller.ts. */
function migrate(saved: unknown): AutoUpdateSettings {
  const o = (saved ?? {}) as Partial<AutoUpdateSettings> & { enabled?: boolean };
  const mode: UpdateMode =
    o.mode === "auto-install" || o.mode === "auto-full" || o.mode === "manual"
      ? o.mode
      : o.enabled === true
        ? "auto-full"
        : "manual";
  return {
    mode,
    dayOfWeek: typeof o.dayOfWeek === "number" ? o.dayOfWeek : null,
    hour: typeof o.hour === "number" ? o.hour : 3,
  };
}

/** Mirrors shouldAutoApply's decision, minus the updater/service lookups. */
function shouldAutoApply(opts: {
  mode: UpdateMode;
  behind: number;
  updating: boolean;
  serviceLive: boolean;
  dayOfWeek: number | null;
  hour: number;
  now: Date;
}): boolean {
  if (opts.mode === "manual" || opts.behind <= 0) return false;
  if (opts.updating) return false;
  if (opts.serviceLive) return false;
  if (opts.dayOfWeek != null && opts.now.getDay() !== opts.dayOfWeek) return false;
  return opts.now.getHours() === opts.hour;
}

describe("migration off the pre-mode boolean", () => {
  test("enabled:true becomes auto-full — the old behaviour was apply AND restart", () => {
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
  const base = { behind: 2, updating: false, serviceLive: false, dayOfWeek: null, hour: 3, now: new Date(2026, 6, 26, 3, 0) };

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
    assert.equal(shouldAutoApply({ ...base, mode: "auto-full", now: new Date(2026, 6, 26, 4, 0) }), false);
  });

  test("a day restriction is honoured, and null means any day", () => {
    const sunday = new Date(2026, 6, 26, 3, 0); // a Sunday
    assert.equal(shouldAutoApply({ ...base, mode: "auto-full", dayOfWeek: sunday.getDay(), now: sunday }), true);
    assert.equal(shouldAutoApply({ ...base, mode: "auto-full", dayOfWeek: (sunday.getDay() + 1) % 7, now: sunday }), false);
    assert.equal(shouldAutoApply({ ...base, mode: "auto-full", dayOfWeek: null, now: sunday }), true);
  });
});
