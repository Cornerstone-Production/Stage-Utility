// A screen's role comes from its view; an older build stored one on the screen.
// This boots the real controller over store files written the way that build wrote
// them, and reads what comes out: in memory, on disk, in the log, and in what
// GET /api/outputs would send.
//
// Through the real load path because the migration is only worth anything if the
// load runs it: a pure function nothing calls repairs nothing. The property under
// test is the one nothing else would notice, that a screen which was read-only
// before the upgrade is read-only after it. "Live" is judged by the one function
// every reader uses, against the views as they are afterwards.
//
// Every id and name is invented.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-screen-roles-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { stageController } = await import("./stage-controller.js");
const { screenIsControlSurface, viewSurface } = await import("../types/views.js");

const ctl = stageController as unknown as {
  broadcast: () => void;
  recomputeResolved: () => void;
  startUpdateChecks: () => void;
};
ctl.broadcast = () => {};
ctl.recomputeResolved = () => {};
ctl.startUpdateChecks = () => {};

const NOW = "2026-01-01T00:00:00.000Z";
const layout = (id: string) => ({
  version: 1,
  canvas: { width: 1920, height: 1080, background: null },
  objects: [{ id: `${id}-clock`, x: 0, y: 0, w: 10, h: 10, z: 0, config: { type: "clock" } }],
});
const custom = (id: string, name: string, surface: "display" | "console", fit?: string) => ({
  id, name, kind: "custom", surface, createdAt: NOW,
  layout: fit ? { ...layout(id), canvas: { ...layout(id).canvas, fit } } : layout(id),
});

// What the stored files looked like when a screen had a role of its own.
const STORED_VIEWS = [
  custom("wall-solo", "Lobby loop", "display"),
  custom("wall-shared", "Hallway loop", "display"),
  custom("wall-mixed", "Atrium loop", "display", "responsive"),
  custom("ctl-a", "Booth controls", "console"),
  { id: "cal", name: "Week ahead", kind: "calendar", surface: "display", createdAt: NOW },
  { id: "mics", name: "Mic board", kind: "slots", surface: "display", createdAt: NOW },
  { id: "home", name: "Home", kind: "custom", surface: "console", createdAt: NOW, layout: layout("home") },
  // Older than the surface field: a button on it, and no surface decided yet.
  {
    id: "old-pad", name: "Old pad", kind: "custom", createdAt: NOW,
    layout: { ...layout("old-pad"), objects: [{ id: "old-pad-btn", x: 0, y: 0, w: 10, h: 10, z: 0, config: { type: "osc-button" } }] },
  },
];

// `live` is what the screen did before: only an explicit "panel" had working buttons.
const STORED_SCREENS: { id: string; viewId: string | null; mode?: string; live: boolean; expect: boolean }[] = [
  { id: "display-1", viewId: "wall-solo", mode: "panel", live: true, expect: true },
  { id: "display-2", viewId: "wall-shared", mode: "panel", live: true, expect: true },
  { id: "display-3", viewId: "wall-shared", mode: "panel", live: true, expect: true },
  { id: "display-4", viewId: "wall-mixed", mode: "panel", live: true, expect: true },
  { id: "display-5", viewId: "wall-mixed", mode: "display", live: false, expect: false },
  { id: "display-6", viewId: "ctl-a", mode: "panel", live: true, expect: true },
  { id: "display-7", viewId: "ctl-a", mode: "display", live: false, expect: false },
  { id: "display-8", viewId: "ctl-a", live: false, expect: false },
  { id: "display-9", viewId: "wall-solo", mode: "display", live: false, expect: false },
  { id: "display-10", viewId: null, mode: "panel", live: true, expect: false },
  { id: "display-11", viewId: "cal", mode: "panel", live: true, expect: true },
  { id: "display-12", viewId: "gone", mode: "display", live: false, expect: false },
  // Never stored a role, and showed a view the surface migration makes a console:
  // its buttons worked, because that migration marked it live.
  { id: "display-13", viewId: "old-pad", live: true, expect: true },
  // Live on a slot board: nothing on it to operate, so only the role goes.
  { id: "display-14", viewId: "mics", mode: "panel", live: true, expect: false },
];

const lines: string[] = [];
const realLog = console.log;

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(path.join(TMP, file), "utf8"));
}

describe("the first boot after the upgrade", () => {
  before(async () => {
    await fs.writeFile(
      path.join(TMP, "settings.json"),
      JSON.stringify({
        appName: "Stage Utility",
        // Both earlier passes have run: only the one under test is outstanding.
        layoutDefaultsCleaned: true,
        cardHairlineRaised: true,
        outputs: STORED_SCREENS.map(({ id, viewId, mode }) => ({ id, name: `Screen ${id}`, viewId, ...(mode ? { mode } : {}) })),
      }),
      "utf8",
    );
    await fs.writeFile(path.join(TMP, "views.json"), JSON.stringify(STORED_VIEWS), "utf8");
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    try {
      await stageController.init();
    } finally {
      console.log = realLog;
    }
  });
  after(async () => {
    await fs.rm(TMP, { recursive: true, force: true });
  });

  const state = () => stageController.getState();
  const screen = (id: string) => state().outputs.find((o) => o.id === id)!;

  it("no screen is live that was read-only, and every screen whose buttons worked still works", () => {
    for (const s of STORED_SCREENS) {
      const now = screenIsControlSurface(screen(s.id), state().views);
      if (!s.live) assert.equal(now, false, `${s.id} was read-only and is live now`);
      assert.equal(now, s.expect, `${s.id}`);
    }
  });

  it("no screen carries a stored role, in memory or in settings.json", async () => {
    assert.deepEqual(state().outputs.filter((o) => "mode" in o).map((o) => o.id), []);
    const disk = ((await readJson("settings.json")) as { outputs: Record<string, unknown>[] }).outputs;
    assert.deepEqual(disk.filter((o) => "mode" in o).map((o) => o.id), [], "settings.json still carries a role");
    assert.equal(((await readJson("settings.json")) as { screenRolesFromView?: boolean }).screenRolesFromView, true);
  });

  it("what the outputs API sends carries no mode", () => {
    for (const o of stageController.getOutputs()) assert.equal("mode" in o, false, `${o.id} would send a mode`);
  });

  it("a view only live screens showed becomes a control surface, with no copy; one a read-only screen shares does not", () => {
    assert.equal(viewSurface(state().views.find((v) => v.id === "wall-solo")!), "display", "read-only display-9 also shows it");
    assert.equal(viewSurface(state().views.find((v) => v.id === "wall-shared")!), "console");
    assert.equal(screen("display-2").viewId, "wall-shared");
    assert.equal(screen("display-3").viewId, "wall-shared");
  });

  it("a read-only screen on a console is moved onto one shared wall copy; the console is untouched", () => {
    const copy = state().views.filter((v) => v.name === "Booth controls (wall)");
    assert.equal(copy.length, 1, "the read-only screens on one console share one copy");
    assert.equal(viewSurface(copy[0]), "display");
    assert.deepEqual([screen("display-7").viewId, screen("display-8").viewId], [copy[0].id, copy[0].id]);
    assert.equal(screen("display-6").viewId, "ctl-a", "the live screen stays on the console");
    assert.equal(viewSurface(state().views.find((v) => v.id === "ctl-a")!), "console");
    assert.notEqual(
      (copy[0].layout as { objects: { id: string }[] }).objects[0].id,
      "ctl-a-clock",
      "the copy shares object ids with its source",
    );
  });

  it("a live screen on a wall view that a read-only screen also shows gets a control-surface copy", () => {
    // wall-solo: display-1 live, display-9 read-only.
    const copies = state().views.filter((v) => v.name === "Lobby loop (control surface)");
    assert.equal(copies.length, 1);
    assert.equal(viewSurface(copies[0]), "console");
    assert.equal(screen("display-1").viewId, copies[0].id);
    assert.equal(screen("display-9").viewId, "wall-solo");
    // wall-mixed: display-4 live, display-5 read-only.
    const mixed = state().views.filter((v) => v.name === "Atrium loop (control surface)");
    assert.equal(mixed.length, 1);
    assert.equal(screen("display-4").viewId, mixed[0].id);
    assert.equal(screen("display-5").viewId, "wall-mixed");
    assert.equal(viewSurface(state().views.find((v) => v.id === "wall-mixed")!), "display");
  });

  const fitOf = (view: { layout?: unknown }) => (view.layout as { canvas: { fit?: string } } | null | undefined)?.canvas.fit;
  const named = (name: string) => state().views.find((v) => v.name === name)!;

  it("a panel keeps its shape: a view made a console, or copied into one, gets the fit it had as a wall view unless its layout chose one", () => {
    assert.equal(fitOf(state().views.find((v) => v.id === "wall-shared")!), "contain", "a converted view would reflow on its fixed-aspect panel");
    assert.equal(fitOf(named("Lobby loop (control surface)")), "contain");
    assert.equal(fitOf(named("Atrium loop (control surface)")), "responsive", "an explicit fit was overridden");
    // What the migration did not make a console is not touched.
    assert.equal(fitOf(state().views.find((v) => v.id === "ctl-a")!), undefined);
    assert.equal(fitOf(named("Booth controls (wall)")), undefined);
  });

  it("a view the migration makes a console, and its control-surface copies, are kept out of the sidebar; nothing else is", () => {
    const hidden = state().views.filter((v) => v.showInSidebar === false).map((v) => v.name).sort();
    // Not "Old pad": the surface migration made that one a console, as it did before.
    assert.deepEqual(hidden, ["Atrium loop (control surface)", "Hallway loop", "Lobby loop (control surface)", "Week ahead"]);
  });

  it("a live screen on a calendar keeps its month chevrons: the calendar becomes a control surface, with no copy", () => {
    assert.equal(screen("display-11").viewId, "cal");
    assert.equal(viewSurface(state().views.find((v) => v.id === "cal")!), "console");
  });

  it("a live screen on a view with nothing to operate is only read-only now; nothing is made", () => {
    assert.equal(screen("display-14").viewId, "mics");
    assert.equal(viewSurface(state().views.find((v) => v.id === "mics")!), "display");
  });

  it("persists the views, copies included, and the screens' new views", async () => {
    const onDisk = (await readJson("views.json")) as { id: string; name: string }[];
    assert.deepEqual(
      onDisk.map((v) => v.name).sort(),
      state().views.map((v) => v.name).sort(),
      "views.json is not what is in memory",
    );
    const disk = ((await readJson("settings.json")) as { outputs: { id: string; viewId: string | null }[] }).outputs;
    for (const o of state().outputs) assert.equal(disk.find((d) => d.id === o.id)?.viewId, o.viewId, o.id);
  });

  it("says what it did: a line for each screen it had to do something for, and one summary", () => {
    const screens = lines.filter((l) => l.startsWith("[screens] "));
    const summary = screens.filter((l) => /role from view:/.test(l));
    assert.deepEqual(summary, ["[screens] role from view: 14 screens checked, 7 changed (2 views made a control surface, 3 copies made)"]);
    const named = (id: string) => screens.some((l) => !/role from view:/.test(l) && l.includes(`"Screen ${id}"`));
    for (const id of ["display-1", "display-2", "display-3", "display-4", "display-7", "display-8", "display-11"]) {
      assert.equal(named(id), true, `${id} was changed and is not in the log`);
    }
    // A screen that only lost the stored role changed nothing, and is not named.
    for (const id of ["display-5", "display-6", "display-9", "display-10", "display-12", "display-13", "display-14"]) {
      assert.equal(named(id), false, `${id} was not changed and is in the log`);
    }
  });

  it("the next boot finds nothing to do, says nothing, and writes nothing", async () => {
    const before = [await fs.readFile(path.join(TMP, "settings.json"), "utf8"), await fs.readFile(path.join(TMP, "views.json"), "utf8")];
    const again: string[] = [];
    console.log = (...a: unknown[]) => { again.push(a.map(String).join(" ")); };
    try {
      await stageController.init();
    } finally {
      console.log = realLog;
    }
    assert.deepEqual(again.filter((l) => l.startsWith("[screens]") || l.startsWith("[surface-migration]")), []);
    assert.deepEqual([await fs.readFile(path.join(TMP, "settings.json"), "utf8"), await fs.readFile(path.join(TMP, "views.json"), "utf8")], before);
  });
});
