// Prep tags reach a resolved slot through the real controller.
//
// The resolver's own tests pin what it does with a prep map. What is pinned here
// is the wiring, which `resolveSlots` defaulting its argument would let a deletion
// slip past the compiler:
//
//   - fetchTeamMembers reads the tags (and does not wait on them before the roster)
//   - the roster tick re-resolves when ONLY the tags changed, and says so
//   - a credential change forgets what the old credentials read
//
// Only `pcoService.listPersonPrepTags` and `listTeamMembers` are stubbed: they are
// the network.

import assert from "node:assert/strict";
import { describe, it, after, beforeEach, afterEach } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-prep-tags-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { stageController } = await import("./stage-controller.js");
const { pcoService } = await import("./pco-service.js");
const { serviceWindow, DEFAULT_RECONNECT_SCHEDULE } = await import("./service-window.js");

type Internals = {
  state: Record<string, unknown>;
  broadcast: () => void;
  teamMembers: TeamMemberDTO[];
  teamMembersKey: string | null;
  pcoAppId: string | null;
  pcoSecret: string | null;
  prepTags: { map: ReadonlyMap<string, unknown>; reset: () => void };
  fetchTeamMembers: (serviceTypeId: string, planId: string, opts?: { fresh?: boolean }) => Promise<void>;
  rosterRefreshTick: () => Promise<void>;
};
const ctl = stageController as unknown as Internals;
const svc = pcoService as unknown as { listPersonPrepTags: unknown; listTeamMembers: unknown };
const realTags = svc.listPersonPrepTags;
const realRoster = svc.listTeamMembers;
const realBroadcast = ctl.broadcast;

const MIN = 60_000;
const JORDAN: TeamMemberDTO = {
  id: "m1", name: "Jordan Lee", personId: "100000007", photoUrl: null,
  teamPositionName: "Vocals", teamName: "Band", status: "C", notes: null,
};

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

/** What the stubbed tag read returns next, and how often it was asked. */
let tags: { tagName: string; personIds: string[] }[] = [];
let tagCalls = 0;
let broadcasts = 0;

async function logged(fn: () => Promise<void>): Promise<string[]> {
  const out: string[] = [];
  const saved = console.log;
  console.log = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.log = saved;
  }
  return out;
}

beforeEach(() => {
  tags = [
    { tagName: "Capsule: KSM9", personIds: ["100000007"] },
    { tagName: "IEMs: Own", personIds: ["100000007"] },
  ];
  tagCalls = 0;
  broadcasts = 0;
  ctl.broadcast = () => void broadcasts++;
  ctl.state = { ...ctl.state, pcoConfigured: true, serviceTypeId: "1001", planId: "2001" };
  ctl.pcoAppId = "app";
  ctl.pcoSecret = "secret";
  ctl.teamMembers = [];
  ctl.teamMembersKey = null;
  ctl.prepTags.reset();
  svc.listPersonPrepTags = async () => {
    tagCalls++;
    return tags;
  };
  svc.listTeamMembers = async () => [JORDAN];
});

afterEach(() => {
  svc.listPersonPrepTags = realTags;
  svc.listTeamMembers = realRoster;
  ctl.broadcast = realBroadcast;
  serviceWindow.setWindows([]);
  serviceWindow.setSchedule({ ...DEFAULT_RECONNECT_SCHEDULE });
});

after(async () => {
  await fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

async function resolvedPrep(): Promise<unknown> {
  const { slots } = await stageController.resolveSlotsPreview([vocalsSlot()]);
  assert.equal(slots[0]?.displayName, "Jordan Lee");
  return slots[0]?.prep;
}

describe("prep tags through fetchTeamMembers", () => {
  it("reach the slot filled by the tagged person", async () => {
    await ctl.fetchTeamMembers("1001", "2001");
    assert.deepEqual(await resolvedPrep(), { capsule: "KSM9", ownIems: true });
  });

  it("do not hold the roster up: both reads start before either is awaited", async () => {
    let releaseTags!: () => void;
    const held = new Promise<void>((resolve) => (releaseTags = resolve));
    let rosterAsked = false;
    svc.listPersonPrepTags = async () => {
      await held;
      return tags;
    };
    svc.listTeamMembers = async () => {
      rosterAsked = true;
      return [JORDAN];
    };
    const done = ctl.fetchTeamMembers("1001", "2001");
    try {
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
      assert.equal(rosterAsked, true, "the roster read must not wait for the tag read");
    } finally {
      releaseTags();
      await done;
    }
    assert.deepEqual(await resolvedPrep(), { capsule: "KSM9", ownIems: true });
  });

  it("never fail the roster: a tag read that throws leaves the roster and no prep", async () => {
    svc.listPersonPrepTags = async () => {
      throw new Error("tags down");
    };
    const saved = console.error;
    console.error = () => {};
    try {
      await ctl.fetchTeamMembers("1001", "2001");
    } finally {
      console.error = saved;
    }
    assert.equal(ctl.teamMembers.length, 1);
    assert.equal(await resolvedPrep(), undefined);
  });
});

describe("prep tags through the roster tick", () => {
  function inWindow(): void {
    const now = Date.now();
    serviceWindow.setSchedule({ ...DEFAULT_RECONNECT_SCHEDULE });
    serviceWindow.setWindows([{ open: now - 30 * MIN, close: now + 240 * MIN }]);
  }

  it("re-resolves and broadcasts when only the tags changed, and says so", async () => {
    inWindow();
    await ctl.rosterRefreshTick(); // first tick: roster and tags both new
    const afterFirst = broadcasts;
    tags = [{ tagName: "Capsule: B58a", personIds: ["100000007"] }]; // same roster, new capsule
    const out = await logged(() => ctl.rosterRefreshTick());
    assert.equal(broadcasts, afterFirst + 1, "a capsule change alone must reach the displays");
    assert.ok(out.some((l) => l.includes("prep tags changed mid-window")), out.join("\n"));
    assert.ok(!out.some((l) => l.includes("roster changed")), out.join("\n"));
    assert.deepEqual(await resolvedPrep(), { capsule: "B58a", ownIems: false });
  });

  it("stays quiet when neither the roster nor the tags changed", async () => {
    inWindow();
    await ctl.rosterRefreshTick();
    const afterFirst = broadcasts;
    await ctl.rosterRefreshTick();
    assert.equal(broadcasts, afterFirst);
  });
});

describe("prep tags through a credential change", () => {
  it("are forgotten, and read again under the new credentials", async () => {
    await ctl.fetchTeamMembers("1001", "2001");
    assert.equal(ctl.prepTags.map.size, 1);
    stageController.setPcoCredentials(null, null);
    assert.equal(ctl.prepTags.map.size, 0, "tags read under the old credentials must not outlive them");
    ctl.pcoAppId = "app2";
    ctl.pcoSecret = "secret2";
    await ctl.fetchTeamMembers("1001", "2001");
    assert.equal(tagCalls, 2, "the new credentials get their own read");
    assert.equal(ctl.prepTags.map.size, 1);
  });
});
