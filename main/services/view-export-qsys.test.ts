// A Q-SYS panel in a view bundle, through the real export and the real import route:
// the `qsys` block travels, a clashing address takes a numeric suffix and the
// report says so, a bad block is refused before anything is written, and a bundle
// lands on a server with no Core set up without anything throwing.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { outputRouteHarness } from "./fixtures/output-routes.js";

const { viewRoutes, callRoute, stageController } = await outputRouteHarness("stage-qsys-bundle-");
const { viewsStore } = await import("./views-store.js");
const { buildViewBundle } = await import("./view-export.js");
const { qsysRoutes } = await import("./routes/qsys-routes.js");
const { qsysSlugsOf } = await import("../types/qsys.js");

const LAYOUT = { version: 1, canvas: { width: 1920, height: 1080, background: null }, objects: [] };
const panel = (id: string, slug: string, name: string, over: Record<string, unknown> = {}) =>
  ({ id, name, kind: "custom", surface: "console", createdAt: "", layout: LAYOUT, qsys: { kind: "volunteer", slug, siblings: [], returnAfterMin: 5 }, ...over }) as unknown as View;

const bundle = (views: unknown[]) => ({
  kind: "stage-utility-view", version: 1, appVersion: "1.0.0", createdAt: "2026-11-24T00:00:00.000Z",
  source: { server: "Elsewhere" }, views, sideData: { slots: {}, notes: {}, serviceCueLayouts: [] },
  targets: { osc: [], rosstalk: [] }, images: {},
});

type Report = { views: { id: string; name: string }[]; qsysPanels: { id: string; name: string; slug: string; renamedFrom?: string; droppedAliases?: string[]; missingSiblings: string[] }[] };
const importBundle = (b: unknown) => callRoute(viewRoutes, "/api/views/import", { method: "POST", body: b });
const have = async () => await viewsStore.load();

describe("Q-SYS panels in a view bundle", () => {
  it("the qsys block travels: exported with the view, and a panel on the far side with it", async () => {
    await viewsStore.save([panel("p1", "zone-1", "Zone 1", { qsys: { kind: "staff", slug: "zone-1", siblings: ["booth"], returnAfterMin: 0 } })]);
    const out = await buildViewBundle("p1");
    assert.deepEqual(out.views[0]?.qsys, { kind: "staff", slug: "zone-1", siblings: ["booth"], returnAfterMin: 0 });
    await viewsStore.save([]);
    const r = await importBundle(out);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const landed = (await have()).find((v) => v.name === "Zone 1");
    assert.deepEqual(landed?.qsys, { kind: "staff", slug: "zone-1", siblings: ["booth"], returnAfterMin: 0 });
    assert.equal(stageController.getState().views.find((v) => v.name === "Zone 1")?.qsys?.slug, "zone-1", "the running server has the panel");
  });

  it("a slug taken here gets a numeric suffix, the panel here is untouched, and the report says so", async () => {
    await viewsStore.save([panel("p1", "zone-1", "Zone 1"), panel("p2", "zone-1-2", "Zone 1 again")]);
    const r = await importBundle(bundle([panel("x", "zone-1", "Zone 1 from file")]));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const report = r.json as Report;
    assert.deepEqual(report.qsysPanels.map((p) => [p.name, p.slug, p.renamedFrom]), [["Zone 1 from file", "zone-1-3", "zone-1"]]);
    const views = await have();
    assert.equal(views.find((v) => v.id === "p1")?.qsys?.slug, "zone-1");
    assert.equal(views.find((v) => v.name === "Zone 1 from file")?.qsys?.slug, "zone-1-3");
    assert.equal(qsysSlugsOf(views).size, views.filter((v) => v.qsys).length, "two panels share an address");
  });

  it("two panels in one file sharing a slug do not share it here, and a sibling follows the rename", async () => {
    await viewsStore.save([panel("p1", "booth", "Local booth")]);
    const a = panel("a", "booth", "Booth from file", { qsys: { kind: "staff", slug: "booth", siblings: ["lobby"], returnAfterMin: 5 } });
    const b = panel("b", "lobby", "Lobby from file", { qsys: { kind: "volunteer", slug: "lobby", siblings: ["booth", "gone"], returnAfterMin: 5 } });
    const c = panel("c", "lobby", "Lobby twin", {});
    const r = await importBundle(bundle([a, b, c]));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const views = await have();
    const slug = (name: string) => views.find((v) => v.name === name)?.qsys;
    assert.equal(slug("Booth from file")?.slug, "booth-2");
    assert.equal(slug("Lobby from file")?.slug, "lobby");
    assert.equal(slug("Lobby twin")?.slug, "lobby-2");
    // "booth" in the file means the file's booth, now booth-2, not the local panel that kept the address.
    assert.deepEqual(slug("Lobby from file")?.siblings, ["booth-2", "gone"]);
    assert.deepEqual(slug("Booth from file")?.siblings, ["lobby"]);
    assert.equal(new Set(qsysSlugsOf(views)).size, 4, "an address is used twice");
  });

  it("a sibling that exists nowhere after the import is kept in the block and reported, not an error", async () => {
    await viewsStore.save([]);
    const r = await importBundle(bundle([panel("a", "lobby", "Lobby", { qsys: { kind: "volunteer", slug: "lobby", siblings: ["booth", "gone"], returnAfterMin: 5 } }), panel("b", "booth", "Booth")]));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const report = (r.json as Report).qsysPanels;
    assert.deepEqual(report.find((p) => p.name === "Lobby")?.missingSiblings, ["gone"]);
    assert.deepEqual(report.find((p) => p.name === "Booth")?.missingSiblings, []);
    assert.deepEqual((await have()).find((v) => v.name === "Lobby")?.qsys?.siblings, ["booth", "gone"]);
  });

  it("a block the app would refuse is refused whole, and nothing is written", async () => {
    const before = [panel("p1", "zone-1", "Zone 1")];
    const bad: [string, unknown, RegExp][] = [
      ["a slug of the wrong shape", panel("x", "Zone 2", "Bad"), /Q-SYS panel settings that are refused/],
      ["the reserved manage", panel("x", "manage", "Bad"), /not "manage"/],
      ["an unknown field", panel("x", "ok", "Bad", { qsys: { kind: "staff", slug: "ok", power: 1 } }), /field this app does not have/],
      ["a bad kind", panel("x", "ok", "Bad", { qsys: { kind: "guest", slug: "ok" } }), /volunteer or staff/],
      ["a display", panel("x", "ok", "Bad", { surface: "display" }), /custom console/],
      ["a slots screen", panel("x", "ok", "Bad", { kind: "slots", layout: null }), /custom console/],
    ];
    for (const [what, view, message] of bad) {
      await viewsStore.save(before);
      const r = await importBundle(bundle([panel("good", "fine", "Good"), view]));
      assert.equal(r.status, 400, `${what}: ${JSON.stringify(r.json)}`);
      assert.match((r.json as { error: string }).error, message, what);
      assert.deepEqual((await have()).map((v) => v.id), ["p1"], `${what}: something was written`);
    }
  });

  it("qsys: null in a file is no block, as PATCH and the load read it", async () => {
    await viewsStore.save([]);
    const r = await importBundle(bundle([panel("x", "ok", "Plain", { qsys: null })]));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const landed = (await have()).find((v) => v.name === "Plain");
    assert.ok(landed && !("qsys" in landed), "a null block landed as a block");
  });

  it("settings a view keeps aside travel, bounded: not a list, more than 20, or an entry over 4 KB is refused whole", async () => {
    const kept = [{ kind: "guest", slug: "Foyer" }];
    await viewsStore.save([]);
    const ok = await importBundle(bundle([panel("x", "ok", "Keeps", { qsysInactive: kept })]));
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.deepEqual((await have()).find((v) => v.name === "Keeps")?.qsysInactive, kept);
    const bad: [string, unknown, RegExp][] = [
      ["not a list", "x", /not a list/],
      ["21 entries", Array.from({ length: 21 }, () => ({})), /more than 20/],
      ["an entry over 4 KB", [{ note: "x".repeat(5000) }], /over 4096 characters/],
    ];
    for (const [what, qsysInactive, message] of bad) {
      await viewsStore.save([panel("p1", "zone-1", "Zone 1")]);
      const r = await importBundle(bundle([panel("x", "ok", "Bad", { qsysInactive })]));
      assert.equal(r.status, 400, `${what}: ${JSON.stringify(r.json)}`);
      assert.match((r.json as { error: string }).error, message, what);
      assert.deepEqual((await have()).map((v) => v.id), ["p1"], `${what}: something was written`);
    }
  });

  it("a panel's old addresses travel, less any taken here, and the report names those", async () => {
    await viewsStore.save([panel("p1", "front", "Here")]);
    const r = await importBundle(bundle([panel("x", "zone-9", "From file", { qsys: { kind: "staff", slug: "zone-9", siblings: [], returnAfterMin: 5, aliases: ["front", "old-9"] } })]));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const landed = (await have()).find((v) => v.name === "From file");
    assert.deepEqual(landed?.qsys?.aliases, ["old-9"], "an old address taken here was kept, or a free one dropped");
    assert.deepEqual((r.json as Report).qsysPanels[0], { id: landed!.id, name: "From file", slug: "zone-9", droppedAliases: ["front"], missingSiblings: [] });
    assert.equal(qsysSlugsOf(await have()).size, 3);
  });

  it("a bundle imports on a server with no Q-SYS integration: it lands, the check says there is no Core, nothing throws", async () => {
    await viewsStore.save([]);
    const r = await importBundle(bundle([panel("a", "lobby", "Lobby", {})]));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(stageController.getState().views.filter((v) => v.qsys).length, 1);
    const bindings = await callRoute(qsysRoutes, "/api/qsys/bindings");
    assert.equal(bindings.status, 503, "the binding check threw instead of saying it is not connected");
    const status = await callRoute(qsysRoutes, "/api/qsys/status");
    assert.equal(status.status, 200);
    assert.equal((status.json as { configured?: boolean }).configured, false);
  });

  it("importing with onClash replace does not replace a panel here: its address stays taken and the file's copy is suffixed", async () => {
    // onClash decides a patch variant and a preset; a view is never overwritten, so the
    // panel already here keeps its address whichever way the choice is made.
    for (const onClash of ["keep", "replace"]) {
      await viewsStore.save([panel("p1", "zone-1", "Zone 1 here")]);
      const r = await importBundle({ bundle: bundle([panel("x", "zone-1", "Zone 1 from file")]), onClash });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      const views = await have();
      assert.equal(views.find((v) => v.id === "p1")?.qsys?.slug, "zone-1", `${onClash}: the panel here lost its address`);
      assert.equal(views.find((v) => v.name === "Zone 1 from file")?.qsys?.slug, "zone-1-2", `${onClash}: the file's copy shares it`);
      assert.equal(views.length, 2, `${onClash}: a view was replaced`);
    }
  });
});
