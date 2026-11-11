// When a layout's slug is allowed to move: once, at its first rename away from the name
// Add layout gave it. Everything else keeps the address a screen was pinned with.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "su-layout-slug-naming-"));
process.env.STAGE_UTILITY_DATA = dir;
process.env.HOME = path.join(dir, "home");

const { serviceCueLayoutsStore: store } = await import("./servicecue-layouts-store.js");

after(() => fs.rm(dir, { recursive: true, force: true }));

const rename = async (id: string, name: string) =>
  (await store.save((await store.load()).map((l) => (l.id === id ? { ...l, name } : l))))
    .find((l) => l.id === id)!;

describe("a layout's slug and its first rename", () => {
  test("Add layout, rename to Audio: the slug becomes audio; rename again: it stays", async () => {
    const saved = await store.save([{ id: "n1", name: "Layout 1", order: 0, columnRoles: [], autoNamed: true }]);
    assert.equal(saved[0].slug, "layout-1");
    assert.equal((await rename("n1", "Audio")).slug, "audio");
    const again = await rename("n1", "Audio booth");
    assert.equal(again.slug, "audio");
    assert.equal(again.autoNamed, undefined);
  });

  test("a layout backfilled on load keeps its original slug through a rename", async () => {
    await fs.writeFile(path.join(dir, "servicecue-layouts.json"), JSON.stringify([{ id: "old", name: "Video", order: 5, columnRoles: [] }]));
    await fs.writeFile(path.join(dir, "servicecue-roles.json"), "[]");
    // the store caches what it has read; a fresh process is what a real upgrade is
    const fresh = await import(`./servicecue-layouts-store.js?fresh=${Date.now()}`);
    const loaded = await fresh.serviceCueLayoutsStore.load();
    const old = loaded.find((l: { id: string }) => l.id === "old");
    assert.equal(old.slug, "video");
    assert.equal(old.autoNamed, undefined);
    const saved = await fresh.serviceCueLayoutsStore.save(loaded.map((l: { id: string }) => (l.id === "old" ? { ...l, name: "Video crew" } : l)));
    assert.equal(saved.find((l: { id: string }) => l.id === "old").slug, "video");
  });

  test("typing Layout 7 on an existing layout does not unlock it, and a caller cannot set the flag on a stored layout", async () => {
    await store.save([{ id: "e1", name: "Stage", order: 0, columnRoles: [] }]);
    assert.equal((await rename("e1", "Layout 7")).slug, "stage");
    const forged = (await store.save((await store.load()).map((l) => (l.id === "e1" ? { ...l, name: "Other", autoNamed: true } : l))))
      .find((l) => l.id === "e1")!;
    assert.equal(forged.slug, "stage");
    assert.equal(forged.autoNamed, undefined);
  });

  test("an unchanged name leaves an auto-named layout's slug alone", async () => {
    await store.save([{ id: "n2", name: "Layout 2", order: 0, columnRoles: [], autoNamed: true }]);
    const kept = (await store.save((await store.load()).map((l) => ({ ...l, order: 3 })))).find((l) => l.id === "n2")!;
    assert.equal(kept.slug, "layout-2");
    assert.equal(kept.autoNamed, true);
  });
});
