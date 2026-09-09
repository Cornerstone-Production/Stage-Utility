import assert from "node:assert/strict";
import { describe, test, beforeEach } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// A real data directory, never the operator's.
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "su-import-"));
process.env.STAGE_UTILITY_DATA = dir;

const { viewsStore } = await import("./views-store.js");
const { oscStore } = await import("./osc-store.js");
const { applyViewBundle } = await import("./view-import.js");

const bundle = (over: Record<string, unknown> = {}) => ({
  kind: "stage-utility-view", version: 1, appVersion: "1.0.0",
  createdAt: "2026-08-17T00:00:00.000Z", source: { server: "Elsewhere" },
  views: [{
    id: "view-1", name: "Left Display", kind: "custom", createdAt: 0,
    layout: { version: 1, canvas: { width: 1920, height: 1080 }, objects: [] },
  }],
  sideData: { slots: {}, notes: {}, scriptviewLayouts: [] },
  targets: { osc: [], rosstalk: [] },
  images: {},
  ...over,
});

beforeEach(async () => {
  await viewsStore.save([] as never);
  await oscStore.save([] as never);
});

describe("importing a bundle", () => {
  test("a foreign file is refused BY NAME", async () => {
    // Picking the config snapshot by mistake is the likely error, and "invalid
    // file" would teach nobody anything.
    await assert.rejects(
      () => applyViewBundle({ kind: "stage-utility-config", version: 1 }),
      /stage-utility-config/,
    );
  });

  test("junk is refused rather than throwing something unreadable", async () => {
    for (const junk of [null, "a string", 42, [], {}]) {
      await assert.rejects(() => applyViewBundle(junk), /import/i, `accepted ${JSON.stringify(junk)}`);
    }
  });

  // Everything below is refused BEFORE anything is written. A throw partway
  // leaves views on disk the controller does not know about, and the next thing
  // to save the view list erases them.
  test("a layout the renderer cannot draw is refused, and nothing is written", async () => {
    // canvas.width is read unguarded in the renderer, so this crashes the display
    // it is saved to. The app's own PATCH path has always refused it.
    await assert.rejects(
      () => applyViewBundle(bundle({
        views: [{ id: "v", name: "Bad", kind: "custom", createdAt: 0,
                  layout: { version: 1, canvas: {}, objects: [] } }],
      })),
      /cannot draw/,
    );
    assert.deepEqual(await viewsStore.load(), [], "a view was written despite the refusal");
  });

  test("two views sharing an id are refused, and nothing is written", async () => {
    // Both would collapse onto one minted id, so deleting either would remove
    // both and their slot rows would land on top of each other.
    await assert.rejects(
      () => applyViewBundle(bundle({
        views: [
          { id: "same", name: "A", kind: "custom", createdAt: 0, layout: null },
          { id: "same", name: "B", kind: "custom", createdAt: 0, layout: null },
        ],
      })),
      /two views with id same/,
    );
    assert.deepEqual(await viewsStore.load(), []);
  });

  test("a view with no name or kind is refused", async () => {
    await assert.rejects(
      () => applyViewBundle(bundle({ views: [{ id: "x" }] })),
      /has no name/,
    );
    assert.deepEqual(await viewsStore.load(), []);
  });

  test("a file with no sideData at all imports rather than throwing mid-write", async () => {
    // The review sheet previews such a file happily, so the server must not
    // crash on it after the views are already saved.
    const raw = bundle() as Record<string, unknown>;
    delete raw.sideData;
    const report = await applyViewBundle(raw);
    assert.equal(report.views.length, 1);
  });

  test("slot rows that are not a list are refused before any write", async () => {
    await assert.rejects(
      () => applyViewBundle(bundle({ sideData: { slots: { "view-1": { "st": "nope" } }, notes: {}, scriptviewLayouts: [] } })),
      /not a list/,
    );
    assert.deepEqual(await viewsStore.load(), []);
  });

  test("adds the view without touching what is already there", async () => {
    await viewsStore.save([
      { id: "view-9", name: "Mine", kind: "custom", createdAt: 0, layout: null },
    ] as never);
    await applyViewBundle(bundle());
    const after = await viewsStore.load();
    assert.equal(after.length, 2);
    assert.ok(after.some((v) => v.id === "view-9"), "an existing view was lost");
  });

  test("the imported view never reuses an existing id", async () => {
    await viewsStore.save([
      { id: "view-1", name: "Mine", kind: "custom", createdAt: 0, layout: null },
    ] as never);
    const report = await applyViewBundle(bundle());
    assert.notEqual(report.views[0].id, "view-1");
    const ids = (await viewsStore.load()).map((v) => v.id);
    assert.equal(new Set(ids).size, ids.length, "an id collided");
  });

  test("a name collision is suffixed, and the existing view is untouched", async () => {
    await viewsStore.save([
      { id: "view-9", name: "Left Display", kind: "custom", createdAt: 0, layout: null },
    ] as never);
    const report = await applyViewBundle(bundle());
    const names = (await viewsStore.load()).map((v) => v.name).sort();
    assert.deepEqual(names, ["Left Display", "Left Display (imported)"]);
    assert.equal(report.views[0].renamedFrom, "Left Display");
  });

  test("importing the same file twice does not collide on the suffix either", async () => {
    await applyViewBundle(bundle());
    await applyViewBundle(bundle());
    const names = (await viewsStore.load()).map((v) => v.name).sort();
    assert.deepEqual(names, ["Left Display", "Left Display (imported)"]);
  });

  test("a local target of the same id is never overwritten", async () => {
    await oscStore.save([{ id: "osc-a", name: "MINE", enabled: true, config: { host: "10.0.0.1", port: 8000 } }] as never);
    const report = await applyViewBundle(bundle({
      targets: { osc: [{ id: "osc-a", name: "THEIRS", enabled: true, config: { host: "192.168.1.1", port: 9000 } }], rosstalk: [] },
    }));
    const t = (await oscStore.load())[0] as unknown as { name: string };
    assert.equal(t.name, "MINE", "the imported target overwrote a local one");
    assert.equal(report.targetsKept.length, 1);
    assert.equal(report.targetsAdded.length, 0);
  });

  test("two incoming targets sharing an id do not both land", async () => {
    const t = { id: "osc-dup", name: "One", enabled: true, config: { host: "10.0.0.1", port: 8000 } };
    const report = await applyViewBundle(bundle({
      targets: { osc: [t, { ...t, name: "Two" }], rosstalk: [] },
    }));
    assert.equal((await oscStore.load()).length, 1, "a duplicate id landed in the store");
    assert.equal(report.targetsAdded.length, 1);
  });

  test("a target that is not here is added", async () => {
    const report = await applyViewBundle(bundle({
      targets: { osc: [{ id: "osc-b", name: "Lighting", enabled: true, config: { host: "192.168.1.50", port: 8000 } }], rosstalk: [] },
    }));
    assert.equal(report.targetsAdded.length, 1);
    assert.equal((await oscStore.load()).length, 1);
  });

  test("hardware bindings come back as a named work list, not a count", async () => {
    const report = await applyViewBundle(bundle({
      views: [{
        id: "view-1", name: "L", kind: "custom", createdAt: 0,
        layout: {
          version: 1, canvas: { width: 1920, height: 1080 },
          objects: [{
            id: "o1", x: 0, y: 0, w: 1, h: 1, z: 0, style: {},
            config: { type: "wireless-channel", channelId: "conn-7::3", label: "Handheld 3" },
          }],
        },
      }],
    }));
    assert.equal(report.rebind.length, 1);
    assert.equal(report.rebind[0].label, "Handheld 3");
    // The NEW object id, or the UI cannot select it in the editor.
    assert.notEqual(report.rebind[0].objectId, "o1");
  });

  test("a prototype-reaching key in the file is dropped and named, not fatal", async () => {
    // The store refuses such a key by throwing. Mid-import that would abort
    // having ALREADY written the views, so the operator would be told it failed
    // when it half-succeeded. JSON.parse is used because an object LITERAL with
    // "__proto__" sets the prototype instead of making an own key — the bug
    // does not reproduce without it.
    const raw = JSON.parse(JSON.stringify(bundle()));
    raw.sideData.slots = JSON.parse('{"view-1": {"__proto__": [], "st-1": []}}');

    const report = await applyViewBundle(raw);
    assert.equal(report.views.length, 1, "the import did not complete");
    assert.equal(report.skipped.length, 1, "the bad key was not reported");
    assert.match(report.skipped[0], /__proto__/);
    assert.equal(({} as Record<string, unknown>).st1, undefined, "prototype was polluted");
  });

  test("an image whose bytes disagree with its name is reported, not written", async () => {
    // A bundle is a file off somebody's laptop. A name that does not match its
    // contents would plant bytes under a name a layout already points at.
    const report = await applyViewBundle(bundle({
      images: { "layout-images/0000000000000000.png": Buffer.from("not that image").toString("base64") },
    }));
    assert.equal(report.images.written, 0);
    assert.equal(report.images.failed.length, 1);
    // The view still landed: a layout missing one image beats no layout.
    assert.equal((await viewsStore.load()).length, 1);
  });
});

describe("a bundle carrying two ScriptView presets with one id", () => {
  // mergeTargets, twenty lines below the code this covers, grows its `have` set
  // inside the loop and says why in a comment: "two incoming targets sharing an
  // id would otherwise both be appended, leaving a duplicate id in the store."
  //
  // The ScriptView merge is the same shape re-implemented, and it computed the
  // add-list with a filter BEFORE the loop grew the seen-set — so it dropped the
  // guard the sibling ten lines away was written to keep. An export cannot
  // normally produce this, but an import is the one place a hand-edited or
  // concatenated file arrives, which is exactly when a store must not be
  // corrupted.

  test("appends the preset once, not twice", async () => {
    const { scriptViewLayoutsStore } = await import("./scriptview-layouts-store.js");
    await scriptViewLayoutsStore.save([] as never);

    await applyViewBundle(bundle({
      sideData: {
        slots: {}, notes: {},
        scriptviewLayouts: [
          { id: "dup", name: "First", columns: [] },
          { id: "dup", name: "Second", columns: [] },
        ],
      },
    }));

    const saved = await scriptViewLayoutsStore.load();
    const dupes = saved.filter((l: { id: string }) => l.id === "dup");
    assert.equal(dupes.length, 1, `"dup" landed ${dupes.length} times: ${JSON.stringify(saved)}`);
    assert.equal(dupes[0].name, "First", "the first one wins, like a target does");
  });
});

// ── Plan exports ────────────────────────────────────────────────────────────
//
// A plan file is the same bundle with a service type on it, so everything above
// still applies. What is new is the three things it can do that a view export
// cannot: land under a different service type, carry a patch variant, and carry
// presets. Only the last two can clash with anything already here.

const { slotsStore } = await import("./slots-store.js");
const { patchStore } = await import("./patch-store.js");
const { presetsStore } = await import("./presets-store.js");

const slotRow = (id: string) => ({ id, label: id, link: { kind: "static" as const } });
const slotsView = (id: string, name: string) => ({ id, name, kind: "slots", createdAt: 0, layout: null });

/** A plan bundle over one slots view, with the type's board on it. */
const planBundle = (over: Record<string, unknown> = {}, sideOver: Record<string, unknown> = {}) => bundle({
  plan: { serviceTypeId: "st-src", serviceTypeName: "Sunday AM", slotsScope: "type" },
  roots: ["view-1"],
  views: [slotsView("view-1", "Mic Board")],
  sideData: {
    slots: { "view-1": { "st-src": [slotRow("r1"), slotRow("r2")] } },
    notes: {}, scriptviewLayouts: [],
    ...sideOver,
  },
  ...over,
});

const sheet = (over: Record<string, unknown> = {}) => ({
  id: "analog", name: "Analog", kind: "analog", devices: [], endpoints: [],
  variants: [], assignments: { byServiceType: {}, byPlan: {} }, ...over,
});

async function blankPatch(over: Record<string, unknown> = {}): Promise<void> {
  await patchStore.save({ sheets: [sheet(over)], updatedAt: "" } as never);
}

describe("landing a plan under a different service type", () => {
  beforeEach(async () => {
    await viewsStore.save([] as never);
    await presetsStore.save([] as never);
    await blankPatch();
  });

  test("the boards move to the chosen type, and the report says where from", async () => {
    const report = await applyViewBundle(planBundle(), { serviceTypeId: "st-dst" });
    const key = report.views[0]!.id;
    const landed = (await slotsStore.allDefaults())[key]!;
    assert.deepEqual(Object.keys(landed), ["st-dst"], "the board stayed under the file's own type id");
    assert.equal(landed["st-dst"]!.length, 2);
    assert.equal(report.plan?.retypedFrom, "st-src");
    assert.equal(report.plan?.serviceTypeId, "st-dst");
    assert.equal(report.slotBoards, 1);
    assert.equal(report.slotRows, 2);
  });

  test("choosing the type the file already names is not a retype", async () => {
    const report = await applyViewBundle(planBundle(), { serviceTypeId: "st-src" });
    assert.equal(report.plan?.retypedFrom, undefined);
    assert.equal(report.plan?.serviceTypeId, "st-src");
  });

  test('at scope "all" the source type is re-keyed and other types land as they are', async () => {
    const b = planBundle(
      { plan: { serviceTypeId: "st-src", serviceTypeName: "Sunday AM", slotsScope: "all" } },
      { slots: { "view-1": { "st-src": [slotRow("a")], "st-other": [slotRow("b"), slotRow("c")] } } },
    );
    const report = await applyViewBundle(b, { serviceTypeId: "st-dst" });
    const landed = (await slotsStore.allDefaults())[report.views[0]!.id]!;
    assert.deepEqual(Object.keys(landed).sort(), ["st-dst", "st-other"]);
    assert.equal(landed["st-dst"]!.length, 1, "st-dst got the wrong type's board");
    assert.equal(landed["st-other"]!.length, 2);
  });

  test("retyping onto a type the file ALSO carries a board for keeps the exported one", async () => {
    // Scope "all" over a file that already holds st-dst's board: two entries
    // land on one key, and the board the operator chose to export is the one
    // they meant.
    const b = planBundle(
      { plan: { serviceTypeId: "st-src", serviceTypeName: "Sunday AM", slotsScope: "all" } },
      { slots: { "view-1": { "st-src": [slotRow("a")], "st-dst": [slotRow("b"), slotRow("c")] } } },
    );
    const report = await applyViewBundle(b, { serviceTypeId: "st-dst" });
    const landed = (await slotsStore.allDefaults())[report.views[0]!.id]!;
    assert.equal(landed["st-dst"]!.length, 1, "the file's own st-dst board overwrote the exported one");
    // And the report counts what is ON DISK, not what was written. Counting
    // writes reported two boards and three rows for one board of one row —
    // the second write landed on the first's key and replaced it.
    assert.equal(report.slotBoards, 1, "a board that was overwritten was still counted");
    assert.equal(report.slotRows, 1, "the overwritten board's rows were still counted");
  });

  test("a view export ignores the chosen type rather than re-keying a guess", async () => {
    // A view export carries every type's boards and names no plan. Re-keying one
    // of them would be picking which, and the file does not say.
    const report = await applyViewBundle(
      bundle({ sideData: { slots: { "view-1": { "st-src": [slotRow("r")] } }, notes: {}, scriptviewLayouts: [] } }),
      { serviceTypeId: "st-dst" },
    );
    const landed = (await slotsStore.allDefaults())[report.views[0]!.id]!;
    assert.deepEqual(Object.keys(landed), ["st-src"]);
    assert.equal(report.plan, undefined);
  });
});

describe("the rebind list walks every root", () => {
  beforeEach(async () => { await viewsStore.save([] as never); });

  test("a root naming a view the file does not contain refuses the whole file", async () => {
    // Filtered out instead, the walk started from nothing: the report promised
    // no hardware to re-point on a file whose roots the importer could not find.
    await assert.rejects(
      () => applyViewBundle(planBundle({ roots: ["view-1", "ghost"] })),
      /roots names a view that is not in the file: ghost/,
    );
    assert.deepEqual(await viewsStore.load(), [], "a view landed from a file that was refused");
  });

  test("not just the first one", async () => {
    // A plan export has as many roots as the service type has boards on. Walking
    // views[0] alone under-reported every other root's hardware, and the
    // operator would find it live instead of in the report.
    const wireless = (objId: string, channel: string) => ({
      id: objId, x: 0, y: 0, w: 1, h: 1, z: 0, style: {},
      config: { type: "wireless-channel", channelId: channel, label: channel },
    });
    const custom = (id: string, name: string, objects: unknown[]) => ({
      id, name, kind: "custom", createdAt: 0,
      layout: { version: 1, canvas: { width: 1920, height: 1080 }, objects },
    });
    const report = await applyViewBundle(planBundle({
      roots: ["view-1", "view-2"],
      views: [custom("view-1", "One", [wireless("o1", "hh-1")]), custom("view-2", "Two", [wireless("o2", "hh-2")])],
    }, { slots: {} }));
    assert.deepEqual(report.rebind.map((r) => r.value).sort(), ["hh-1", "hh-2"]);
  });

  test("and never lists a shared embedded view's work twice", async () => {
    const embed = (objId: string, viewId: string) => ({
      id: objId, x: 0, y: 0, w: 1, h: 1, z: 0, style: {},
      config: { type: "view-embed", viewId },
    });
    const custom = (id: string, name: string, objects: unknown[]) => ({
      id, name, kind: "custom", createdAt: 0,
      layout: { version: 1, canvas: { width: 1920, height: 1080 }, objects },
    });
    const report = await applyViewBundle(planBundle({
      roots: ["view-1", "view-2"],
      views: [
        custom("view-1", "One", [embed("e1", "view-3")]),
        custom("view-2", "Two", [embed("e2", "view-3")]),
        custom("view-3", "Shared", [{
          id: "o3", x: 0, y: 0, w: 1, h: 1, z: 0, style: {},
          config: { type: "spl-meter", meterId: "Smaart::Main" },
        }]),
      ],
    }, { slots: {} }));
    assert.equal(report.rebind.length, 1, `the shared view's meter was listed ${report.rebind.length} times`);
  });
});

describe("patch variants", () => {
  const withVariant = (over: Record<string, unknown> = {}) => planBundle(over, {
    slots: {},
    patchVariants: [{
      sheetId: "analog", sheetName: "Analog",
      variant: { id: "var-1", name: "Sunday rig", overrides: { "r:in:1": { label: "Kick" } } },
    }],
  });

  beforeEach(async () => { await viewsStore.save([] as never); });

  test("a variant that is not here is added and the type assigned to it", async () => {
    await blankPatch();
    const report = await applyViewBundle(withVariant());
    assert.deepEqual(report.patchVariants, [{ sheetName: "Analog", variantName: "Sunday rig", outcome: "added" }]);
    const s = (await patchStore.load()).sheets[0]!;
    assert.deepEqual(s.variants.map((v) => v.id), ["var-1"]);
    assert.equal(s.assignments.byServiceType["st-src"], "var-1");
  });

  test("a variant already here is left alone, and the assignment points at it", async () => {
    await blankPatch({ variants: [{ id: "var-1", name: "Mine", overrides: {} }] });
    const report = await applyViewBundle(withVariant());
    assert.equal(report.patchVariants[0]!.outcome, "assigned");
    const s = (await patchStore.load()).sheets[0]!;
    assert.equal(s.variants[0]!.name, "Mine", "the local variant was overwritten under Keep");
    assert.equal(s.assignments.byServiceType["st-src"], "var-1");
  });

  test("Replace overwrites it", async () => {
    await blankPatch({ variants: [{ id: "var-1", name: "Mine", overrides: {} }] });
    const report = await applyViewBundle(withVariant(), { onClash: "replace" });
    assert.equal(report.patchVariants[0]!.outcome, "replaced");
    assert.equal((await patchStore.load()).sheets[0]!.variants[0]!.name, "Sunday rig");
  });

  test("a DIFFERENT variant already assigned to the type is kept, and nothing is written", async () => {
    await blankPatch({
      variants: [{ id: "var-mine", name: "Mine", overrides: {} }],
      assignments: { byServiceType: { "st-src": "var-mine" }, byPlan: {} },
    });
    const report = await applyViewBundle(withVariant());
    assert.equal(report.patchVariants[0]!.outcome, "kept");
    const s = (await patchStore.load()).sheets[0]!;
    assert.equal(s.assignments.byServiceType["st-src"], "var-mine");
    assert.deepEqual(s.variants.map((v) => v.id), ["var-mine"],
      "an unassigned import is clutter in the patch editor, not a spare");
  });

  test("Replace takes the assignment off the local variant", async () => {
    await blankPatch({
      variants: [{ id: "var-mine", name: "Mine", overrides: {} }],
      assignments: { byServiceType: { "st-src": "var-mine" }, byPlan: {} },
    });
    const report = await applyViewBundle(withVariant(), { onClash: "replace" });
    assert.equal(report.patchVariants[0]!.outcome, "added");
    assert.equal((await patchStore.load()).sheets[0]!.assignments.byServiceType["st-src"], "var-1");
  });

  test("the assignment follows a retype", async () => {
    await blankPatch();
    await applyViewBundle(withVariant(), { serviceTypeId: "st-dst" });
    const assigned = (await patchStore.load()).sheets[0]!.assignments.byServiceType;
    assert.equal(assigned["st-dst"], "var-1");
    assert.equal(assigned["st-src"], undefined, "the file's own type id was assigned on this machine");
  });

  test("a sheet this machine does not have is reported, not fatal", async () => {
    // The views and boards are already correct; refusing here would throw them
    // away over one sheet.
    await patchStore.save({ sheets: [sheet({ id: "dante", name: "Dante", kind: "dante" })], updatedAt: "" } as never);
    const report = await applyViewBundle(withVariant());
    assert.equal(report.patchVariants[0]!.outcome, "no-such-sheet");
    assert.equal(report.views.length, 1, "the views did not land");
  });

  test("a sheet with a different id but the same name is found by name", async () => {
    await patchStore.save({ sheets: [sheet({ id: "locally-made-id", name: "Analog" })], updatedAt: "" } as never);
    const report = await applyViewBundle(withVariant());
    assert.equal(report.patchVariants[0]!.outcome, "added");
  });

  test("a malformed variant refuses the whole file before anything is written", async () => {
    await blankPatch();
    await assert.rejects(
      () => applyViewBundle(planBundle({}, {
        slots: {},
        patchVariants: [{ sheetId: "analog", sheetName: "Analog", variant: { id: "v", name: "V", overrides: "nope" } }],
      })),
      /override map/,
    );
    assert.deepEqual(await viewsStore.load(), [], "a view landed from a file that was refused");
    assert.deepEqual((await patchStore.load()).sheets[0]!.variants, []);
  });
});

describe("presets", () => {
  const p = (id: string, name: string) => ({ id, name, slots: [slotRow("s")], createdAt: "" });
  const withPresets = () => planBundle({}, { slots: {}, presets: [p("p1", "From the file")] });

  beforeEach(async () => { await viewsStore.save([] as never); });

  test("one that is not here is added", async () => {
    await presetsStore.save([] as never);
    const report = await applyViewBundle(withPresets());
    assert.deepEqual(report.presets, { added: 1, kept: 0, replaced: 0 });
    assert.equal((await presetsStore.load())[0]!.name, "From the file");
  });

  test("Keep leaves the local one of the same id alone", async () => {
    await presetsStore.save([p("p1", "Mine")] as never);
    const report = await applyViewBundle(withPresets());
    assert.deepEqual(report.presets, { added: 0, kept: 1, replaced: 0 });
    assert.equal((await presetsStore.load())[0]!.name, "Mine");
  });

  test("Replace overwrites it, and does not duplicate the id", async () => {
    await presetsStore.save([p("p1", "Mine")] as never);
    const report = await applyViewBundle(withPresets(), { onClash: "replace" });
    assert.deepEqual(report.presets, { added: 0, kept: 0, replaced: 1 });
    const saved = await presetsStore.load();
    assert.equal(saved.length, 1);
    assert.equal(saved[0]!.name, "From the file");
  });

  test("a malformed preset refuses the whole file before anything is written", async () => {
    await presetsStore.save([] as never);
    await assert.rejects(
      () => applyViewBundle(planBundle({}, { slots: {}, presets: [{ id: "p", name: "P" }] })),
      /slot list/,
    );
    assert.deepEqual(await viewsStore.load(), []);
    assert.deepEqual(await presetsStore.load(), []);
  });
});

// NOT GUARDED HERE, deliberately: view-import clones the patch file before
// touching it, because patchStore.load() hands back the DataStore's own cached
// object. A test for that clone could not be made to fail — as the code stands
// every branch that mutates a sheet also saves, and every branch that does not
// save never mutates. The clone stays as insurance against the next branch;
// the test that could not go red does not.
