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

  it("restores, and the load after it gives the later duplicate a suffix and drops a block a display cannot carry", async () => {
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
    assert.equal("qsys" in loaded.find((v) => v.id === "c1")!, false, "qsys: null was kept");
    assert.deepEqual(lines, [
      '[qsys] views.json: "Zone 1 copy" (p2) shared /qsys/zone-1 with an earlier panel; it opens at /qsys/zone-1-3 now',
      '[qsys] views.json: "Lobby wall" (d1) had panel settings for /qsys/lobby but is not a custom console; it is an ordinary view now',
    ]);
    const r = await callRoute(qsysRoutes, "/api/qsys/panel-repairs");
    assert.deepEqual(r.json, [
      { viewId: "p2", name: "Zone 1 copy", from: "zone-1", to: "zone-1-3", why: "shared" },
      { viewId: "d1", name: "Lobby wall", from: "lobby", to: null, why: "not-a-console" },
    ]);
  });

  it("a file that needs nothing is handed back as it is, and reports nothing", () => {
    const views = [panel("p1", "Zone 1", "zone-1"), panel("p2", "Booth", "booth")];
    assert.equal(repairQsysBlocks(views), views);
  });
});
