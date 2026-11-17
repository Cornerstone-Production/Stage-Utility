// A themed photo reaches a slot through the one place slots resolve.
//
// Driven through the REAL controller and the real photo themes service, wired
// the way server.ts wires them, against a real temp data dir and a fake OpenAI.
// Only the Planning Center roster read is stubbed: it is the network. What is
// under test is which photo a slot ends up with, for which plan, and that the
// URL a slot builds from it (`/photos?u=…`, as slot-panel.tsx builds it) serves
// the image.
//
// Not covered here: that a display then DRAWS it. slot-panel.tsx is unchanged
// and draws whatever /photos serves; a browser is what can show that, and jsdom
// loads no image.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-photo-themes-ctl-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { stageController } = await import("./stage-controller.js");
const { slotsStore } = await import("./slots-store.js");
const { pcoService } = await import("./pco-service.js");
const { photoThemes } = await import("./photo-themes/service.js");
const { proxyRoutes } = await import("./routes/proxy-routes.js");
const { callRoute } = await import("./routes/route-harness.js");
const { jpegBytes, pcoPhoto, startFakeOpenAi } = await import("./photo-themes/photo-themes-harness.js");
const { THEMED_PHOTO_REF_PREFIX } = await import("../types/photo-themes.js");

const VIEW = "v-wall";
const TYPE = "100";
const PLAN = "2001";
const OTHER_PLAN = "2002";

type Mutable = {
  state: Record<string, unknown>;
  broadcast: () => void;
  fetchTeamMembers: () => Promise<void>;
  loadAllViewRawSlots: (serviceTypeId: string | null, planId: string | null) => Promise<void>;
  teamMembers: TeamMemberDTO[];
  boards: Map<string, { name: string; columnWidthIn: number | null }>;
  pcoAppId: string | null;
  pcoSecret: string | null;
  currentPlanSortDate: string | null;
};
const ctl = stageController as unknown as Mutable;

const ALEX: TeamMemberDTO = {
  id: "tm-1",
  name: "Alex R.",
  personId: "1001",
  photoUrl: pcoPhoto("1001"),
  teamPositionName: "Vocals",
  teamName: "Band",
  status: "C",
  notes: null,
};

const ROW = {
  id: "s1",
  channel: "01",
  order: 0,
  link: { kind: "pco", matchBy: "position", positions: [{ name: "Vocals" }] },
  deviceBinding: null,
  displayName: null,
  photoUrl: null,
  device: { status: "none", rf: null, battery: null, freq: null, audioLevel: null, charge: null, iemCharge: null, label: null, iemLabel: null },
} as unknown as Slot;

let fake: Awaited<ReturnType<typeof startFakeOpenAi>>;

/** The photo the screens' wall draws for Alex now. */
const wallPhoto = () => (stageController.getState() as unknown as { slotsByView: Record<string, Slot[]> }).slotsByView[VIEW]![0]!.photoUrl;
/** The photo a preview of `planId` (null: the type's default) draws for Alex. */
const previewPhoto = async (planId: string | null) =>
  (await stageController.resolveSlotsPreview([ROW], { serviceTypeId: TYPE, planId })).slots[0]!.photoUrl;

before(async () => {
  fake = await startFakeOpenAi();
  process.env.STAGE_UTILITY_OPENAI_BASE_URL = fake.base;
  ctl.broadcast = () => {};
  ctl.fetchTeamMembers = async () => {};
  ctl.pcoAppId = "app";
  ctl.pcoSecret = "secret";
  ctl.currentPlanSortDate = "2026-12-24T16:00:00Z";
  // Every plan's roster has Alex on it.
  (pcoService as unknown as { listTeamMembers: () => Promise<TeamMemberDTO[]> }).listTeamMembers = async () => [ALEX];
  ctl.state = {
    ...ctl.state,
    serviceTypeId: TYPE,
    planId: PLAN,
    views: [{ id: VIEW, name: "Wall", kind: "slots", ndiSource: null, createdAt: "", surface: "display" }],
    outputs: [{ id: "out-1", name: "Stage", viewId: VIEW }],
  };
  ctl.boards = new Map([[VIEW, { name: "Wall", columnWidthIn: null }]]);
  ctl.teamMembers = [ALEX];
  await slotsStore.setDefault(VIEW, TYPE, [ROW]);
  await ctl.loadAllViewRawSlots(TYPE, PLAN);

  // As server.ts wires them.
  const original = await jpegBytes();
  stageController.setThemedPhotoSource((planId) => photoThemes.shownPhotos(planId));
  await photoThemes.start(
    {
      planPeople: (serviceTypeId, planId) => stageController.planPeople(serviceTypeId, planId),
      currentPhotoOf: (personId) => stageController.currentPhotoOf(personId),
      currentPlanSortDate: (planId) => stageController.currentPlanSortDateFor(planId),
      onShownChanged: () => stageController.refreshThemedPhotos(),
      loadOriginal: async () => original,
    },
    { sweep: false },
  );
  await photoThemes.connection.saveKey("sk-proj-0123456789abcdefghijklmn");
});

after(async () => {
  photoThemes.stop();
  await fake.close();
  delete process.env.STAGE_UTILITY_OPENAI_BASE_URL;
});

describe("a themed photo on the wall", () => {
  let ref = "";

  it("finds the people a plan's boards put in a slot", async () => {
    const read = await stageController.planPeople(TYPE, PLAN);
    assert.equal(read.roster, "live");
    assert.deepEqual(read.people, [{ personId: "1001", name: "Alex R.", photoUrl: pcoPhoto("1001") }]);
    assert.equal((await stageController.planPeople(TYPE, OTHER_PLAN)).roster, "plan");
  });

  it("is not drawn until it is approved", async () => {
    const theme = await photoThemes.createTheme({ name: "Christmas 2026", prompt: "Warm lights" });
    await photoThemes.choosePlan(PLAN, { serviceTypeId: TYPE, sortDate: undefined, themeId: theme.id });
    assert.equal(photoThemes.state().plans[0]!.sortDate, "2026-12-24T16:00:00Z", "the current plan's date filled in");
    assert.equal((await photoThemes.generate(PLAN, TYPE, "missing")).queued, 1);
    await photoThemes.idle();
    assert.equal(photoThemes.state().themes[0]!.people[0]!.status, "ready");
    assert.ok(wallPhoto()?.startsWith("https://avatars.planningcenteronline.com/"), "a ready photo is not drawn");

    await photoThemes.approve(theme.id, "1001");
    ref = wallPhoto()!;
    assert.match(ref, new RegExp(`^${THEMED_PHOTO_REF_PREFIX}[0-9a-f]{16}\\.webp$`), "the wall redrew with the approved photo");
    assert.equal(await previewPhoto(PLAN), ref, "the editor's preview of this plan shows it too");
  });

  it("is served at the URL a slot builds from it", async () => {
    const r = await callRoute(proxyRoutes, `/photos?u=${encodeURIComponent(ref)}&s=256`);
    assert.equal(r.status, 200);
    assert.equal(r.headers["Content-Type"], "image/webp");
    assert.match(r.headers["Cache-Control"]!, /immutable/);
    assert.match(r.headers["Content-Security-Policy"]!, /sandbox/);
    for (const bad of ["photo-theme:../secrets.bin", "photo-theme:0123456789abcdef.webp"]) {
      assert.equal((await callRoute(proxyRoutes, `/photos?u=${encodeURIComponent(bad)}`)).status, 404, bad);
    }
  });

  it("is not drawn for another plan, or a type's default board", async () => {
    assert.ok((await previewPhoto(OTHER_PLAN))?.startsWith("https://avatars.planningcenteronline.com/"));
    assert.ok((await previewPhoto(null)) === null || !(await previewPhoto(null))?.startsWith(THEMED_PHOTO_REF_PREFIX));
  });

  it("goes back to the original when the plan is switched to Original, and returns on Themed", async () => {
    await photoThemes.choosePlan(PLAN, { serviceTypeId: TYPE, sortDate: undefined, show: "original" });
    assert.ok(wallPhoto()?.startsWith("https://avatars.planningcenteronline.com/"));
    await photoThemes.choosePlan(PLAN, { serviceTypeId: TYPE, sortDate: undefined, show: "themed" });
    assert.equal(wallPhoto(), ref);
  });
});
