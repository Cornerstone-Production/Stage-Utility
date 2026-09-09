// Whose people a slot PREVIEW is resolved against.
//
// The slots editor's plan switcher moves the editor off the plan the screens are
// following, and the preview beside it follows. Three things can go wrong, and
// all three are quiet:
//
//  1. Previewing another week could resolve against the LIVE roster, so an
//     operator building next Sunday's board sees this Sunday's people in it and
//     has no way to tell.
//  2. Fetching another week's roster could ASSIGN it to the controller — which
//     is what every stage display resolves against, so opening a preview would
//     put next Sunday's names on the wall.
//  3. An unreadable roster could come back as an ordinary empty board, which
//     reads as "nobody is scheduled".
//
// Driven through the real controller against a real temp data dir. Only
// `pcoService.listTeamMembers` is stubbed: it is the network, and the point of
// the test is which arguments reach it and what is done with the answer.

import assert from "node:assert/strict";
import { describe, it, before, beforeEach, after } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-slot-preview-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { stageController } = await import("./stage-controller.js");
const { pcoService } = await import("./pco-service.js");

const TYPE = "st-preview";
const OTHER_TYPE = "st-preview-youth";
const LIVE_PLAN = "plan-live";
const NEXT_PLAN = "plan-next";

type Mutable = {
  state: Record<string, unknown>;
  broadcast: () => void;
  teamMembers: TeamMemberDTO[];
  teamMembersKey: string | null;
  pcoAppId: string | null;
  pcoSecret: string | null;
};
const ctl = stageController as unknown as Mutable;

function member(name: string, position: string): TeamMemberDTO {
  return {
    id: `m-${name}`,
    name,
    personId: `p-${name}`,
    photoUrl: null,
    teamPositionName: position,
    teamName: null,
    status: "C",
    notes: null,
  };
}

/** One PCO-linked row, so a roster has something to fill. */
function slot(id: string, position: string): Slot {
  return {
    id,
    channel: "01",
    order: 0,
    link: { kind: "pco", matchBy: "position", positions: [{ name: position }] },
    deviceBinding: null,
    displayName: null,
    photoUrl: null,
    device: { status: "none", rf: null, battery: null, freq: null, audioLevel: null, charge: null, iemCharge: null, label: null, iemLabel: null },
  } as unknown as Slot;
}

const BOARD = [slot("s1", "Vocals"), slot("s2", "Guitar")];

/** Every (serviceTypeId, planId) the stub was asked for. */
let asked: string[] = [];
/** What the stub does — hand back a roster, or throw like a 401 would. */
let answer: (serviceTypeId: string, planId: string) => TeamMemberDTO[] = () => [];

const realList = pcoService.listTeamMembers.bind(pcoService);
const warnings: string[] = [];
let realWarn: typeof console.warn;

before(() => {
  ctl.broadcast = () => {};
  realWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  (pcoService as unknown as { listTeamMembers: unknown }).listTeamMembers = async (
    _appId: string,
    _secret: string,
    serviceTypeId: string,
    planId: string,
  ) => {
    asked.push(`${serviceTypeId}:${planId}`);
    return answer(serviceTypeId, planId);
  };
});

after(async () => {
  console.warn = realWarn;
  (pcoService as unknown as { listTeamMembers: unknown }).listTeamMembers = realList;
  await fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

beforeEach(() => {
  ctl.state = {
    ...ctl.state,
    serviceTypeId: TYPE,
    serviceTypeName: "Sunday",
    planId: LIVE_PLAN,
  };
  ctl.teamMembers = [member("Live Person", "Vocals")];
  ctl.teamMembersKey = `${TYPE}:${LIVE_PLAN}`;
  ctl.pcoAppId = "app";
  ctl.pcoSecret = "secret";
  asked = [];
  warnings.length = 0;
  answer = () => [];
});

/** The display names the preview put in the board, "" for an unfilled row. */
const names = (slots: Slot[]) => slots.map((s) => s.displayName ?? "");

describe("resolveSlotsPreview", () => {
  it("with no target resolves against the live roster", async () => {
    const r = await stageController.resolveSlotsPreview(BOARD);
    assert.equal(r.roster, "live");
    assert.deepEqual(names(r.slots), ["Live Person", ""]);
    assert.deepEqual(asked, [], "the live roster is already in hand — a preview of it must not hit PCO");
  });

  it("with a target equal to the live plan resolves against the live roster", async () => {
    const r = await stageController.resolveSlotsPreview(BOARD, { serviceTypeId: TYPE, planId: LIVE_PLAN });
    assert.equal(r.roster, "live");
    assert.deepEqual(names(r.slots), ["Live Person", ""]);
    assert.deepEqual(asked, []);
  });

  it("another plan resolves against THAT plan's roster, not the live one", async () => {
    answer = () => [member("Next Person", "Vocals"), member("Second Person", "Guitar")];
    const r = await stageController.resolveSlotsPreview(BOARD, { serviceTypeId: TYPE, planId: NEXT_PLAN });
    assert.equal(r.roster, "plan");
    assert.deepEqual(asked, [`${TYPE}:${NEXT_PLAN}`]);
    assert.deepEqual(
      names(r.slots),
      ["Next Person", "Second Person"],
      "the live roster's names in another week's preview is the bug this whole change exists for",
    );
  });

  it("another SERVICE TYPE's plan is fetched for that type", async () => {
    answer = () => [member("Youth Person", "Vocals")];
    const r = await stageController.resolveSlotsPreview(BOARD, {
      serviceTypeId: OTHER_TYPE,
      planId: NEXT_PLAN,
    });
    assert.equal(r.roster, "plan");
    assert.deepEqual(asked, [`${OTHER_TYPE}:${NEXT_PLAN}`]);
  });

  it("leaves the roster the SCREENS resolve against untouched", async () => {
    answer = () => [member("Next Person", "Vocals")];
    await stageController.resolveSlotsPreview(BOARD, { serviceTypeId: TYPE, planId: NEXT_PLAN });
    assert.deepEqual(
      stageController.getTeamMembers().map((m) => m.name),
      ["Live Person"],
      "a preview that writes this.teamMembers puts another week's names on every stage display",
    );
    assert.equal(ctl.teamMembersKey, `${TYPE}:${LIVE_PLAN}`, "and the key must still name the live plan");
  });

  it("the DEFAULT side resolves against nobody, and asks PCO nothing", async () => {
    answer = () => [member("Nobody Asked", "Vocals")];
    const r = await stageController.resolveSlotsPreview(BOARD, { serviceTypeId: TYPE, planId: null });
    assert.equal(r.roster, "none");
    assert.deepEqual(names(r.slots), ["", ""], "a default board is every week — it has no roster to guess at");
    assert.deepEqual(asked, [], "there is no plan to fetch a roster for, so nothing may be guessed");
  });

  it("reports an unreadable roster rather than an empty one, and logs it", async () => {
    answer = () => {
      throw new Error("401 Unauthorized");
    };
    const r = await stageController.resolveSlotsPreview(BOARD, { serviceTypeId: TYPE, planId: NEXT_PLAN });
    assert.equal(r.roster, "unavailable");
    assert.match(String(r.reason), /401 Unauthorized/);
    assert.deepEqual(names(r.slots), ["", ""], "the rows are still worth drawing");
    assert.ok(
      warnings.some((l) => l.includes("[stage-controller] preview roster for") && l.includes("unavailable")),
      `an operator at 9am needs a tagged line; got ${JSON.stringify(warnings)}`,
    );
  });

  it("reports PCO not being configured the same way", async () => {
    ctl.pcoAppId = null;
    ctl.pcoSecret = null;
    const r = await stageController.resolveSlotsPreview(BOARD, { serviceTypeId: TYPE, planId: NEXT_PLAN });
    assert.equal(r.roster, "unavailable");
    assert.match(String(r.reason), /not configured/);
    assert.deepEqual(asked, [], "no credentials means no request");
  });

  it("never throws for a roster failure — the preview is not a save", async () => {
    answer = () => {
      throw new Error("getaddrinfo ENOTFOUND api.planningcenteronline.com");
    };
    await assert.doesNotReject(() =>
      stageController.resolveSlotsPreview(BOARD, { serviceTypeId: TYPE, planId: NEXT_PLAN }),
    );
  });

  it("resolves this rig's device state whatever week is previewed", async () => {
    // The rig is the rig: a preview of another week still draws the transmitters
    // in this building, because that is the only device state there is.
    const bound = [
      {
        ...slot("s1", "Vocals"),
        link: { kind: "static", label: "Pastor", color: null },
        deviceBinding: { channelId: "ch-preview" },
      } as unknown as Slot,
    ];
    (stageController as unknown as { deviceStatuses: Map<string, DeviceStatus> }).deviceStatuses.set(
      "ch-preview",
      {
        channelId: "ch-preview",
        name: "TX1",
        deviceType: "receiver",
        online: true,
        rfBars: 4,
        rfLevelDbm: -60,
        battery: 90,
        batteryMinutes: 300,
        charging: null,
        frequencyLabel: "500.000",
        audioLevel: -20,
        cycles: null,
        health: null,
        tempC: null,
        updatedAt: new Date().toISOString(),
      },
    );
    const r = await stageController.resolveSlotsPreview(bound, { serviceTypeId: TYPE, planId: null });
    assert.equal(r.slots[0].device.status, "ok");
    assert.equal(r.slots[0].device.battery, 90);
  });
});
