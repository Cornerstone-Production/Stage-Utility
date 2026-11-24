// The Q-SYS panel block on a View (`View.qsys`), through the real view routes and
// stageController: what PATCH and POST /api/views accept, what they refuse and
// with what message, and that every path that makes a view keeps slugs unique.
//
// The renderer side (the manage page showing the refusal) is in
// renderer/app/qsys/qsys-routes.test.tsx; this is the server guard it relies on.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { describe, it, mock } from "node:test";

import { outputRouteHarness } from "../fixtures/output-routes.js";

const { viewRoutes, callRoute, stageController } = await outputRouteHarness("stage-qsys-panel-block-");
const { resolveSidebar, sidebarConsolesOf } = await import("../sidebar-arrangement.js");
await import("../views-store.js");
const { restoreCheckFor } = await import("../store-registry.js");
const { findPanelBySlug, parseQsysPanelBlock, qsysSlugFromName, uniqueQsysSlug } = await import("../../types/qsys.js");
const { slugify: serviceCueSlugify } = await import("../servicecue-slug.js");

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

  it("restoring settings kept aside makes the view a panel and takes them off the kept-aside list", async () => {
    const kept = { kind: "volunteer", slug: "zone-1" };
    const other = { kind: "staff", slug: "Bad Slug" };
    seed({ ...consoleView("c1", "Lobby panel"), qsysInactive: [other, kept] } as View);
    const r = await patch("c1", { qsys: { kind: "volunteer", slug: "zone-1", siblings: [], returnAfterMin: 5 } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(view("c1")?.qsys?.slug, "zone-1");
    assert.deepEqual(view("c1")?.qsysInactive, [other], "the restored block stayed on the list, or the other one went");
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

  it("a console's place in the sidebar survives its time as a panel, and a save made meanwhile", async () => {
    seed(consoleView("c1", "Booth"), consoleView("c2", "Stage"), consoleView("p1", "Lobby"));
    const order = () => resolveSidebar(stageController.getState().sidebar, sidebarConsolesOf(stageController.getState().views)).sections.find((x) => x.kind === "consoles")!.members;
    const withConsoles = (members: string[]) => ({ sections: [{ id: "consoles", label: "Consoles", kind: "consoles" as const, members }], hidden: [] });
    await stageController.setSidebar(withConsoles(["console:c2", "console:p1", "console:c1"]));
    assert.equal((await patch("p1", { qsys: { kind: "staff", slug: "lobby" } })).status, 200);
    assert.deepEqual(order(), ["console:c2", "console:c1"], "a panel is drawn among the consoles");
    // What a page saves now: the consoles it draws, which leaves the panel out.
    await stageController.setSidebar(withConsoles(["console:c2", "console:c1"]));
    assert.equal((await patch("p1", { qsys: null })).status, 200);
    assert.deepEqual(order(), ["console:c2", "console:p1", "console:c1"], "the console's place was lost while it was a panel");
  });

  it("a Q-SYS panel is not among the sidebar's consoles; an ordinary console still is", () => {
    const consoles = sidebarConsolesOf([panel("p1", "zone-1"), consoleView("c1", "Booth")]);
    assert.deepEqual(consoles.all, ["console:c1"]);
    assert.deepEqual([...(consoles.held ?? [])], ["console:p1"]);
  });

  it("the restore check never refuses a backup over panel addresses, a null block, or a block it cannot read", async () => {
    // The repair happens on the load after the restore: qsys-slug-repair-restore.test.ts.
    const check = restoreCheckFor("views.json")!;
    assert.equal((await check([panel("p1", "zone-1"), panel("p2", "zone-1")])).ok, true, "two panels at one address refused a backup");
    assert.equal((await check([{ ...consoleView("c1", "Booth"), qsys: null } as unknown as View])).ok, true, "qsys: null refused");
    const bad = await check([{ ...consoleView("c1", "Booth"), qsys: { kind: "guest", slug: "Foyer Main" }, qsysInactive: "not a list" } as unknown as View]);
    assert.equal(bad.ok, true, "a block the parser refuses refused the whole backup");
  });

  it("qsysSlugFromName and uniqueQsysSlug make legal, free slugs", () => {
    assert.equal(qsysSlugFromName("Zone 1 (Main)"), "zone-1-main");
    assert.equal(qsysSlugFromName("Café Room"), "cafe-room");
    assert.equal(qsysSlugFromName("!!!"), "panel");
    assert.equal(qsysSlugFromName("Manage"), "manage-panel");
    assert.equal(uniqueQsysSlug("zone-1", new Set(["zone-1", "zone-1-2"])), "zone-1-3");
    for (const name of ["Zone 1 (Main)", "!!!", "Manage", "a".repeat(100)]) {
      assert.ok("block" in parseQsysPanelBlock({ kind: "staff", slug: qsysSlugFromName(name) }), `qsysSlugFromName(${JSON.stringify(name)}) is not a legal slug`);
    }
  });

  it("ServiceCue's slugify, which shares the core, still gives every address it gave before", () => {
    // The rule as it was written before the core was shared: addresses pinned on
    // tablets and displays were built by exactly this.
    const before = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";
    for (const name of ["The Gathering", "  Main Room  ", "Звук", "!!!", "", "Café", "a--b", "-x-", "Audio", "MIXED case 12", "tab\tand\nnewline"]) {
      assert.equal(serviceCueSlugify(name), before(name), JSON.stringify(name));
    }
    assert.equal(serviceCueSlugify("Café"), "caf", "ServiceCue's slugs are not accent-folded; changing that would move pinned addresses");
  });
});

describe("renaming a panel's address", () => {
  it("keeps the old address as an alias that leads to it, and other panels' cog menus follow, in one save", async () => {
    seed(panel("p1", "zone-1", "Zone one"), { ...panel("p2", "side"), qsys: { kind: "volunteer", slug: "side", siblings: ["zone-1", "gone"], returnAfterMin: 5 } } as View, panel("p3", "back"));
    const lines: string[] = [];
    const log = mock.method(console, "log", (...a: unknown[]) => void lines.push(a.join(" ")));
    let r;
    try {
      r = await patch("p1", { qsys: { kind: "volunteer", slug: "front", siblings: [], returnAfterMin: 5 } });
    } finally {
      log.mock.restore();
    }
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(view("p1")?.qsys, { kind: "volunteer", slug: "front", siblings: [], returnAfterMin: 5, aliases: ["zone-1"] });
    assert.deepEqual(view("p2")?.qsys?.siblings, ["front", "gone"], "another panel's cog menu lost the renamed panel");
    assert.deepEqual(view("p3")?.qsys, panel("p3", "back").qsys, "a panel that did not list it was touched");
    assert.equal(findPanelBySlug(stageController.getState().views, "zone-1")?.id, "p1", "the old address leads nowhere");
    const disk = await onDisk();
    assert.deepEqual(disk.find((v) => v.id === "p2")?.qsys?.siblings, ["front", "gone"], "the sibling rewrite was not saved with the rename");
    assert.ok(lines.some((l) => l.includes('[qsys] panel "Zone one" moved from /qsys/zone-1 to /qsys/front') && l.includes("1 other panel(s)")), lines.join("\n"));
  });

  it("an old address is taken: no other panel, new view or copy may have it", async () => {
    seed({ ...panel("p1", "front", "Zone one"), qsys: { kind: "volunteer", slug: "front", siblings: [], returnAfterMin: 5, aliases: ["zone-1"] } } as View, consoleView("c1", "Booth"));
    const r = await patch("c1", { qsys: { kind: "staff", slug: "zone-1" } });
    assert.equal(r.status, 400);
    assert.match(errorOf(r), /\/qsys\/zone-1 is already used by "Zone one" \(it was that panel's address before a rename/);
    const made = await callRoute(viewRoutes, "/api/views", { method: "POST", body: { name: "New", kind: "custom", surface: "console", qsys: { kind: "staff", slug: "zone-1" } } });
    assert.equal(made.status, 400, "a new panel took an old address");
    const { view: copy } = await stageController.duplicateView("p1");
    assert.equal(copy.qsys?.slug, "front-2");
    assert.equal(copy.qsys?.aliases, undefined, "a copy took the original's old addresses");
  });

  it("a request's aliases are ignored: the server keeps them; a rename back reclaims the old address", async () => {
    seed(panel("p1", "a"));
    assert.equal((await patch("p1", { qsys: { kind: "volunteer", slug: "b", aliases: ["stolen"] } })).status, 200);
    assert.deepEqual(view("p1")?.qsys?.aliases, ["a"], "a request named its own aliases");
    assert.equal((await patch("p1", { qsys: { kind: "volunteer", slug: "a" } })).status, 200);
    assert.equal(view("p1")?.qsys?.slug, "a");
    assert.deepEqual(view("p1")?.qsys?.aliases, ["b"], "a -> b -> a lost or doubled an address");
    // A save that keeps the slug keeps the aliases as they are.
    assert.equal((await patch("p1", { qsys: { kind: "staff", slug: "a", returnAfterMin: 0 } })).status, 200);
    assert.deepEqual(view("p1")?.qsys?.aliases, ["b"]);
  });

  it("past twenty old addresses the oldest is forgotten, and the log says which", async () => {
    seed({ ...panel("p1", "s0"), qsys: { kind: "volunteer", slug: "s20", siblings: [], returnAfterMin: 5, aliases: Array.from({ length: 20 }, (_, i) => `s${i}`) } } as View);
    const lines: string[] = [];
    const log = mock.method(console, "log", (...a: unknown[]) => void lines.push(a.join(" ")));
    try {
      assert.equal((await patch("p1", { qsys: { kind: "volunteer", slug: "s21" } })).status, 200);
    } finally {
      log.mock.restore();
    }
    const aliases = view("p1")?.qsys?.aliases ?? [];
    assert.equal(aliases.length, 20);
    assert.equal(aliases[0], "s1");
    assert.equal(aliases.at(-1), "s20");
    assert.ok(lines.some((l) => l.includes("/qsys/s0 no longer lead")), lines.join("\n"));
  });
});

describe("panel settings kept aside", () => {
  it("restoring one onto a view that is a panel now keeps the live block aside first, whole, and logs it", async () => {
    const kept = { kind: "volunteer", slug: "zone-b", siblings: ["x"], returnAfterMin: 3 };
    seed({ ...panel("c1", "zone-a", "Lobby"), qsys: { kind: "staff", slug: "zone-a", siblings: ["y"], returnAfterMin: 9, aliases: ["old-a"] }, qsysInactive: [kept] } as View);
    const lines: string[] = [];
    const log = mock.method(console, "log", (...a: unknown[]) => void lines.push(a.join(" ")));
    let r;
    try {
      r = await patch("c1", { qsys: kept });
    } finally {
      log.mock.restore();
    }
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(view("c1")?.qsys?.slug, "zone-b");
    assert.deepEqual(view("c1")?.qsysInactive, [{ kind: "staff", slug: "zone-a", siblings: ["y"], returnAfterMin: 9, aliases: ["old-a"] }], "the live block was dropped, not kept aside");
    assert.ok(lines.some((l) => l.includes('[qsys] "Lobby": its panel settings for /qsys/zone-a were kept aside')), lines.join("\n"));
    assert.deepEqual((await onDisk()).find((v) => v.id === "c1")?.qsysInactive?.length, 1);
  });

  it("a restored block keeps its own old addresses, less any another panel has taken since", async () => {
    const kept = { kind: "volunteer", slug: "zone-b", siblings: [], returnAfterMin: 5, aliases: ["mine", "taken"] };
    seed({ ...consoleView("c1", "Lobby"), qsysInactive: [kept] } as View, panel("p2", "taken"));
    assert.equal((await patch("c1", { qsys: kept })).status, 200);
    assert.deepEqual(view("c1")?.qsys?.aliases, ["mine"]);
  });

  it("dismiss forgets one entry, matched whole (an unreadable one too), logs it, and 404s when it is not there", async () => {
    const unreadable = { kind: "guest", slug: "Foyer Main" };
    const other = { kind: "staff", slug: "zone-1" };
    seed({ ...consoleView("c1", "Booth"), qsysInactive: [other, unreadable] } as View);
    const lines: string[] = [];
    const log = mock.method(console, "log", (...a: unknown[]) => void lines.push(a.join(" ")));
    let r;
    try {
      r = await callRoute(viewRoutes, "/api/views/c1/qsys-inactive/dismiss", { method: "POST", body: { entry: unreadable } });
    } finally {
      log.mock.restore();
    }
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(view("c1")?.qsysInactive, [other], "the wrong entry went, or none did");
    assert.ok(lines.some((l) => l.includes("kept-aside panel settings dismissed by the operator") && l.includes("Foyer Main")), lines.join("\n"));
    const again = await callRoute(viewRoutes, "/api/views/c1/qsys-inactive/dismiss", { method: "POST", body: { entry: unreadable } });
    assert.equal(again.status, 404);
    assert.deepEqual(view("c1")?.qsysInactive, [other]);
    assert.equal((await callRoute(viewRoutes, "/api/views/c1/qsys-inactive/dismiss", { method: "POST", body: { entry: other } })).status, 200);
    assert.equal(view("c1")?.qsysInactive, undefined, "an empty list was left behind");
    assert.equal((await callRoute(viewRoutes, "/api/views/nope/qsys-inactive/dismiss", { method: "POST", body: { entry: other } })).status, 404);
    assert.equal((await callRoute(viewRoutes, "/api/views/c1/qsys-inactive/dismiss", { method: "POST", body: {} })).status, 400);
  });

  it("a dismissed entry as large as an import allows is logged whole, the log's copy being the only one left", async () => {
    const big = { kind: "staff", slug: "zone-1", note: "x".repeat(3900) };
    seed({ ...consoleView("c1", "Booth"), qsysInactive: [big] } as View);
    const lines: string[] = [];
    const log = mock.method(console, "log", (...a: unknown[]) => void lines.push(a.join(" ")));
    try {
      assert.equal((await callRoute(viewRoutes, "/api/views/c1/qsys-inactive/dismiss", { method: "POST", body: { entry: big } })).status, 200);
    } finally {
      log.mock.restore();
    }
    assert.ok(lines.some((l) => l.endsWith(JSON.stringify(big))), "the log line cut the dismissed settings short");
  });

  it("POST /api/views reads qsys: null as no block, as PATCH does", async () => {
    seed();
    const made = await callRoute(viewRoutes, "/api/views", { method: "POST", body: { name: "Plain", kind: "custom", surface: "console", qsys: null } });
    assert.equal(made.status, 201, JSON.stringify(made.json));
    const v = stageController.getState().views.find((x) => x.name === "Plain");
    assert.ok(v && v.qsys === undefined);
  });
});
