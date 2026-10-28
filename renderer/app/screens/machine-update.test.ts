// What a screen's card and its Device section say about the machine's own
// updates, and which button each state offers.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CHECK_INTERVAL_MS, type MachineUpdate } from "@main/services/machine-updates";
import type { OutputHealth } from "@main/types/output-health";
import { machineOf, readUpdate } from "./machine-update";

const MAC = "5f1c09ab-7e22-4c1d-9b04-e6c1aa000001";
const output = { id: `${MAC}.decklink-e0f7d5d0-0`, output: { kind: "decklink" as const, name: "SDI 1", port: "SDI 1" } };
const base: MachineUpdate = {
  machine: MAC,
  platform: "macos",
  host: "booth-mini",
  have: "1.26.0",
  want: "1.27.0",
  state: "idle",
  checkedAt: 0,
  update: false,
  reason: "the server's sentence",
  waitingOn: "window",
};
const heard = (over: Partial<MachineUpdate> = {}) => ({ updates: [{ ...base, ...over }], health: [], updatesListeningFor: 0, readAt: 0 });

describe("machineOf", () => {
  it("is the Mac's id for each of its outputs, and a kiosk's own id", () => {
    assert.equal(machineOf(`${MAC}.3e0cd024-62c3`), MAC);
    assert.equal(machineOf(MAC), MAC);
  });
});

describe("readUpdate", () => {
  it("shows the server's sentence, never one of its own", () => {
    assert.equal(readUpdate(output, heard())?.text, "the server's sentence");
  });

  it("offers Update now only with automatic updates off, and Try again only after a failure", () => {
    assert.deepEqual(
      ["off", "failed", "window", "live", "current"].map((w) => readUpdate(output, heard({ waitingOn: w as MachineUpdate["waitingOn"] }))?.action),
      ["Update now", "Try again", undefined, undefined, undefined],
    );
  });

  it("an update just asked for offers no button and no failure colour", () => {
    const r = readUpdate(output, heard({ waitingOn: undefined, state: "failed", reason: "Update asked for." }));
    assert.deepEqual([r?.badge, r?.tone, r?.action], ["Waiting", "info", undefined]);
  });

  it("names each state", () => {
    const badge = (over: Partial<MachineUpdate>) => readUpdate(output, heard(over))?.badge;
    assert.equal(badge({ waitingOn: "current" }), "Up to date");
    assert.equal(badge({ waitingOn: "current", state: "updated" }), "Updated");
    assert.equal(badge({ update: true, waitingOn: undefined }), "Updating");
    assert.equal(badge({ update: true, waitingOn: undefined, state: "no-session" }), "Waiting");
    assert.equal(badge({ update: true, waitingOn: undefined, state: "not-running" }), "Waiting");
    assert.equal(badge({ waitingOn: "live" }), "Waiting");
    assert.equal(badge({ update: true, waitingOn: undefined, state: "retrying" }), "Retrying");
    assert.equal(badge({ waitingOn: "off" }), "Behind");
    assert.equal(badge({ waitingOn: "failed" }), "Failed");
    assert.equal(readUpdate(output, heard({ state: "local-network" }))?.tone, "warn");
    assert.equal(readUpdate(output, heard({ waitingOn: "failed" }))?.tone, "danger");
  });

  describe("a helper that never checks", () => {
    const health = [{ deviceId: output.id } as OutputHealth];
    /** The server had listened `listened` ms when the listing arrived at `readAt`. */
    const listing = (listened: number | null, readAt = 0) => ({ updates: [], health, updatesListeningFor: listened, readAt });
    const GRACE = CHECK_INTERVAL_MS + 60_000;

    it("is told to run the installer once, when its Mac is reporting and the server has listened a whole check", () => {
      const r = readUpdate(output, listing(0), GRACE + 1);
      assert.match(r?.text ?? "", /Run the macOS installer once/);
      assert.equal(r?.action, undefined);
    });

    it("says nothing just after the server starts: every Mac is one it has not heard from yet", () => {
      assert.equal(readUpdate(output, listing(0), CHECK_INTERVAL_MS), null);
    });

    it("counts the time since the listing arrived, so a page left open gets the notice", () => {
      const data = listing(60_000, 1_000);
      assert.equal(readUpdate(output, data, 1_000 + GRACE - 60_000 - 1), null);
      assert.match(readUpdate(output, data, 1_000 + GRACE - 60_000)?.text ?? "", /Run the macOS installer once/);
    });

    it("never compares the browser's clock with the server's: a clock a year off changes nothing", () => {
      const YEAR = 365 * 24 * 3_600_000;
      // The server had listened a minute; this browser's clock is a year ahead, or a year behind.
      for (const skew of [YEAR, -YEAR]) {
        const readAt = Date.now() + skew;
        assert.equal(readUpdate(output, listing(60_000, readAt), readAt + 1_000), null, `skew ${skew}`);
        assert.match(readUpdate(output, listing(GRACE, readAt), readAt + 1_000)?.text ?? "", /installer once/, `skew ${skew}`);
      }
    });

    it("says nothing when the server never said how long it has listened", () => {
      assert.equal(readUpdate(output, listing(null), GRACE * 10), null);
    });

    it("says nothing for a Mac that is not reporting at all: its screen already reads offline", () => {
      assert.equal(readUpdate(output, { updates: [], health: [], updatesListeningFor: 0, readAt: 0 }, CHECK_INTERVAL_MS * 10), null);
    });

    it("says nothing for a screen that is not a helper output", () => {
      assert.equal(readUpdate({ id: "pi-1" }, { updates: [], health: [{ deviceId: "pi-1" } as OutputHealth], updatesListeningFor: 0, readAt: 0 }, CHECK_INTERVAL_MS * 10), null);
    });
  });
});
