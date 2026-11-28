// A backup whose views put two Q-SYS panels at one address, or panel settings on a
// view that cannot be a panel, restores. The load after it repairs the blocks, says
// so on [qsys] lines and on GET /api/qsys/panel-repairs (what /qsys/manage shows).
//
// Through the real restore (configSnapshot.apply) and a cold load of what it wrote,
// as the restart a real restore triggers. Every id and name is invented.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it, mock } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-qsys-slug-repair-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { configSnapshot } = await import("../config-snapshot.js");
const { viewsStore } = await import("../views-store.js");
const { qsysRoutes } = await import("../routes/qsys-routes.js");
const { callRoute } = await import("../routes/route-harness.js");
const { repairQsysBlocks } = await import("./qsys-slug-repair.js");

const NOW = "2026-01-01T00:00:00.000Z";
const layout = { version: 1, canvas: { width: 1920, height: 1080, background: null }, objects: [] };
const block = (slug: string) => ({ kind: "volunteer", slug, siblings: [], returnAfterMin: 5 });
const panel = (id: string, name: string, slug: string) => ({ id, name, kind: "custom", surface: "console", createdAt: NOW, layout, qsys: block(slug) });

describe("restoring views with Q-SYS panel blocks that do not hold", () => {
  after(async () => {
    await fs.rm(TMP, { recursive: true, force: true });
  });

  it("restores, and the load after it gives the later duplicate a suffix and keeps aside, whole, a block a display cannot carry", async () => {
    const views = [
      panel("p1", "Zone 1", "zone-1"),
      panel("p2", "Zone 1 copy", "zone-1"),
      // Holds zone-1-2 in the file: the duplicate's suffix must not take it.
      panel("p3", "Side", "zone-1-2"),
      { id: "d1", name: "Lobby wall", kind: "custom", surface: "display", createdAt: NOW, layout, qsys: block("lobby") },
      { id: "c1", name: "Booth", kind: "custom", surface: "console", createdAt: NOW, layout, qsys: null },
    ];
    await configSnapshot.apply({ kind: "stage-utility-config", version: 1, createdAt: NOW, files: { "views.json": views } });
    const onDisk = JSON.parse(await fs.readFile(path.join(TMP, "views.json"), "utf8")) as { id: string }[];
    assert.deepEqual(onDisk.map((v) => v.id), ["p1", "p2", "p3", "d1", "c1"], "the restore did not write the backup's views");

    const lines: string[] = [];
    const warn = mock.method(console, "warn", (...a: unknown[]) => void lines.push(a.join(" ")));
    let loaded: { id: string; qsys?: { slug: string } | null }[];
    try {
      loaded = (await viewsStore.reload()) as typeof loaded;
    } finally {
      warn.mock.restore();
    }
    const slugOf = (id: string) => loaded.find((v) => v.id === id)?.qsys?.slug ?? null;
    assert.equal(slugOf("p1"), "zone-1", "the first panel lost its address");
    assert.equal(slugOf("p2"), "zone-1-3");
    assert.equal(slugOf("p3"), "zone-1-2", "a panel's own address was given to a duplicate");
    assert.equal(slugOf("d1"), null, "a display kept panel settings");
    const d1 = loaded.find((v) => v.id === "d1") as unknown as { qsysInactive?: unknown[] };
    assert.deepEqual(d1.qsysInactive, [block("lobby")], "the display's panel settings were lost, not kept aside");
    assert.equal("qsys" in loaded.find((v) => v.id === "c1")!, false, "qsys: null was kept");
    assert.deepEqual(lines, [
      '[qsys] views.json: "Zone 1 copy" (p2) shared /qsys/zone-1 with an earlier panel; it opens at /qsys/zone-1-3 now',
      `[qsys] views.json: "Lobby wall" (d1) had panel settings for /qsys/lobby but is not a custom console; kept aside, not a panel: ${JSON.stringify(block("lobby"))}`,
    ]);
    // The next save of the views writes the repair, the settings kept aside with it.
    await viewsStore.save(loaded as never);
    const saved = JSON.parse(await fs.readFile(path.join(TMP, "views.json"), "utf8")) as { id: string; qsysInactive?: unknown[]; qsys?: { slug: string } }[];
    assert.deepEqual(saved.find((v) => v.id === "d1")?.qsysInactive, [block("lobby")], "a save after the repair lost the kept-aside settings");
    assert.equal(saved.find((v) => v.id === "p2")?.qsys?.slug, "zone-1-3");
    const r = await callRoute(qsysRoutes, "/api/qsys/panel-repairs");
    assert.deepEqual(r.json, [
      { viewId: "p2", name: "Zone 1 copy", from: "zone-1", to: "zone-1-3", why: "shared" },
      { viewId: "d1", name: "Lobby wall", from: "lobby", to: null, why: "not-a-console" },
    ]);
  });

  it("a hand-edited file with a malformed panel slug loads: the block is kept aside whole and logged", async () => {
    const odd = { kind: "staff", slug: "Not A Slug!", siblings: [], returnAfterMin: 5 };
    const noSlug = { kind: "volunteer" };
    await fs.writeFile(
      path.join(TMP, "views.json"),
      JSON.stringify([
        { id: "p1", name: "Zone 1", kind: "custom", surface: "console", createdAt: NOW, layout, qsys: odd },
        { id: "p2", name: "Booth", kind: "custom", surface: "console", createdAt: NOW, layout, qsys: noSlug },
        panel("p3", "Side", "side"),
      ]),
    );
    const lines: string[] = [];
    const warn = mock.method(console, "warn", (...a: unknown[]) => void lines.push(a.join(" ")));
    let loaded: { id: string; qsys?: unknown; qsysInactive?: unknown[] }[];
    try {
      loaded = (await viewsStore.reload()) as typeof loaded;
    } finally {
      warn.mock.restore();
    }
    const v = (id: string) => loaded.find((x) => x.id === id)!;
    assert.equal(v("p1").qsys, undefined);
    assert.deepEqual(v("p1").qsysInactive, [odd]);
    assert.deepEqual(v("p2").qsysInactive, [noSlug]);
    assert.equal((v("p3").qsys as { slug: string }).slug, "side", "a good panel was touched");
    assert.equal(lines.length, 2);
    assert.ok(lines[0].includes(JSON.stringify(odd)), `the whole block is not on the line: ${lines[0]}`);
    assert.ok(lines[0].startsWith('[qsys] views.json: "Zone 1" (p1) has panel settings this app cannot read'));
    await viewsStore.save(loaded as never);
    const saved = JSON.parse(await fs.readFile(path.join(TMP, "views.json"), "utf8")) as { id: string; qsysInactive?: unknown[] }[];
    assert.deepEqual(saved.find((x) => x.id === "p1")?.qsysInactive, [odd], "a save after the repair lost the settings");
  });

  it("a backup taken while a block it cannot read is kept aside (not yet saved) restores, and the load keeps it aside again", async () => {
    // A block from a newer build (a field this one does not have) or a hand edit.
    const odd = { kind: "volunteer", slug: "Foyer Main", siblings: [], returnAfterMin: 5, fromLater: true };
    await fs.writeFile(path.join(TMP, "views.json"), JSON.stringify([{ id: "b1", name: "Booth", kind: "custom", surface: "console", createdAt: NOW, layout, qsys: odd }]));
    const warn = mock.method(console, "warn", () => {});
    const log = mock.method(console, "log", () => {});
    try {
      await viewsStore.reload();
      // A backup reads views.json raw: the block is still in it, as the operator had it.
      const backup = await configSnapshot.build();
      assert.deepEqual((backup.files["views.json"] as { qsys?: unknown }[])[0].qsys, odd, "the backup did not carry the block");
      await configSnapshot.apply(backup);
      const loaded = (await viewsStore.reload()) as unknown as { qsys?: unknown; qsysInactive?: unknown[] }[];
      assert.equal(loaded[0].qsys, undefined);
      assert.deepEqual(loaded[0].qsysInactive, [odd], "the restored block was lost, not kept aside");
    } finally {
      warn.mock.restore();
      log.mock.restore();
    }
  });

  it("kept-aside settings that are not a list are wrapped, never replaced", () => {
    const warn = mock.method(console, "warn", () => {});
    try {
      const [onlyOdd, withBlock] = repairQsysBlocks([
        { id: "c1", name: "Booth", kind: "custom", surface: "console", createdAt: NOW, layout, qsysInactive: "hand edit" },
        { id: "d1", name: "Wall", kind: "custom", surface: "display", createdAt: NOW, layout, qsysInactive: { kind: "staff" }, qsys: block("wall") },
      ] as never[]) as unknown as { qsysInactive?: unknown[] }[];
      assert.deepEqual(onlyOdd.qsysInactive, ["hand edit"]);
      assert.deepEqual(withBlock.qsysInactive, [{ kind: "staff" }, block("wall")], "the old value was lost when a block was set aside");
    } finally {
      warn.mock.restore();
    }
  });

  it("an old address another panel now has, or an earlier panel already keeps, is no longer kept; the panel is untouched", () => {
    const warn = mock.method(console, "warn", () => {});
    try {
      const out = repairQsysBlocks([
        { ...panel("p1", "One", "a"), qsys: { ...block("a"), aliases: ["b", "keep"] } },
        panel("p2", "Two", "b"),
        { ...panel("p3", "Three", "c"), qsys: { ...block("c"), aliases: ["keep", "own"] } },
      ] as never[]) as unknown as { qsys: { slug: string; aliases?: string[] } }[];
      assert.deepEqual(out.map((v) => [v.qsys.slug, v.qsys.aliases ?? null]), [["a", ["keep"]], ["b", null], ["c", ["own"]]]);
    } finally {
      warn.mock.restore();
    }
  });

  it("repairs stay listed for /qsys/manage after a later load finds nothing more to do", async () => {
    const before = (await callRoute(qsysRoutes, "/api/qsys/panel-repairs")).json as unknown[];
    assert.ok(before.length > 0, "no repairs from the tests above (positive control)");
    await fs.writeFile(path.join(TMP, "views.json"), JSON.stringify([panel("p1", "Zone 1", "zone-1")]));
    await viewsStore.reload();
    assert.deepEqual((await callRoute(qsysRoutes, "/api/qsys/panel-repairs")).json, before, "a clean reload emptied the repairs");
  });

  it("a file that needs nothing is handed back as it is, and reports nothing", () => {
    const views = [panel("p1", "Zone 1", "zone-1"), panel("p2", "Booth", "booth")];
    assert.equal(repairQsysBlocks(views), views);
  });
});
