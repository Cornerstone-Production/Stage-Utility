// The Q-SYS panel block on a View (`View.qsys`), through the real view routes and
// stageController: what PATCH and POST /api/views accept, what they refuse and
// with what message, and that every path that makes a view keeps slugs unique.
//
// The renderer side (the manage page showing the refusal) is in
// renderer/app/qsys/qsys-routes.test.tsx; this is the server guard it relies on.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { describe, it } from "node:test";

import { outputRouteHarness } from "../fixtures/output-routes.js";

const { viewRoutes, callRoute, stageController } = await outputRouteHarness("stage-qsys-panel-block-");
const { sidebarConsolesOf } = await import("../sidebar-arrangement.js");
await import("../views-store.js");
const { restoreCheckFor } = await import("../store-registry.js");
const { findPanelBySlug, parseQsysPanelBlock, slugify, uniqueQsysSlug } = await import("../../types/qsys.js");

type Mutable = { state: { views: View[] } };
const ctl = stageController as unknown as Mutable;

const LAYOUT = { version: 1, canvas: { width: 1920, height: 1080, background: null }, objects: [] };
const panel = (id: string, slug: string, name = `Panel ${id}`) =>
  ({ id, name, kind: "custom", surface: "console", createdAt: "", layout: LAYOUT, qsys: { kind: "volunteer", slug, siblings: [], returnAfterMin: 5 } }) as View;
const consoleView = (id: string, name: string) => ({ id, name, kind: "custom", surface: "console", createdAt: "", layout: LAYOUT }) as View;

function seed(...views: View[]): void {
  ctl.state = { ...ctl.state, views };
}
const view = (id: string) => stageController.getState().views.find((v) => v.id === id);
const patch = (id: string, body: Record<string, unknown>) => callRoute(viewRoutes, `/api/views/${id}`, { method: "PATCH", body });
const errorOf = (r: { json: unknown }) => (r.json as { error?: string }).error ?? "";

async function onDisk(): Promise<View[]> {
  return JSON.parse(await fs.readFile(`${process.env.STAGE_UTILITY_DATA}/views.json`, "utf8")) as View[];
}

describe("the Q-SYS panel block", () => {
  it("PATCH makes a custom console a panel, with siblings and auto-return defaulted, and writes it to disk", async () => {
    seed(consoleView("c1", "Lobby panel"));
    const r = await patch("c1", { qsys: { kind: "volunteer", slug: "lobby" } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(view("c1")?.qsys, { kind: "volunteer", slug: "lobby", siblings: [], returnAfterMin: 5 });
    assert.deepEqual((await onDisk()).find((v) => v.id === "c1")?.qsys, { kind: "volunteer", slug: "lobby", siblings: [], returnAfterMin: 5 });
  });

  it("slugs are unique: saving a duplicate is refused with a message, and nothing beside it lands", async () => {
    seed(panel("p1", "zone-1", "Zone one"), consoleView("c1", "Lobby panel"));
    const r = await patch("c1", { name: "Renamed", qsys: { kind: "staff", slug: "zone-1" } });
    assert.equal(r.status, 400);
    assert.equal(errorOf(r), 'the panel address /qsys/zone-1 is already used by "Zone one"; pick another');
    assert.equal(view("c1")?.qsys, undefined, "the duplicate was saved");
    assert.equal(view("c1")?.name, "Lobby panel", "the rename beside a refused block landed alone");
    // Its own slug again is not a duplicate of itself.
    assert.equal((await patch("p1", { qsys: { kind: "staff", slug: "zone-1", returnAfterMin: 0 } })).status, 200);
    assert.equal(view("p1")?.qsys?.returnAfterMin, 0);
  });

  it("refuses a slug of the wrong shape, the reserved 'manage', and a bad kind or return time", async () => {
    seed(consoleView("c1", "Lobby panel"));
    const bad: unknown[] = [
      { kind: "staff", slug: "Lobby" },
      { kind: "staff", slug: "lobby panel" },
      { kind: "staff", slug: "-lobby" },
      { kind: "staff", slug: "lobby--1" },
      { kind: "staff", slug: "manage" },
      { kind: "staff", slug: "x".repeat(65) },
      { kind: "guest", slug: "lobby" },
      { kind: "staff", slug: "lobby", returnAfterMin: -1 },
      { kind: "staff", slug: "lobby", returnAfterMin: 2.5 },
      { kind: "staff", slug: "lobby", siblings: ["Not A Slug"] },
      { kind: "staff", slug: "lobby", extra: true },
      "lobby",
      [],
    ];
    for (const qsys of bad) {
      const r = await patch("c1", { qsys });
      assert.equal(r.status, 400, `accepted ${JSON.stringify(qsys)}`);
      assert.match(errorOf(r), /qsys/);
    }
    assert.equal(view("c1")?.qsys, undefined);
  });

  it("keeps a sibling that does not exist (the cog list drops it), and drops the panel itself from its siblings", async () => {
    seed(consoleView("c1", "Lobby panel"));
    assert.equal((await patch("c1", { qsys: { kind: "volunteer", slug: "lobby", siblings: ["gone", "lobby", "gone"] } })).status, 200);
    assert.deepEqual(view("c1")?.qsys?.siblings, ["gone"]);
  });

  it("a panel is a custom console: a display, or making a panel a display, is refused", async () => {
    seed({ id: "d1", name: "Wall", kind: "custom", surface: "display", createdAt: "", layout: LAYOUT } as View, panel("p1", "zone-1"));
    const r = await patch("d1", { qsys: { kind: "staff", slug: "wall" } });
    assert.equal(r.status, 400);
    assert.match(errorOf(r), /not a custom console/);
    const back = await patch("p1", { surface: "display" });
    assert.equal(back.status, 400);
    assert.match(errorOf(back), /is a Q-SYS panel/);
    assert.equal(view("p1")?.surface, "console");
    // Both at once is allowed: the block goes first.
    assert.equal((await patch("p1", { surface: "display", qsys: null })).status, 200);
    assert.equal(view("p1")?.qsys, undefined);
    assert.equal(view("p1")?.surface, "display");
  });

  it("every way of changing a view's surface or kind keeps a panel a custom console", async () => {
    seed(panel("p1", "zone-1"));
    const role = await callRoute(viewRoutes, "/api/views/p1/surface", { method: "POST", body: { surface: "display" } });
    assert.equal(role.status, 400, JSON.stringify(role.json));
    assert.match(errorOf(role), /is a Q-SYS panel/);
    const kind = await patch("p1", { kind: "calendar" });
    assert.equal(kind.status, 400);
    assert.match(errorOf(kind), /is a Q-SYS panel/);
    // The writers themselves, not only the routes' up-front checks.
    await assert.rejects(() => stageController.setViewSurface("p1", "display", { screensConfirmed: true }), /is a Q-SYS panel/);
    await assert.rejects(() => stageController.setViewKind("p1", "calendar"), /is a Q-SYS panel/);
    assert.equal(view("p1")?.surface, "console");
    assert.equal(view("p1")?.kind, "custom");
  });

  it("Home cannot be a panel", async () => {
    seed({ id: "home", name: "Home", kind: "custom", surface: "console", createdAt: "", layout: LAYOUT } as View);
    const r = await patch("home", { qsys: { kind: "staff", slug: "home-panel" } });
    assert.equal(r.status, 400);
    assert.match(errorOf(r), /Home cannot be a Q-SYS panel/);
  });

  it("qsys: null makes it an ordinary console again", async () => {
    seed(panel("p1", "zone-1"));
    assert.equal((await patch("p1", { qsys: null })).status, 200);
    assert.equal(view("p1")?.qsys, undefined);
    assert.equal((await onDisk()).find((v) => v.id === "p1")?.qsys, undefined);
  });

  it("POST /api/views makes a panel in one write, and refuses a taken slug having made nothing", async () => {
    seed(panel("p1", "zone-1"));
    const made = await callRoute(viewRoutes, "/api/views", { method: "POST", body: { name: "Lobby", kind: "custom", surface: "console", qsys: { kind: "volunteer", slug: "lobby" } } });
    assert.equal(made.status, 201, JSON.stringify(made.json));
    const created = findPanelBySlug(stageController.getState().views, "lobby");
    assert.equal(created?.name, "Lobby");
    assert.equal(created?.surface, "console");
    const before = stageController.getState().views.length;
    const clash = await callRoute(viewRoutes, "/api/views", { method: "POST", body: { name: "Again", kind: "custom", surface: "console", qsys: { kind: "staff", slug: "zone-1" } } });
    assert.equal(clash.status, 400);
    assert.match(errorOf(clash), /\/qsys\/zone-1 is already used/);
    assert.equal(stageController.getState().views.length, before, "a view was made anyway");
  });

  it("a duplicated panel gets an address of its own", async () => {
    seed(panel("p1", "zone-1"), panel("p2", "zone-1-2"));
    const { view: copy } = await stageController.duplicateView("p1");
    assert.equal(copy.qsys?.slug, "zone-1-3");
    assert.equal(view("p1")?.qsys?.slug, "zone-1");
  });

  it("a duplicate's address is checked again after its boards are copied: a panel saved meanwhile keeps its own", async () => {
    seed(panel("p1", "zone-1"));
    const c = stageController as unknown as { giveCopyItsOwnBoards: (v: View) => Promise<View> };
    const real = c.giveCopyItsOwnBoards;
    c.giveCopyItsOwnBoards = async (v: View) => {
      // Another save lands while the copy waits on its boards.
      ctl.state = { ...ctl.state, views: [...ctl.state.views, panel("p9", "zone-1-2")] };
      return real.call(stageController, v);
    };
    try {
      const { view: copy } = await stageController.duplicateView("p1");
      assert.equal(copy.qsys?.slug, "zone-1-3", "the copy took an address saved while it waited");
    } finally {
      c.giveCopyItsOwnBoards = real;
    }
  });

  it("a Q-SYS panel is not among the sidebar's consoles; an ordinary console still is", () => {
    const consoles = sidebarConsolesOf([panel("p1", "zone-1"), consoleView("c1", "Booth")]);
    assert.deepEqual(consoles.all, ["console:c1"]);
  });

  it("the restore check never refuses a backup over panel addresses or a null block; it still refuses a malformed block", async () => {
    // The repair happens on the load after the restore: qsys-slug-repair-restore.test.ts.
    const check = restoreCheckFor("views.json")!;
    assert.equal((await check([panel("p1", "zone-1"), panel("p2", "zone-1")])).ok, true, "two panels at one address refused a backup");
    assert.equal((await check([{ ...consoleView("c1", "Booth"), qsys: null } as unknown as View])).ok, true, "qsys: null refused");
    const bad = await check([{ ...consoleView("c1", "Booth"), qsys: { kind: "guest", slug: "x" } } as unknown as View]);
    assert.equal(bad.ok, false, "a malformed block got through (positive control)");
  });

  it("slugify and uniqueQsysSlug make legal, free slugs", () => {
    assert.equal(slugify("Zone 1 (Main)"), "zone-1-main");
    assert.equal(slugify("Café Room"), "cafe-room");
    assert.equal(slugify("!!!"), "panel");
    assert.equal(slugify("Manage"), "manage-panel");
    assert.equal(uniqueQsysSlug("zone-1", new Set(["zone-1", "zone-1-2"])), "zone-1-3");
    for (const name of ["Zone 1 (Main)", "!!!", "Manage", "a".repeat(100)]) {
      assert.ok("block" in parseQsysPanelBlock({ kind: "staff", slug: slugify(name) }), `slugify(${JSON.stringify(name)}) is not a legal slug`);
    }
  });
});
