// The cues manifest — what an integration that is not a browser reads.
//
// What is guarded, and why each is a bug rather than a nicety:
//
//  - AN UNAVAILABLE CUE IS STILL LISTED. Dropping a cue whose Companion button
//    has gone missing takes the entity out of Home Assistant, silently breaking
//    every automation that referred to it, and brings it back under a fresh
//    name when the button reappears. `available: false` is the whole point.
//  - THE VERSION GOES UP ON A RULE CHANGE. It is the only thing telling an
//    integration to re-read; frozen, a new cue never appears anywhere.
//  - THE NAME IS THE WORDS, NOT THE RULE'S NAME. `says` with the trailing "on"
//    taken off — "Projectors on" is a sentence, the switch is called Projectors
//    — falling back to the cue name humanised. A rule may be called "Rule 4".

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fsp from "node:fs/promises";

// stage-controller resolves the data directory at import.
process.env.STAGE_UTILITY_DATA = await fsp.mkdtemp(path.join(os.tmpdir(), "cue-manifest-"));

const { cueManifest, cueManifestDeps, manifestVersion, bumpManifestVersion } = await import(
  "./cue-manifest.js"
);
const { CALL_TRIGGER_ID } = await import("./cue-aliases.js");
const { fingerprintParams } = await import("./companion-fingerprint.js");
type Rule = import("../types/automation.js").Rule;

const NOW = "2026-09-09T14:00:00.000Z";

/** One call-by-name cue pressing a button at these coordinates. */
function cue(
  name: string,
  over: {
    says?: string;
    room?: string;
    params?: Record<string, string | number>;
    at?: { page: number; row: number; col: number };
    status?: "in-place" | "moved" | "missing";
  } = {},
): Rule {
  const at = over.at ?? { page: 1, row: 0, col: 1 };
  return {
    id: name,
    name: `Rule ${name}`,
    enabled: true,
    trigger: {
      id: CALL_TRIGGER_ID,
      params: {
        name,
        ...(over.says === undefined ? {} : { says: over.says }),
        ...(over.room === undefined ? {} : { room: over.room }),
        ...over.params,
      },
    },
    conditions: [],
    action: {
      id: "companion.press",
      params: fingerprintParams(
        { ...at, pageId: "p1", label: name, actionIds: [name] },
        over.status ?? "in-place",
        NOW,
      ),
    },
    cooldownSec: 0,
    oncePerService: false,
  };
}

let RULES: Rule[] = [];
let STATES: Record<
  string,
  { state: "on" | "off" | "unknown"; reason?: string; settling?: true; commanded?: "on" | "off" }
> = {};
let stateReads = 0;

beforeEach(() => {
  RULES = [];
  STATES = {};
  stateReads = 0;
  cueManifestDeps.rules = async () => RULES;
  cueManifestDeps.states = async () => {
    stateReads++;
    return { ok: true, checkedAt: NOW, states: STATES } as never;
  };
});

describe("the shape of the manifest", () => {
  test("a pair is a switch and a lone cue is a button", async () => {
    RULES = [
      cue("projectors_on", { says: "Projectors on", room: "Room A" }),
      cue("projectors_off", { says: "Projectors off", at: { page: 1, row: 0, col: 2 } }),
      cue("take_screens", { says: "Take screens", room: "Room A", at: { page: 1, row: 2, col: 3 } }),
    ];
    const m = await cueManifest();

    assert.deepEqual(
      m.switches.map((s) => `${s.id}|${s.name}|${s.room}|${s.on}|${s.off}|${s.toggle}|${s.state}|${s.available}`),
      ["projectors|Projectors|Room A|projectors_on|projectors_off|false|unknown|true"],
    );
    assert.deepEqual(
      m.buttons.map((b) => `${b.id}|${b.name}|${b.room}|${b.cue}|${b.available}`),
      ["take_screens|Take screens|Room A|take_screens|true"],
    );
    // A pair's two halves are NOT also buttons. A cue that is both is two
    // entities in Home Assistant fighting over one Companion key.
    assert.equal(
      m.buttons.some((b) => b.id.startsWith("projectors")),
      false,
    );
  });

  test("an orphaned pair half is neither a switch nor a button", async () => {
    // Deleting a pair one half at a time left the survivor exposed as a
    // momentary button for the moment between the two deletes, and Home
    // Assistant created and removed an entity for it. Half a switch is not
    // something anyone should be able to press from Home.
    RULES = [cue("projectors_off", { says: "Projectors off" })];
    const m = await cueManifest();
    assert.deepEqual(m.switches, []);
    assert.deepEqual(m.buttons.map((b) => b.id), []);
  });

  test("an unbound pair costs no Companion read at all", async () => {
    RULES = [cue("projectors_on"), cue("projectors_off", { at: { page: 1, row: 0, col: 2 } })];
    await cueManifest();
    assert.equal(String(stateReads), "0");
  });

  test("a bound pair carries its state, its reason and where it came from", async () => {
    RULES = [
      cue("projectors_on", { params: { stateVariable: "Projectors:powerState", stateOnValue: "On", stateOffValue: "Off" } }),
      cue("projectors_off", { at: { page: 1, row: 0, col: 2 } }),
    ];
    STATES = { projectors: { state: "unknown", reason: "no such variable in Companion" } };
    const m = await cueManifest();
    assert.equal(String(stateReads), "1");
    assert.equal(m.switches[0]?.state, "unknown");
    assert.equal(m.switches[0]?.reason, "no such variable in Companion");
    assert.equal(m.switches[0]?.stateSource, "Projectors:powerState");
  });

  test("a pair settling from a press carries what was commanded", async () => {
    // The reading lags the press by however long Companion takes to poll the
    // device, so an integration reading the manifest in that gap has to be able
    // to show the command instead. Without this it shows the pre-press value
    // and offers the user the same tap again.
    RULES = [
      cue("plug_on", { params: { stateVariable: "plug_state" } }),
      cue("plug_off", { at: { page: 1, row: 0, col: 2 } }),
    ];
    STATES = { plug: { state: "off", settling: true, commanded: "on" } };
    const settlingPair = (await cueManifest()).switches[0]!;
    assert.equal(settlingPair.settling, true);
    assert.equal(settlingPair.commanded, "on");
    // The reading itself is unchanged: the manifest does not pretend.
    assert.equal(settlingPair.state, "off");

    // And once the window closes the fields are gone, rather than left on
    // saying `false` or carrying the last command forever.
    STATES = { plug: { state: "on" } };
    const done = (await cueManifest()).switches[0]!;
    assert.equal(done.settling, undefined);
    assert.equal(done.commanded, undefined);
    assert.equal(Object.hasOwn(done, "settling"), false);
  });

  test("a toggle pair says so", async () => {
    // Both halves press ONE key, which is what a state variable is for.
    RULES = [
      cue("vcr_light_on", { params: { stateVariable: "VCR-Overhead-Light:power_state" } }),
      cue("vcr_light_off"),
    ];
    STATES = { vcr_light: { state: "on" } };
    const m = await cueManifest();
    assert.equal(String(m.switches[0]?.toggle), "true");
    assert.equal(m.switches[0]?.state, "on");
  });

  test("the server names itself, so an integration knows where to POST", async () => {
    const m = await cueManifest();
    assert.equal(typeof m.server.name, "string");
    assert.equal(m.server.name.length > 0, true);
    // Null until the server has worked out its LAN address.
    assert.equal(m.server.lanUrl === null || typeof m.server.lanUrl === "string", true);
  });
});

describe("a cue whose button has gone missing", () => {
  test("is listed, unavailable, rather than dropped", async () => {
    // Dropped, the Home Assistant entity disappears and every automation
    // referring to it breaks with nothing said anywhere.
    RULES = [
      cue("projectors_on", { status: "missing" }),
      cue("projectors_off", { at: { page: 1, row: 0, col: 2 } }),
      cue("take_screens", { status: "missing", at: { page: 1, row: 2, col: 3 } }),
    ];
    const m = await cueManifest();
    assert.deepEqual(
      m.switches.map((s) => `${s.id}=${s.available}`),
      ["projectors=false"],
    );
    assert.deepEqual(
      m.buttons.map((b) => `${b.id}=${b.available}`),
      ["take_screens=false"],
    );
  });

  test("one missing half makes the whole switch unavailable", async () => {
    // Half a switch is worse than none: turn_on works and turn_off does not.
    RULES = [
      cue("projectors_on"),
      cue("projectors_off", { status: "missing", at: { page: 1, row: 0, col: 2 } }),
    ];
    assert.equal(String((await cueManifest()).switches[0]?.available), "false");
  });
});

describe("the name a switch is called", () => {
  test("is the words, with a trailing `on` stripped", async () => {
    RULES = [
      cue("projectors_on", { says: "the big screens on" }),
      cue("projectors_off", { at: { page: 1, row: 0, col: 2 } }),
    ];
    assert.equal((await cueManifest()).switches[0]?.name, "the big screens");
  });

  test("falls back to the cue name humanised, never to the rule's name", async () => {
    // The rules here are called "Rule room_a_screens_projectors_on". A house
    // full of switches called "Rule 4" is worse than one called by its cue.
    RULES = [
      cue("room_a_screens_projectors_on"),
      cue("room_a_screens_projectors_off", { at: { page: 1, row: 0, col: 2 } }),
    ];
    assert.equal((await cueManifest()).switches[0]?.name, "Room A Screens Projectors");
  });
});

describe("the version", () => {
  test("goes up on a rule change, and the manifest carries the current one", async () => {
    const before = manifestVersion();
    assert.equal((await cueManifest()).version, before);
    const next = bumpManifestVersion();
    assert.equal(String(next > before), "true");
    assert.equal((await cueManifest()).version, next);
  });
});
