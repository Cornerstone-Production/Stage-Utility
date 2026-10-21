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
const heard = (over: Partial<MachineUpdate> = {}) => ({ updates: [{ ...base, ...over }], health: [], updatesListeningSince: 0 });

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

    it("is told to run the installer once, when its Mac is reporting and the server has listened a whole check", () => {
      const r = readUpdate(output, { updates: [], health, updatesListeningSince: 0 }, CHECK_INTERVAL_MS + 61_000);
      assert.match(r?.text ?? "", /Run the macOS installer once/);
      assert.equal(r?.action, undefined);
    });

    it("says nothing just after the server starts: every Mac is one it has not heard from yet", () => {
      assert.equal(readUpdate(output, { updates: [], health, updatesListeningSince: 0 }, CHECK_INTERVAL_MS), null);
    });

    it("says nothing for a Mac that is not reporting at all: its screen already reads offline", () => {
      assert.equal(readUpdate(output, { updates: [], health: [], updatesListeningSince: 0 }, CHECK_INTERVAL_MS * 10), null);
    });

    it("says nothing for a screen that is not a helper output", () => {
      assert.equal(readUpdate({ id: "pi-1" }, { updates: [], health: [{ deviceId: "pi-1" } as OutputHealth], updatesListeningSince: 0 }, CHECK_INTERVAL_MS * 10), null);
    });
  });
});
