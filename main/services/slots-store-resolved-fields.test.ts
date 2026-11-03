// A resolved slot sent back to be saved must not carry its resolved fields onto disk.
//
// resolveSlots fills in displayName, photoUrl, shownPositions, prep and device. The
// slots editor seeds a new board from the resolved rows it was sent and saves them
// verbatim, so those fields used to be written to slots.json (and into
// arrangements) as last Sunday's names and this minute's battery readings.
//
// Everything here runs the REAL store and the REAL controller against a temp data
// dir and reads the bytes on disk, so a write path that skips the strip fails here.

import assert from "node:assert/strict";
import { describe, it, before, after, beforeEach } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-slots-resolved-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { stageController } = await import("./stage-controller.js");
const { slotsStore } = await import("./slots-store.js");

const VIEW = "v-slots";
const TYPE = "st-main";
const PLAN = "plan-a";

type Mutable = {
  state: Record<string, unknown>;
  broadcast: () => void;
  loadAllViewRawSlots: (serviceTypeId: string | null, planId: string | null) => Promise<void>;
  rawSlotsByBoard: Map<string, Slot[]>;
};
const ctl = stageController as unknown as Mutable;

/** What an editor sends back: a slot exactly as the resolver returned it. */
function resolvedSlot(id: string): Slot {
  return {
    id,
    channel: "07",
    order: 0,
    link: { kind: "pco", matchBy: "position", positions: [{ name: "Vocals" }] },
    deviceBinding: { providerId: "p1", channelId: "c1" },
    deviceLabel: "Handheld 3",
    displayName: "Jordan Lee",
    photoUrl: "/api/photo/100000007",
    shownPositions: ["Vocals"],
    prep: { capsule: "KSM9", ownIems: true },
    device: { status: "online", rf: 4, battery: 80, freq: 584.1, audioLevel: -20, charge: 80, iemCharge: 55, label: "Handheld 3", iemLabel: null },
  } as unknown as Slot;
}

/** Every resolved-only value, as it would appear in the file's text. */
const LEAKS = [/Jordan Lee/, /\/api\/photo\/100000007/, /KSM9/, /shownPositions/, /"prep"/, /584\.1/, /"audioLevel":\s*-20/, /"battery":\s*80/];

async function bytes(file: string): Promise<string> {
  return fs.readFile(path.join(TMP, file), "utf-8");
}

function assertClean(text: string, where: string): void {
  for (const leak of LEAKS) assert.ok(!leak.test(text), `${where}: ${leak} was written to disk`);
  // What an operator authored survives.
  assert.ok(text.includes("Handheld 3"), `${where}: the authored device label was lost`);
  assert.ok(/"channelId":\s*"c1"/.test(text), `${where}: the device binding was lost`);
  assert.ok(text.includes("Vocals"), `${where}: the position link was lost`);
}

before(() => {
  ctl.broadcast = () => {};
});

after(() => {
  fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

beforeEach(async () => {
  ctl.state = {
    ...ctl.state,
    serviceTypeId: TYPE,
    planId: PLAN,
    views: [{ id: VIEW, name: "Mic Slots", kind: "slots", ndiSource: null, createdAt: "", surface: "display" }],
    outputs: [],
  };
  await slotsStore.setDefault(VIEW, TYPE, []);
  await ctl.loadAllViewRawSlots(TYPE, PLAN);
});

describe("slots.json holds only what an operator authored", () => {
  it("slotsStore.setDefault", async () => {
    await slotsStore.setDefault(VIEW, TYPE, [resolvedSlot("a")]);
    assertClean(await bytes("slots.json"), "setDefault");
  });

  it("slotsStore.setOverride", async () => {
    await slotsStore.setOverride(VIEW, PLAN, TYPE, [resolvedSlot("a")], null);
    assertClean(await bytes("slots.json"), "setOverride");
  });

  it("a view save to the default board, a plan board, and the legacy POST /api/slots path", async () => {
    await stageController.setViewSlots(VIEW, [resolvedSlot("a")], { kind: "default", serviceTypeId: TYPE });
    assertClean(await bytes("slots.json"), "setViewSlots default");
    await stageController.setViewSlots(VIEW, [resolvedSlot("b")], { kind: "plan", planId: PLAN, serviceTypeId: TYPE });
    assertClean(await bytes("slots.json"), "setViewSlots plan");
    await stageController.setSlots(VIEW, [resolvedSlot("c")]);
    assertClean(await bytes("slots.json"), "setSlots");
  });

  it("a save with no service type, which is held in memory only, is stripped too", async () => {
    ctl.state = { ...ctl.state, serviceTypeId: null, planId: null };
    await stageController.setViewSlots(VIEW, [resolvedSlot("a")]);
    const held = ctl.rawSlotsByBoard.get(VIEW)![0] as unknown as Record<string, unknown>;
    assert.equal(held.displayName, null);
    assert.equal("prep" in held, false);
  });

  it("an arrangement saved, overwritten or imported", async () => {
    const imported = await stageController.importPreset("Imported", [resolvedSlot("a")]);
    assertClean(await bytes("presets.json"), "importPreset");

    // A slots.json written by an older build still holds resolved fields, and is
    // what a save-as-arrangement snapshots until the board is next saved.
    ctl.rawSlotsByBoard.set(VIEW, [resolvedSlot("b")]);
    const saved = await stageController.savePreset(VIEW, "Saved");
    assertClean(await bytes("presets.json"), "savePreset");

    await stageController.overwritePreset(imported.at(-1)!.id, "", [resolvedSlot("c")]);
    assertClean(await bytes("presets.json"), "overwritePreset");
    assert.ok(saved.length >= 1);
  });
});
