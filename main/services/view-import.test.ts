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
