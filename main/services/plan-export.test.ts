// Building one service type's export.
//
// The service type list is injected rather than reached for, so these run the
// REAL bundle path — views store, slots store, patch store, presets store — with
// no Planning Center. Everything else is the production code.

import assert from "node:assert/strict";
import { describe, test, beforeEach } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// A real data directory, never the operator's. STAGE_UTILITY_DATA is set before
// any store module is imported, because DataStore resolves its path once.
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "su-plan-export-"));
process.env.STAGE_UTILITY_DATA = dir;

const { viewsStore } = await import("./views-store.js");
const { slotsStore } = await import("./slots-store.js");
const { patchStore } = await import("./patch-store.js");
const { presetsStore } = await import("./presets-store.js");
const { buildPlanBundle, planExportPreview } = await import("./plan-export.js");
const { buildViewBundle } = await import("./view-export.js");

const TYPES = { listServiceTypes: async () => [{ id: "st-1", name: "Sunday AM" }, { id: "st-2", name: "Youth" }] };

const slotsView = (id: string) => ({ id, name: id, kind: "slots", createdAt: 0, layout: null });
const custom = (id: string, objects: unknown[]) => ({
  id, name: id, kind: "custom", createdAt: 0,
  layout: { version: 1, canvas: { width: 1920, height: 1080 }, objects },
});
const grid = (id: string) => ({ id, x: 0, y: 0, w: 1, h: 1, z: 0, style: {}, config: { type: "slots-grid" } });
const row = (id: string) => ({ id, label: id, link: { kind: "static" as const } });

beforeEach(async () => {
  await viewsStore.save([
    slotsView("view-slots"),
    custom("view-grid", [grid("obj-grid")]),
    custom("view-unrelated", []),
  ] as never);
  // A board on a slots VIEW and a board on an inline slots-grid OBJECT: the two
  // ways a service type's rows are keyed, and only one of them names a view.
  await slotsStore.setDefault("view-slots", "st-1", [row("a"), row("b")] as never);
  await slotsStore.setDefault("obj-grid", "st-1", [row("c")] as never);
  await slotsStore.setDefault("obj-grid", "st-2", [row("d"), row("e")] as never);
  await patchStore.save({
    sheets: [{
      id: "analog", name: "Analog", kind: "analog", devices: [], endpoints: [],
      variants: [{ id: "var-am", name: "Sunday rig", overrides: {} }],
      assignments: { byServiceType: { "st-1": "var-am" }, byPlan: {} },
    }, {
      id: "dante", name: "Dante", kind: "dante", devices: [], endpoints: [],
      variants: [],
      // Assigned to a variant that is not on the sheet — broken here already.
      assignments: { byServiceType: { "st-1": "var-gone" }, byPlan: {} },
    }],
    updatedAt: "",
  } as never);
  await presetsStore.save([
    { id: "p1", name: "Band of five", slots: [row("x")], createdAt: "" },
  ] as never);
});

const opts = (over: Record<string, unknown> = {}) =>
  ({ serviceTypeId: "st-1", slots: "type" as const, patch: true, presets: true, ...over });

describe("which views a plan export starts from", () => {
  test("a slots view and an inline slots-grid's OWNER are both roots", async () => {
    const b = await buildPlanBundle(opts(), TYPES);
    // view-grid is here because obj-grid's board is keyed by the OBJECT id, and
    // an object id names no view — the layout has to be walked to find it.
    assert.deepEqual(b.roots?.slice().sort(), ["view-grid", "view-slots"]);
  });

  test("a view with no board for this type is not dragged in", async () => {
    const b = await buildPlanBundle(opts(), TYPES);
    assert.ok(!b.views.some((v) => v.id === "view-unrelated"));
  });

  test("roots are named, so the far end knows which views are top-level", async () => {
    const b = await buildPlanBundle(opts({ serviceTypeId: "st-2" }), TYPES);
    assert.deepEqual(b.roots, ["view-grid"]);
    assert.deepEqual(b.views.map((v) => v.id), ["view-grid"]);
  });
});

describe("the slots scope", () => {
  test('"type" carries this type\'s board and no other', async () => {
    const b = await buildPlanBundle(opts({ slots: "type" }), TYPES);
    assert.deepEqual(Object.keys(b.sideData.slots["obj-grid"]!), ["st-1"]);
    assert.equal(b.plan?.slotsScope, "type");
  });

  test('"all" carries every type\'s board on those views', async () => {
    const b = await buildPlanBundle(opts({ slots: "all" }), TYPES);
    assert.deepEqual(Object.keys(b.sideData.slots["obj-grid"]!).sort(), ["st-1", "st-2"]);
    assert.equal(b.plan?.slotsScope, "all");
  });
});

describe("the patch variant section", () => {
  test("carries the variant this type is assigned to, and the sheet's name", async () => {
    const b = await buildPlanBundle(opts(), TYPES);
    assert.deepEqual(
      b.sideData.patchVariants?.map((p) => [p.sheetId, p.sheetName, p.variant.name]),
      [["analog", "Analog", "Sunday rig"]],
    );
  });

  test("an assignment naming a variant that is not on the sheet carries nothing", async () => {
    // Broken at the source already; shipping the id alone would put the same
    // break on the far end, where nobody could see where it came from.
    const b = await buildPlanBundle(opts(), TYPES);
    assert.ok(!b.sideData.patchVariants?.some((p) => p.sheetId === "dante"));
  });

  test("a type with no assignment carries no patch section at all", async () => {
    const b = await buildPlanBundle(opts({ serviceTypeId: "st-2" }), TYPES);
    assert.equal(b.sideData.patchVariants, undefined);
  });

  test("off means off", async () => {
    const b = await buildPlanBundle(opts({ patch: false }), TYPES);
    assert.equal(b.sideData.patchVariants, undefined);
  });

  test("the rig itself never travels", async () => {
    // A variant is an overlay of overrides. Devices and endpoints are the
    // building's, and shipping them would aim the far end at racks not in it.
    const text = JSON.stringify(await buildPlanBundle(opts(), TYPES));
    assert.ok(!text.includes("endpoints"), "the bundle carries patch endpoints");
    assert.ok(!text.includes('"devices"'), "the bundle carries patch devices");
  });
});

describe("presets", () => {
  test("travel when asked for", async () => {
    const b = await buildPlanBundle(opts(), TYPES);
    assert.deepEqual(b.sideData.presets?.map((p) => p.id), ["p1"]);
  });

  test("do not when they are not", async () => {
    const b = await buildPlanBundle(opts({ presets: false }), TYPES);
    assert.equal(b.sideData.presets, undefined);
  });
});

describe("refusing rather than shipping an empty file", () => {
  test("an unknown service type is an error", async () => {
    await assert.rejects(() => buildPlanBundle(opts({ serviceTypeId: "st-nope" }), TYPES), /unknown service type/);
  });

  test("a type with no board anywhere is an error naming the type", async () => {
    // A file that downloads and does nothing at the far end is the worst outcome.
    await slotsStore.removeDisplay("obj-grid");
    await assert.rejects(
      () => buildPlanBundle(opts({ serviceTypeId: "st-2" }), TYPES),
      /nothing to export for Youth/,
    );
  });
});

describe("the preview and the file agree", () => {
  test("because they are the same code path", async () => {
    const p = await planExportPreview("st-1", "type", TYPES);
    const b = await buildPlanBundle(opts(), TYPES);
    assert.equal(p.serviceTypeName, "Sunday AM");
    assert.equal(p.views, b.views.length);
    assert.equal(p.boards, 2);
    assert.equal(p.rows, 3);
    assert.deepEqual(p.patchVariants, [{ sheetName: "Analog", variantName: "Sunday rig" }]);
    assert.equal(p.presets, 1);
    assert.equal(p.scriptviewLayouts, 0);
  });

  test("at the other scope, because the file at that scope is bigger", async () => {
    // obj-grid carries a board for st-1 and one for st-2. Counted always at
    // "type", the dialog's boards and rows line sat still while the segmented
    // control moved and the file grew.
    const type = await planExportPreview("st-1", "type", TYPES);
    const all = await planExportPreview("st-1", "all", TYPES);
    assert.equal(type.boards, 2);
    assert.equal(all.boards, 3, "the preview ignored the slots scope");
    assert.equal(all.rows, type.rows + 2);
  });

  test("and it refuses the same things", async () => {
    await assert.rejects(() => planExportPreview("st-nope", "type", TYPES), /unknown service type/);
  });
});

// buildViewBundle was refactored to share its body with the plan export. A view
// export must still be byte for byte what it was, or every install that reads
// one is reading a different file than it was written for.
describe("a plain view export is unchanged", () => {
  test("no plan, no roots, and every service type's board", async () => {
    const b = await buildViewBundle("view-grid");
    assert.equal("plan" in b, false, "a view export must not carry a plan section");
    assert.equal("roots" in b, false, "a view export has one root and says so by ordering");
    assert.deepEqual(Object.keys(b.sideData.slots["obj-grid"]!).sort(), ["st-1", "st-2"]);
    assert.deepEqual(Object.keys(b.sideData), ["slots", "notes", "scriptviewLayouts"]);
  });

  test("the key order of the envelope is untouched", async () => {
    // The file is compared and diffed by humans; a reordered envelope is a whole
    // file's worth of noise in a review.
    const b = await buildViewBundle("view-slots");
    assert.deepEqual(Object.keys(b), [
      "kind", "version", "appVersion", "createdAt", "source", "views", "sideData", "targets", "images",
    ]);
  });
});
