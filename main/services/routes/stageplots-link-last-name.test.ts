// A connection point linked to a patch device keeps the LAST name and colour the device had when
// the device goes: every patch save writes them onto the stored points (stageplots-publish-
// instance.ts), against the patch it replaces and the one it saves. Through the real patch store
// and stage plots store, against a real data directory.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stageplots-last-name-"));
process.env.STAGE_UTILITY_DATA = TMP;

const { callRoute } = await import("./route-harness.js");
const { stageplotsRoutes } = await import("./stageplots-routes.js");
const { stageplotsStore } = await import("../stageplots-store.js");
const { patchStore } = await import("../patch-store.js");
await import("../stageplots-publish-instance.js");
type PatchFile = import("../../types/patch.js").PatchFile;

after(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

const call = (method: string, p: string, body?: unknown) => callRoute(stageplotsRoutes, p, { method, body });

const patchOf = (devices: { id: string; name: string; color?: string }[], sheetId = "main"): PatchFile => ({
  updatedAt: "",
  sheets: [
    {
      id: sheetId,
      name: "Main patch",
      kind: "analog",
      devices: devices.map((d) => ({ ...d, kind: "snake" as const, inputs: 8, outputs: 0 })),
      endpoints: [],
      variants: [],
      assignments: { byServiceType: {}, byPlan: {} },
    },
  ],
});

async function linkedPlot(lastName: string): Promise<string> {
  const v = (await call("POST", "/api/stageplots/venues", { name: "Room", kind: "home", notes: "" })).json as { id: string };
  const p = (await call("POST", "/api/stageplots/plots", { venueId: v.id, name: "Standard" })).json as { id: string; version: number };
  const items = [
    { id: "c1", type: "conn", x: 10, y: 10, w: 40, h: 30, rotation: 0, label: lastName, color: null, notes: "", inputs: [], patchLink: { sheetId: "main", deviceId: "sb1", lastName, lastColor: null } },
  ];
  const r = await call("PUT", `/api/stageplots/plots/${p.id}/items`, { version: p.version, items });
  assert.equal(r.status, 200, r.body);
  return p.id;
}

async function stored(plotId: string) {
  const plot = (await stageplotsStore.get()).plots.find((p) => p.id === plotId)!;
  const it = plot.items[0]!;
  return { label: it.label, color: it.color, lastName: it.patchLink?.lastName, lastColor: it.patchLink?.lastColor, version: plot.version };
}

test("a device renamed and recoloured, then removed: the point keeps the renamed name and the new colour", async () => {
  const plotId = await linkedPlot("Stage Left Box");
  await patchStore.save(patchOf([{ id: "sb1", name: "Stage Left Box" }]));
  const v1 = (await stored(plotId)).version;
  await patchStore.save(patchOf([{ id: "sb1", name: "Drum Box", color: "#e5484d" }]));
  const renamed = await stored(plotId);
  assert.equal(renamed.lastName, "Drum Box");
  assert.equal(renamed.version, v1, "a stamp is not an edit: a draft on this version still saves");
  await patchStore.save(patchOf([]));
  const gone = await stored(plotId);
  assert.deepEqual([gone.label, gone.lastName, gone.color, gone.lastColor], ["Drum Box", "Drum Box", gone.color, gone.color]);
  assert.notEqual(gone.color, null, "the colour it had is kept");
});

test("a rename and the removal in one save: the point keeps what the device was in the patch it replaced", async () => {
  const plotId = await linkedPlot("Old Box");
  await patchStore.save(patchOf([{ id: "sb1", name: "Mid Box", color: "#e5484d" }]));
  // A snapshot older than this build: put the stale one back, as a patch saved before it left it.
  await stageplotsStore.update((doc) => ({ ...doc, plots: doc.plots.map((p) => (p.id === plotId ? { ...p, items: p.items.map((it) => ({ ...it, label: "Old Box", color: null, patchLink: { ...it.patchLink!, lastName: "Old Box", lastColor: null } })) } : p)) }));
  await patchStore.save(patchOf([]));
  const gone = await stored(plotId);
  assert.equal(gone.lastName, "Mid Box");
  assert.notEqual(gone.lastColor, null);
});

test("a rack removed with devices in it: every linked point keeps its device's last name", async () => {
  const plotId = await linkedPlot("Box");
  await patchStore.save(patchOf([{ id: "sb1", name: "Rack A / Box" }, { id: "rack", name: "Rack A" }]));
  await patchStore.save({ ...patchOf([]), sheets: [] });
  assert.equal((await stored(plotId)).lastName, "Rack A / Box");
});

// A draft opened before a patch save carries the last name it loaded. Saving it must not put
// that name back over the newer one the patch save stamped.
describe("an editor's older draft saved after a patch save", () => {
  const stalePut = async (plotId: string, edit: (it: Record<string, unknown>) => Record<string, unknown> = (it) => it) => {
    const plot = (await stageplotsStore.get()).plots.find((p) => p.id === plotId)!;
    // What the editor loaded: the point as it was linked, before any stamp.
    const old = { ...plot.items[0]!, label: "Stage Left Box", color: null, patchLink: { ...plot.items[0]!.patchLink!, lastName: "Stage Left Box", lastColor: null } };
    return call("PUT", `/api/stageplots/plots/${plotId}/items`, { version: plot.version, items: [edit({ ...old })] });
  };

  test("a device that is gone keeps the stamped name and colour over the draft's", async () => {
    const plotId = await linkedPlot("Stage Left Box");
    await patchStore.save(patchOf([{ id: "sb1", name: "Drum Box", color: "#e5484d" }]));
    await patchStore.save(patchOf([]));
    const r = await stalePut(plotId, (it) => ({ ...it, x: 55 }));
    assert.equal(r.status, 200, r.body);
    const s = await stored(plotId);
    assert.deepEqual([s.label, s.lastName, s.lastColor, s.color], ["Drum Box", "Drum Box", "#e5484d", "#e5484d"]);
    assert.equal((await stageplotsStore.get()).plots.find((p) => p.id === plotId)!.items[0]!.x, 55, "the editor's own change was dropped");
  });

  test("a device still there is stamped against the patch as it is now", async () => {
    const plotId = await linkedPlot("Stage Left Box");
    await patchStore.save(patchOf([{ id: "sb1", name: "Drum Box" }]));
    const r = await stalePut(plotId);
    assert.equal(r.status, 200, r.body);
    assert.equal((await stored(plotId)).lastName, "Drum Box");
  });

  test("a point the editor relinked is saved as sent", async () => {
    const plotId = await linkedPlot("Stage Left Box");
    await patchStore.save(patchOf([{ id: "sb1", name: "Drum Box" }, { id: "sb2", name: "Other" }]));
    const r = await stalePut(plotId, (it) => ({ ...it, label: "Other", patchLink: { sheetId: "main", deviceId: "sb2", lastName: "Other", lastColor: null } }));
    assert.equal(r.status, 200, r.body);
    const s = await stored(plotId);
    assert.deepEqual([s.label, s.lastName], ["Other", "Other"]);
  });

  test("a point the editor unlinked is saved as sent", async () => {
    const plotId = await linkedPlot("Stage Left Box");
    await patchStore.save(patchOf([{ id: "sb1", name: "Drum Box" }]));
    const r = await stalePut(plotId, (it) => {
      const { patchLink: _gone, ...rest } = it;
      return { ...rest, label: "Mine" };
    });
    assert.equal(r.status, 200, r.body);
    const it = (await stageplotsStore.get()).plots.find((p) => p.id === plotId)!.items[0]!;
    assert.deepEqual([it.label, it.patchLink], ["Mine", undefined]);
  });
});
