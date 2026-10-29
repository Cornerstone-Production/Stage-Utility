// Prep tags reach a resolved slot through the real controller.
//
// The resolver's own tests pin what it does with a prep map. What is pinned here
// is the wiring: that the controller hands its map to the resolver. `resolveSlots`
// defaults the argument, so dropping it still compiles. Only
// `pcoService.listPersonPrepTags` is stubbed: it is the network.

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-prep-tags-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { stageController } = await import("./stage-controller.js");
const { pcoService } = await import("./pco-service.js");

type Mutable = {
  broadcast: () => void;
  teamMembers: TeamMemberDTO[];
  pcoAppId: string | null;
  pcoSecret: string | null;
  prepTags: { refresh: () => Promise<unknown> };
};
const ctl = stageController as unknown as Mutable;
const realList = pcoService.listPersonPrepTags.bind(pcoService);

function vocalsSlot(): Slot {
  return {
    id: "s1",
    channel: "01",
    order: 0,
    link: { kind: "pco", matchBy: "position", positions: [{ name: "Vocals" }] },
    deviceBinding: null,
    device: { status: "none", rf: null, battery: null, freq: null, audioLevel: null, charge: null, iemCharge: null, label: null, iemLabel: null },
  } as unknown as Slot;
}

before(() => {
  ctl.broadcast = () => {};
  (pcoService as unknown as { listPersonPrepTags: unknown }).listPersonPrepTags = async () => [
    { tagName: "Capsule: KSM9", personIds: ["100000007"] },
    { tagName: "IEMs: Own", personIds: ["100000007"] },
  ];
});

after(async () => {
  (pcoService as unknown as { listPersonPrepTags: unknown }).listPersonPrepTags = realList;
  await fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

describe("prep tags through the controller", () => {
  it("reach the slot filled by the tagged person", async () => {
    ctl.pcoAppId = "app";
    ctl.pcoSecret = "secret";
    ctl.teamMembers = [
      { id: "m1", name: "Jordan Lee", personId: "100000007", photoUrl: null, teamPositionName: "Vocals", teamName: "Band", status: "C", notes: null },
    ];
    await ctl.prepTags.refresh();
    const { slots } = await stageController.resolveSlotsPreview([vocalsSlot()]);
    assert.equal(slots[0]?.displayName, "Jordan Lee");
    assert.deepEqual(slots[0]?.prep, { capsule: "KSM9", ownIems: true });
  });
});
