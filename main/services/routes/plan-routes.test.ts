// The plan export routes, driven through the real handler.
//
// The route harness hands the handler a fake request and response, so what is
// asserted is what a client would have received — status, headers and body — with
// no socket and no Planning Center. The service type list is the only thing
// stubbed, because the export needs a NAME for the file and that is the one
// thing this server cannot answer offline.

import assert from "node:assert/strict";
import { describe, test, beforeEach } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "su-plan-routes-"));
process.env.STAGE_UTILITY_DATA = dir;

const { callRoute } = await import("./route-harness.js");
const { setAppTimeZone } = await import("../app-timezone.js");
const { viewsStore } = await import("../views-store.js");
const { slotsStore } = await import("../slots-store.js");
const { presetsStore } = await import("../presets-store.js");
const { patchStore } = await import("../patch-store.js");
const pcoService = (await import("../pco-service.js")).pcoService as unknown as Record<string, unknown>;
const { stageController } = await import("../stage-controller.js");
const { planRoutes, planExportFilename } = await import("./plan-routes.js");
const { viewRoutes } = await import("./view-routes.js");

// The route reaches the controller, which reaches PCO. Replaced at the PCO
// client so everything between it and the route is the production path.
pcoService.listServiceTypes = async () => [{ id: "st-1", name: "Sunday AM" }, { id: "st-2", name: "Youth" }];
(stageController as unknown as Record<string, unknown>).pcoAppId = "app";
(stageController as unknown as Record<string, unknown>).pcoSecret = "secret";

const row = (id: string) => ({ id, label: id, link: { kind: "static" as const } });

beforeEach(async () => {
  await viewsStore.save([{ id: "view-1", name: "Mic Board", kind: "slots", createdAt: 0, layout: null }] as never);
  await slotsStore.setDefault("view-1", "st-1", [row("a"), row("b")] as never);
  await presetsStore.save([{ id: "p1", name: "Five piece", slots: [], createdAt: "" }] as never);
  await patchStore.save({
    sheets: [{
      id: "analog", name: "Analog", kind: "analog", devices: [], endpoints: [],
      variants: [{ id: "var-1", name: "Sunday rig", overrides: {} }],
      assignments: { byServiceType: { "st-1": "var-1" }, byPlan: {} },
    }],
    updatedAt: "",
  } as never);
});

describe("GET /api/plans/export/preview", () => {
  test("counts what the file would carry", async () => {
    const r = await callRoute(planRoutes, "/api/plans/export/preview?serviceTypeId=st-1");
    assert.equal(r.status, 200);
    const p = r.json as Record<string, unknown>;
    assert.equal(p.serviceTypeName, "Sunday AM");
    assert.equal(p.views, 1);
    assert.equal(p.boards, 1);
    assert.equal(p.rows, 2);
    assert.equal(p.presets, 1);
    assert.deepEqual(p.patchVariants, [{ sheetName: "Analog", variantName: "Sunday rig" }]);
  });

  test("counts the other scope when the query asks for it", async (t) => {
    // The dialog's segmented control sends this. Ignored, the counts described
    // a smaller file than the Download link beside them points at.
    //
    // The board is removed again afterwards: slots.json outlives a test, and a
    // stray st-2 board left here makes the "nothing to export for Youth" test
    // below pass a 200. beforeEach puts view-1's st-1 board back.
    t.after(() => slotsStore.removeDisplay("view-1"));
    await slotsStore.setDefault("view-1", "st-2", [row("c")] as never);
    const type = await callRoute(planRoutes, "/api/plans/export/preview?serviceTypeId=st-1&slots=type");
    const all = await callRoute(planRoutes, "/api/plans/export/preview?serviceTypeId=st-1&slots=all");
    assert.equal((type.json as { boards: number }).boards, 1);
    assert.equal((all.json as { boards: number }).boards, 2, "the preview ignored slots=all");
  });

  test("a slots scope the server does not know is a 400 here too", async () => {
    const r = await callRoute(planRoutes, "/api/plans/export/preview?serviceTypeId=st-1&slots=some");
    assert.equal(r.status, 400);
    assert.match(String((r.json as { error?: string })?.error), /slots must be/);
  });

  test("no service type at all is a 400 that says so", async () => {
    const r = await callRoute(planRoutes, "/api/plans/export/preview");
    assert.equal(r.status, 400);
    assert.match(String((r.json as { error?: string })?.error), /serviceTypeId is required/);
  });

  test("an unknown service type is a 400, not a 500", async () => {
    const r = await callRoute(planRoutes, "/api/plans/export/preview?serviceTypeId=st-nope");
    assert.equal(r.status, 400);
    assert.match(String((r.json as { error?: string })?.error), /unknown service type/);
  });

  test("a type with nothing on it is a 400 naming the type", async () => {
    const r = await callRoute(planRoutes, "/api/plans/export/preview?serviceTypeId=st-2");
    assert.equal(r.status, 400);
    assert.match(String((r.json as { error?: string })?.error), /nothing to export for Youth/);
  });
});

describe("GET /api/plans/export", () => {
  test("downloads the bundle as an attachment, named for the type and the day", async () => {
    const r = await callRoute(planRoutes, "/api/plans/export?serviceTypeId=st-1");
    assert.equal(r.status, 200);
    assert.match(r.headers["content-disposition"] ?? "", /^attachment; filename="sunday-am-\d{4}-\d{2}-\d{2}\.stage-plan\.json"$/);
    assert.equal(r.headers["cache-control"], "no-store");
    const b = r.json as Record<string, unknown>;
    assert.equal((b.plan as Record<string, unknown>).serviceTypeId, "st-1");
    assert.deepEqual(b.roots, ["view-1"]);
  });

  test("the checklist is the query, and off means absent", async () => {
    const on = await callRoute(planRoutes, "/api/plans/export?serviceTypeId=st-1&patch=1&presets=1");
    const side = (r: typeof on) => (r.json as { sideData: Record<string, unknown> }).sideData;
    assert.equal((side(on).patchVariants as unknown[]).length, 1);
    assert.equal((side(on).presets as unknown[]).length, 1);

    const off = await callRoute(planRoutes, "/api/plans/export?serviceTypeId=st-1&patch=0&presets=0");
    assert.equal(side(off).patchVariants, undefined);
    assert.equal(side(off).presets, undefined);
  });

  test("presets are off unless asked for", async () => {
    // They are global, not this type's, so they travel by choice.
    const r = await callRoute(planRoutes, "/api/plans/export?serviceTypeId=st-1");
    assert.equal((r.json as { sideData: Record<string, unknown> }).sideData.presets, undefined);
  });

  test("a slots scope the server does not know is a 400, not a silent default", async () => {
    const r = await callRoute(planRoutes, "/api/plans/export?serviceTypeId=st-1&slots=some");
    assert.equal(r.status, 400);
    assert.match(String((r.json as { error?: string })?.error), /slots must be/);
  });

  test("a checklist flag that is not 1 or 0 is a 400", async () => {
    // Falling back to a default would ship a section the operator did not ask
    // for, or drop one they did.
    const r = await callRoute(planRoutes, "/api/plans/export?serviceTypeId=st-1&patch=maybe");
    assert.equal(r.status, 400);
    assert.match(String((r.json as { error?: string })?.error), /1 or 0/);
  });
});

describe("the download filename", () => {
  test("is the service type, slugged, and the date", () => {
    assert.equal(planExportFilename("Sunday AM", new Date("2026-09-08T12:00:00Z")), "sunday-am-2026-09-08.stage-plan.json");
  });

  test("cannot break out of the quoted header value", () => {
    const out = planExportFilename('Youth / "Live"', new Date("2026-09-08T12:00:00Z"));
    assert.ok(!out.includes("/"), `slug contains a separator: ${out}`);
    assert.ok(!out.includes('"'), `slug contains a quote: ${out}`);
  });

  test("is dated in the app's zone, not the box's clock", (t) => {
    // 04:30Z on the 5th is 23:30 on the 4th in Chicago. Prod runs UTC.
    setAppTimeZone("America/Chicago");
    t.after(() => setAppTimeZone(null));
    assert.equal(
      planExportFilename("Sunday AM", new Date(Date.UTC(2026, 8, 5, 4, 30, 0))),
      "sunday-am-2026-09-04.stage-plan.json",
    );
  });
});

describe("POST /api/views/import takes both body shapes", () => {
  const planFile = () => ({
    kind: "stage-utility-view", version: 1, appVersion: "1.0.0",
    createdAt: "2026-09-08T00:00:00.000Z", source: { server: "Elsewhere" },
    plan: { serviceTypeId: "st-1", serviceTypeName: "Sunday AM", slotsScope: "type" },
    roots: ["v-in"],
    views: [{ id: "v-in", name: "Incoming", kind: "slots", createdAt: 0, layout: null }],
    sideData: { slots: { "v-in": { "st-1": [row("z")] } }, notes: {}, scriptviewLayouts: [] },
    targets: { osc: [], rosstalk: [] },
    images: {},
  });

  test("the bundle posted verbatim, as every published version sends it", async () => {
    const r = await callRoute(viewRoutes, "/api/views/import", { method: "POST", body: planFile() });
    assert.equal(r.status, 200);
    const report = r.json as Record<string, unknown>;
    assert.equal((report.plan as Record<string, unknown>).serviceTypeId, "st-1");
    assert.equal((report.plan as Record<string, unknown>).retypedFrom, undefined);
  });

  test("and wrapped, carrying the chosen type and the clash choice", async () => {
    const r = await callRoute(viewRoutes, "/api/views/import", {
      method: "POST",
      body: { bundle: planFile(), serviceTypeId: "st-2", onClash: "replace" },
    });
    assert.equal(r.status, 200);
    const plan = (r.json as Record<string, unknown>).plan as Record<string, unknown>;
    assert.equal(plan.serviceTypeId, "st-2");
    assert.equal(plan.retypedFrom, "st-1");
  });
});
