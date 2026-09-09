// The hourly reconcile's TIMER, as opposed to what one pass decides.
//
// Four things about it, each of which has broken something in this repo before:
//
//  - it is UNREF'D. An un-unref'd housekeeping interval held every test file
//    that boots the controller open forever, and on a real box it is the kind
//    of handle that keeps a process alive through a shutdown.
//  - starting twice arms ONE timer. `startCompanionReconcile` is called from
//    init and again from every settings save, so a start that stacked would
//    have the pass running once per save per hour.
//  - `start(false)` disarms it. Clearing the Companion host must stop the app
//    dialling a service that is switched off.
//  - a tick actually runs the pass, once. A timer that fires into nothing is
//    the same as no timer, and nothing else in the suite would notice.
//
// `globalThis.setInterval` is stubbed rather than using `mock.timers`, and the
// reason is the first item: node:test's mock timers hand back a handle whose
// `unref` is a function that records nothing, so the one property that has
// bitten this repo would be unobservable. The stub records the interval, whether
// unref was called on it, and every clear — and hands back the callback so a
// tick can be fired by hand.

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fsp from "node:fs/promises";

// companion-api's getTarget seam reaches the integration manager, which resolves
// the data directory at import. Point it somewhere disposable first.
process.env.STAGE_UTILITY_DATA = await fsp.mkdtemp(path.join(os.tmpdir(), "companion-timer-"));

const { companionDeps } = await import("./companion-api.js");
const { RECONCILE_EVERY_MS, startCompanionReconcile, stopCompanionReconcile } = await import(
  "./companion-reconcile.js"
);

/** One armed interval, as the stub saw it. */
interface Armed {
  ms: number;
  fire: () => void;
  unrefd: boolean;
  cleared: boolean;
}

const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const realFetch = companionDeps.fetch;
const realTarget = companionDeps.getTarget;

let armed: Armed[] = [];
/** How many times the pass dialled Companion. */
let dialled = 0;

function stubTimers(): void {
  armed = [];
  globalThis.setInterval = ((fn: () => void, ms: number) => {
    const entry: Armed = { ms, fire: fn, unrefd: false, cleared: false };
    armed.push(entry);
    // Shaped like a Timeout as far as this module uses one: it calls `.unref()`
    // on the handle and passes it back to clearInterval.
    return {
      __armed: entry,
      unref() {
        entry.unrefd = true;
        return this;
      },
      ref() {
        return this;
      },
    };
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = ((handle: unknown) => {
    const entry = (handle as { __armed?: Armed } | null)?.__armed;
    if (entry) entry.cleared = true;
  }) as unknown as typeof clearInterval;
}

/** The timers still running: armed and not cleared. */
const live = (): Armed[] => armed.filter((a) => !a.cleared);

afterEach(() => {
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
  stopCompanionReconcile();
  companionDeps.fetch = realFetch;
  companionDeps.getTarget = realTarget;
});

describe("the hourly reconcile timer", () => {
  test("a host arms ONE unref'd hourly interval, however many times start is called", () => {
    stubTimers();
    startCompanionReconcile(true);
    assert.equal(live().length, 1);
    assert.equal(live()[0]!.ms, RECONCILE_EVERY_MS);
    assert.equal(live()[0]!.unrefd, true, "a housekeeping sweep must not keep the process alive");

    // Called from init and again from every settings save. Stacking would run
    // the pass once per save per hour.
    startCompanionReconcile(true);
    startCompanionReconcile(true);
    assert.equal(live().length, 1, "start stacked a second timer");
    assert.equal(armed.length, 3, "the earlier timers were not replaced");
  });

  test("no host arms nothing, and clears what was armed", () => {
    stubTimers();
    startCompanionReconcile(true);
    assert.equal(live().length, 1);

    // Clearing the Companion host must stop the app dialling a service that is
    // switched off.
    startCompanionReconcile(false);
    assert.deepEqual(live(), []);
  });

  test("stop disarms it, and stopping twice is not an error", () => {
    stubTimers();
    startCompanionReconcile(true);
    stopCompanionReconcile();
    stopCompanionReconcile();
    assert.deepEqual(live(), []);
  });

  test("a tick runs the pass, ONCE", async () => {
    // A timer that fires into nothing is the same as no timer, and nothing else
    // in the suite would notice. The pass is observed by the one thing it always
    // does first: dial Companion.
    dialled = 0;
    companionDeps.getTarget = async () => ({ host: "10.0.0.5", port: 8000 });
    companionDeps.fetch = async () => {
      dialled++;
      throw new Error("ETIMEDOUT");
    };
    stubTimers();
    startCompanionReconcile(true);

    live()[0]!.fire();
    // The callback is `void runCompanionReconcile()`, so the fetch is a
    // microtask behind the tick. setTimeout, not the stubbed setInterval — an
    // interval waited on here never gets cleared and holds the runner open.
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(dialled, 1, "a tick did not run the pass");
  });
});
