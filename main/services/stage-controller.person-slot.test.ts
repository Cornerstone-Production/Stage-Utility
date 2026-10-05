// A by-person slot shows its person whether or not they are on the plan.
//
// Driven through the real controller against a real temp data dir. Only
// `pcoService.getPerson` is stubbed: it is the network. What is pinned is that
// resolution asks for the unrostered person, that the answer reaches the slot and
// is broadcast, and that nothing is read without credentials.

import assert from "node:assert/strict";
import { describe, it, before, beforeEach, after } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-person-slot-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { stageController } = await import("./stage-controller.js");
const { pcoService } = await import("./pco-service.js");

type Mutable = {
  state: Record<string, unknown>;
  broadcast: () => void;
  teamMembers: TeamMemberDTO[];
  pcoAppId: string | null;
  pcoSecret: string | null;
  personDirectory: { reset: () => void };
};
const ctl = stageController as unknown as Mutable;

function personSlot(id: string, personId: string): Slot {
  return {
    id,
    channel: "01",
    order: 0,
    link: { kind: "pco", matchBy: "person", personId },
    deviceBinding: null,
    displayName: null,
    photoUrl: null,
    device: { status: "none", rf: null, battery: null, freq: null, audioLevel: null, charge: null, iemCharge: null, label: null, iemLabel: null },
  } as unknown as Slot;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
let asked: string[] = [];
let broadcasts = 0;
const realGet = pcoService.getPerson.bind(pcoService);

before(() => {
  ctl.broadcast = () => {
    broadcasts++;
  };
  (pcoService as unknown as { getPerson: unknown }).getPerson = async (_a: string, _s: string, id: string) => {
    asked.push(id);
    return id === "1630425" ? { name: "Nathan Bong", photoUrl: null } : null;
  };
});

after(async () => {
  (pcoService as unknown as { getPerson: unknown }).getPerson = realGet;
  await fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

beforeEach(() => {
  ctl.personDirectory.reset();
  ctl.teamMembers = [];
  ctl.pcoAppId = "app";
  ctl.pcoSecret = "secret";
  asked = [];
  broadcasts = 0;
});

describe("a by-person slot whose person is not on the plan", () => {
  it("is read from Planning Center, broadcast, and then shows the person", async () => {
    const board = [personSlot("s1", "AC1630425")];
    const first = await stageController.resolveSlotsPreview(board);
    assert.deepEqual(asked, ["1630425"], "the unrostered person was never read");
    assert.equal(first.slots[0]?.displayName ?? null, null);
    await tick();
    assert.ok(broadcasts > 0, "the person landed but nothing was broadcast");
    const second = await stageController.resolveSlotsPreview(board);
    assert.equal(second.slots[0]?.displayName, "Nathan Bong", "an unscheduled person never filled the slot");
    assert.deepEqual(asked, ["1630425"], "the person was read twice");
  });

  it("is not read without Planning Center credentials", async () => {
    ctl.pcoAppId = null;
    ctl.pcoSecret = null;
    await stageController.resolveSlotsPreview([personSlot("s1", "1630425")]);
    assert.deepEqual(asked, []);
  });

  it("is read again after the Planning Center credentials change", async () => {
    // setPcoCredentials also recomputes service windows, which is network; that is
    // not what this pins, so it is silenced.
    const refresh = (ctl as unknown as { refreshServiceWindows: unknown }).refreshServiceWindows;
    (ctl as unknown as { refreshServiceWindows: unknown }).refreshServiceWindows = async () => {};
    try {
      const board = [personSlot("s1", "1630425")];
      await stageController.resolveSlotsPreview(board);
      await tick();
      stageController.setPcoCredentials("other-app", "other-secret");
      await stageController.resolveSlotsPreview(board);
      assert.deepEqual(asked, ["1630425", "1630425"], "a person read under the old credentials was kept");
    } finally {
      (ctl as unknown as { refreshServiceWindows: unknown }).refreshServiceWindows = refresh;
    }
  });

  it("is not read when the roster already has them", async () => {
    ctl.teamMembers = [
      { id: "m1", name: "Nathan (roster)", personId: "1630425", photoUrl: null, teamPositionName: "Audio - MON (M1)", teamName: null, status: "C", notes: null },
    ];
    const r = await stageController.resolveSlotsPreview([personSlot("s1", "1630425")]);
    assert.equal(r.slots[0]?.displayName, "Nathan (roster)");
    assert.deepEqual(asked, []);
  });
});
