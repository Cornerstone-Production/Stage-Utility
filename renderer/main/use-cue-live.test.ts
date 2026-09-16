// The pure half of the cue-live hook: folding one pushed event into the live
// picture, and finding the manifest entry a button is bound to.
//
// Pure on purpose. The effect half — the manifest read, the subscription, the
// re-read on a manifest event — is driven in cue-button.test.tsx through the
// rendered component and on a real server; what is worth a unit test here is the
// arithmetic a wrong answer would show as a lamp lit for the wrong reason.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { applyCueEvent, cueEntry, type CuesLive } from "./use-cue-live.js";

const base: CuesLive = {
  manifest: {
    version: 3,
    server: { name: "t", lanUrl: null },
    switches: [
      {
        id: "haze",
        name: "Haze",
        room: "",
        on: "haze_on",
        off: "haze_off",
        toggle: false,
        state: "off",
        available: true,
      },
    ],
    buttons: [{ id: "confetti", name: "Confetti", room: "", cue: "confetti", available: true }],
  },
  states: new Map(),
};

describe("cue live state", () => {
  test("a state event lands on its pair and nothing else", () => {
    const next = applyCueEvent(base, { type: "state", id: "haze", state: "on" });
    assert.deepEqual(next.states.get("haze"), { state: "on" });
    assert.equal(base.states.size, 0, "input not mutated");
  });

  test("a settling event carries what was asked for", () => {
    const next = applyCueEvent(base, {
      type: "state",
      id: "haze",
      state: "off",
      settling: true,
      commanded: "on",
    });
    assert.deepEqual(next.states.get("haze"), { state: "off", settling: true, commanded: "on" });
  });

  test("a settling window that closes clears what was commanded", () => {
    // Left on, a button says "Turning on…" for the rest of the service after a
    // press the device never applied.
    const settling = applyCueEvent(base, {
      type: "state",
      id: "haze",
      state: "off",
      settling: true,
      commanded: "on",
    });
    const done = applyCueEvent(settling, { type: "state", id: "haze", state: "off" });
    assert.deepEqual(done.states.get("haze"), { state: "off" });
  });

  test("a manifest event with a new version marks the manifest stale", () => {
    const next = applyCueEvent(base, { type: "manifest", version: 4 });
    assert.equal(
      next.manifest.version,
      3,
      "the manifest itself is re-read by the hook, not invented here",
    );
    assert.equal(next.staleManifest, true);
  });

  test("a manifest event for the version already held changes nothing", () => {
    assert.equal(applyCueEvent(base, { type: "manifest", version: 3 }), base);
  });

  test("cueEntry finds a switch by base and a button by name", () => {
    assert.equal(cueEntry(base, "haze")?.kind, "switch");
    assert.equal(cueEntry(base, "confetti")?.kind, "button");
    assert.equal(cueEntry(base, "nothing"), null);
    assert.equal(cueEntry(null, "haze"), null);
    assert.equal(cueEntry(base, ""), null);
  });
});
