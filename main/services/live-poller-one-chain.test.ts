// One poll chain, whatever lands while a tick is waiting on Planning Center.
//
// start() runs from boot, from integration-manager every time a PCO credential
// check passes, and from a config restore's undo (pause() then resume). At the
// 1 s live cadence a tick is usually awaiting fetchLive when any of those
// arrives. The poller once armed its next tick from both the old tick and the
// new one: the second handle overwrote the first, the first was never cleared,
// and two self-rescheduling chains polled PCO at double rate, ticking every
// recorder and auto-advance twice a period, until stop().
//
// And the old tick, finishing late, acted on what it read: a read made with the
// credentials just replaced, or from before the files a restore laid down.
//
// Drives the REAL poller on fake timers, with only stageController.fetchLive and
// maybeAutoAdvance replaced. Every resolved read is a live item, so the cadence
// is a flat 1 s and "one fetch a second" is exact.

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach, type TestContext } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-poller-chain-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { livePoller } = await import("./live-poller.js");
const { stageController } = await import("./stage-controller.js");
const { addBroadcastListener } = await import("./broadcaster.js");

type Controller = { fetchLive: () => Promise<unknown>; maybeAutoAdvance: () => Promise<void> };
const real = {
  fetchLive: stageController.fetchLive.bind(stageController),
  maybeAutoAdvance: stageController.maybeAutoAdvance.bind(stageController),
};

const ITEM = { mode: "item", currentItemId: "i1", serverNow: "2026-09-20T15:00:00.000Z" };

let fetches = 0;
let advances = 0;
/** Resolves the read being held, if one is. */
let releaseHeld: (() => void) | null = null;
let holdNext = false;
const labels: string[] = [];
addBroadcastListener((channel, payload) => {
  if (channel === "pco:live") labels.push((payload as { label: string }).label);
});

/** A fetch that answers a live item at once, except the one asked to hang,
 *  which answers "stale" only when released. */
function stubController(): void {
  const c = stageController as unknown as Controller;
  c.fetchLive = () => {
    fetches++;
    if (holdNext) {
      holdNext = false;
      return new Promise((resolve) => {
        releaseHeld = () => resolve({ ...ITEM, label: "stale" });
      });
    }
    return Promise.resolve({ ...ITEM, label: `read ${fetches}` });
  };
  c.maybeAutoAdvance = () => {
    advances++;
    return Promise.resolve();
  };
}

/** Let a tick's awaits run. setImmediate is not one of the faked timers. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

let base = Date.UTC(2026, 8, 20, 15);
function fakeTime(t: TestContext): void {
  base += 3_600_000;
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: base });
}

async function advanceSeconds(t: TestContext, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    t.mock.timers.tick(1_000);
    await settle();
  }
}

/** Start with the first read hanging, then let `interrupt` land on it. */
async function interruptInFlightTick(interrupt: () => void): Promise<void> {
  holdNext = true;
  livePoller.start();
  await settle();
  assert.equal(fetches, 1, "the first read is in flight — that is the premise");
  interrupt();
  await settle();
  assert.equal(fetches, 2, "the interruption reads again at once");
}

describe("live-poller: one poll chain", () => {
  beforeEach(() => {
    livePoller.stop();
    fetches = 0;
    advances = 0;
    releaseHeld = null;
    holdNext = false;
    labels.length = 0;
    stubController();
  });
  afterEach(() => {
    livePoller.stop();
    Object.assign(stageController, real);
  });

  for (const [what, interrupt] of [
    ["start() (a PCO credential save)", () => livePoller.start()],
    ["pause() and its undo (a config restore)", () => livePoller.pause()()],
  ] as const) {
    it(`${what} while a tick awaits fetchLive leaves exactly one chain`, async (t) => {
      fakeTime(t);
      await interruptInFlightTick(interrupt);

      // The old tick's read comes back late.
      releaseHeld!();
      await settle();

      await advanceSeconds(t, 5);
      assert.equal(fetches, 2 + 5, "one fetch a second: a second chain doubles it, and the late tick re-arming at its own delay stalls it");
    });

    it(`${what}: the overtaken tick acts on nothing it read`, async (t) => {
      fakeTime(t);
      await interruptInFlightTick(interrupt);
      releaseHeld!();
      await settle();

      assert.ok(!labels.includes("stale"), `a read from before the restart was broadcast: ${labels.join(", ")}`);
      assert.equal(advances, 1, "only the fresh tick runs auto-advance");
    });
  }

  it("a read that hangs past several of the new chain's ticks still leaves one chain", async (t) => {
    fakeTime(t);
    await interruptInFlightTick(() => livePoller.start());
    await advanceSeconds(t, 3);
    assert.equal(fetches, 2 + 3, "the new chain ticks once a second");

    releaseHeld!();
    await settle();
    await advanceSeconds(t, 5);
    assert.equal(fetches, 2 + 3 + 5, "the late read must neither start a chain of its own nor reset the live one's timer");
  });

  it("stop() while a tick awaits fetchLive leaves no chain, and the late read acts on nothing", async (t) => {
    fakeTime(t);
    holdNext = true;
    livePoller.start();
    await settle();
    livePoller.stop();
    releaseHeld!();
    await settle();
    await advanceSeconds(t, 5);

    assert.equal(fetches, 1, "a stopped poller asked Planning Center again");
    assert.deepEqual(labels, [], "a stopped poller broadcast");
    assert.equal(advances, 0, "a stopped poller ran auto-advance, which can write settings.json under a restore");
  });
});
