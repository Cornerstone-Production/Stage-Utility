// stageController.setViewRole: change what a view is for, and with it the role of
// every screen showing it, as one write that is undone if it fails. A screen's
// buttons work exactly when its view is a console, so the view's surface is the
// only thing written. Driven against the real controller and real files in a
// temp data directory.
//
// What these are here for, in the order it would have gone wrong:
//
//  - A screen that did not change role with its view. There is no second field to
//    forget: the role is read from the view, and these assert it through the one
//    function every reader uses.
//  - A failure leaving the view changed in memory or on disk. The failing write is
//    a real one (a directory where views.json goes, for the one call), and the
//    files are read back off DISK: memory is what the rollback fixes first and
//    the file is what a restart reads.
//  - The screens the operator was shown no longer being the screens it would
//    change, because one was pointed at the view, or away from it, while the
//    question was open. Refused, writing nothing, with the list as it is now.
//  - Only a custom view being made a console.
//
// Every id and name is invented.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, it } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-view-role-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { stageController, ScreenWriteError, ViewScreensChangedError } = await import("./stage-controller.js");
const { viewSurface, screenIsControlSurface } = await import("../types/views.js");

type Mutable = {
  state: { views: View[]; outputs: Output[]; [k: string]: unknown };
  broadcast: () => void;
  recomputeResolved: () => void;
};
const ctl = stageController as unknown as Mutable;
ctl.broadcast = () => {};

const layout = { version: 1, canvas: { width: 1920, height: 1080 }, objects: [] };
const NOW = "2026-01-01T00:00:00.000Z";

function seed(): void {
  ctl.state = {
    ...ctl.state,
    views: [
      { id: "wall-a", name: "Lobby loop", kind: "custom", surface: "display", createdAt: NOW, layout },
      { id: "wall-b", name: "Unplaced loop", kind: "custom", surface: "display", createdAt: NOW, layout },
      { id: "ctl-a", name: "Booth controls", kind: "custom", surface: "console", createdAt: NOW, layout },
      { id: "cal-a", name: "Week ahead", kind: "calendar", surface: "display", createdAt: NOW },
    ] as unknown as View[],
    outputs: [
      { id: "display-1", name: "Lobby TV", viewId: "wall-a" },
      { id: "display-2", name: "Hallway TV", viewId: "wall-a" },
      { id: "display-3", name: "Booth panel", viewId: "ctl-a" },
      { id: "display-4", name: "Stage panel", viewId: "ctl-a" },
      { id: "display-5", name: "Spare", viewId: null },
      { id: "display-6", name: "Cafe TV", viewId: "cal-a" },
    ] as unknown as Output[],
  };
  ctl.recomputeResolved();
}
beforeEach(seed);

const outputs = () => stageController.getState().outputs;
const views = () => stageController.getState().views;
const out = (id: string) => outputs().find((o) => o.id === id)!;
const view = (id: string) => views().find((v) => v.id === id)!;
/** Which of these screens are control surfaces, read the way every reader does. */
const live = (...ids: string[]) => ids.map((i) => screenIsControlSurface(out(i), views()));

async function readDisk<T>(file: string, pick: (raw: unknown) => T): Promise<T> {
  return pick(JSON.parse(await fs.readFile(path.join(TMP, file), "utf8")));
}
const viewsOnDisk = () =>
  readDisk("views.json", (r) => (Array.isArray(r) ? (r as View[]) : ((r as { views?: View[] }).views ?? [])));
const diskSurface = async (viewId: string) => (await viewsOnDisk()).find((v) => v.id === viewId)?.surface;

/** Write both files from the seeded state, so each exists and is cached before a
 *  test makes one of them fail. */
async function warm(): Promise<void> {
  for (const o of outputs()) await stageController.renameOutput(o.id, o.name);
  for (const v of views()) await stageController.renameView(v.id, v.name);
}

/** Everything about every screen and view, to prove a call left them as they were. */
const everything = () => JSON.stringify({ outputs: outputs(), views: views() });

type Method = (...a: unknown[]) => Promise<unknown>;
const proto = Object.getPrototypeOf(stageController) as Record<string, Method>;
const own = stageController as unknown as Record<string, unknown>;

/**
 * Make the `nth` call to a controller method run with a DIRECTORY where `file`
 * goes, so the write inside it fails for real (EISDIR) after the controller has
 * assigned its state — what a full disk does. The file is put back as soon as
 * that one call is over, so the rollback's own writes land. Returns a restore.
 */
function breakDiskOnCall(method: string, file: string, nth: number): () => void {
  let calls = 0;
  own[method] = async function (this: unknown, ...args: unknown[]) {
    calls += 1;
    if (calls !== nth) return proto[method].apply(stageController, args);
    const at = path.join(TMP, file);
    const saved = await fs.readFile(at, "utf8");
    await fs.rm(at);
    await fs.mkdir(at);
    try {
      return await proto[method].apply(stageController, args);
    } finally {
      await fs.rm(at, { recursive: true, force: true });
      await fs.writeFile(at, saved);
    }
  };
  return () => { delete own[method]; };
}

describe("setViewRole — to a control surface", () => {
  it("makes the view a console, and every screen showing it a control surface with it", async () => {
    assert.deepEqual(live("display-1", "display-2"), [false, false]);
    await stageController.setViewRole("wall-a", "console");
    assert.equal(viewSurface(view("wall-a")), "console");
    assert.deepEqual(live("display-1", "display-2"), [true, true]);
  });

  it("persists the view", async () => {
    await stageController.setViewRole("wall-a", "console");
    assert.equal(await diskSurface("wall-a"), "console");
  });

  it("leaves every other screen and view exactly as it was", async () => {
    const others = () => JSON.stringify([out("display-3"), out("display-4"), out("display-5"), out("display-6"), view("ctl-a"), view("wall-b"), view("cal-a")]);
    const before = others();
    await stageController.setViewRole("wall-a", "console");
    assert.equal(others(), before);
  });

  it("changes a view no screen shows on its own", async () => {
    await stageController.setViewRole("wall-b", "console");
    assert.equal(viewSurface(view("wall-b")), "console");
    assert.equal(outputs().length, 6);
  });

  it("refuses a view that is not a custom view, saying why, and changes nothing", async () => {
    const before = everything();
    await assert.rejects(() => stageController.setViewRole("cal-a", "console"), /Week ahead.*Calendar view.*control surface/s);
    assert.equal(everything(), before);
  });

  it("refuses Home and a view that does not exist", async () => {
    const before = everything();
    await assert.rejects(() => stageController.setViewRole("home", "console"), /Home/);
    await assert.rejects(() => stageController.setViewRole("ghost", "console"), /not found/);
    await assert.rejects(() => stageController.setViewRole("wall-a", "kiosk" as never), /surface must be/);
    assert.equal(everything(), before);
  });
});

describe("setViewRole — to a wall display", () => {
  it("makes the view a wall view, and every screen showing it read-only with it", async () => {
    assert.deepEqual(live("display-3", "display-4"), [true, true]);
    await stageController.setViewRole("ctl-a", "display");
    assert.equal(viewSurface(view("ctl-a")), "display");
    assert.deepEqual(live("display-3", "display-4"), [false, false]);
  });

  it("persists the view", async () => {
    await stageController.setViewRole("ctl-a", "display");
    assert.equal(await diskSurface("ctl-a"), "display");
  });

  it("leaves every other screen and view exactly as it was", async () => {
    const others = () => JSON.stringify([out("display-1"), out("display-2"), out("display-5"), out("display-6"), view("wall-a"), view("wall-b")]);
    const before = others();
    await stageController.setViewRole("ctl-a", "display");
    assert.equal(others(), before);
  });

  it("lets a calendar view go to a wall display: only a console needs a custom view", async () => {
    await stageController.setViewRole("cal-a", "display");
    assert.equal(viewSurface(view("cal-a")), "display");
  });
});

/** The controller's own log lines from `fn`, which is how an operator at 9am
 *  would learn what a call decided. */
async function logged(fn: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines.filter((l) => l.startsWith("[stage-controller] setViewRole"));
}

describe("setViewRole — what it logs", () => {
  it("says which view, which way and which screens, in one line", async () => {
    const lines = await logged(() => stageController.setViewRole("wall-a", "console"));
    assert.deepEqual(lines, ['[stage-controller] setViewRole view=wall-a → console, screens: "Lobby TV", "Hallway TV"']);
  });

  it("says so when the screens the operator was shown are stale, and which", async () => {
    const lines = await logged(() => stageController.setViewRole("wall-a", "console", { screens: ["display-1"] }).then(() => assert.fail("expected a refusal"), () => undefined));
    assert.deepEqual(lines, [
      "[stage-controller] setViewRole view=wall-a → console not made: the screens changed since the operator was asked " +
        "(asked about: display-1; now: display-1, display-2)",
    ]);
  });

  it("says nothing when there was nothing to decide", async () => {
    assert.deepEqual(await logged(() => stageController.setViewRole("wall-a", "display")), []);
  });
});

describe("setViewRole — nothing to change", () => {
  it("is not an error, and writes nothing", async () => {
    await warm();
    const before = everything();
    const viewsBefore = await fs.readFile(path.join(TMP, "views.json"), "utf8");
    await stageController.setViewRole("wall-a", "display");
    await stageController.setViewRole("ctl-a", "console");
    assert.equal(everything(), before);
    assert.equal(await fs.readFile(path.join(TMP, "views.json"), "utf8"), viewsBefore);
  });

  it("does not ask about screens when the view is already as asked", async () => {
    // Nothing would change, so a stale list is not a reason to refuse.
    await stageController.setViewRole("ctl-a", "console", { screens: [] });
    assert.equal(viewSurface(view("ctl-a")), "console");
  });
});

describe("setViewRole — a write that fails is taken back", () => {
  it("the view is as it was in memory and on disk, and the failure says what was undone", async () => {
    await warm();
    const diskBefore = JSON.stringify(await viewsOnDisk());
    const before = everything();
    const restore = breakDiskOnCall("setViewSurface", "views.json", 1);
    try {
      await assert.rejects(
        () => stageController.setViewRole("wall-a", "console"),
        (err: unknown) => {
          assert.ok(err instanceof ScreenWriteError, String(err));
          assert.match(err.failed, /make the view a control surface/);
          assert.deepEqual(err.notRolledBack, []);
          assert.equal(err.rolledBack.length, 1, `rolled back: ${err.rolledBack.join("; ")}`);
          return true;
        },
      );
    } finally {
      restore();
    }
    assert.equal(viewSurface(view("wall-a")), "display");
    assert.deepEqual(live("display-1", "display-2"), [false, false], "a read-only screen was left live");
    assert.equal(JSON.stringify(await viewsOnDisk()), diskBefore, "what a restart reads is not as it was");
    assert.equal(everything(), before);
  });

  it("to a wall view, the same", async () => {
    await warm();
    const diskBefore = JSON.stringify(await viewsOnDisk());
    const restore = breakDiskOnCall("setViewSurface", "views.json", 1);
    try {
      await assert.rejects(() => stageController.setViewRole("ctl-a", "display"), ScreenWriteError);
    } finally {
      restore();
    }
    assert.equal(viewSurface(view("ctl-a")), "console");
    assert.deepEqual(live("display-3", "display-4"), [true, true], "a control surface stopped working");
    assert.equal(JSON.stringify(await viewsOnDisk()), diskBefore);
  });
});

/** The ids of the screens setViewRole would change, as a client computes them
 *  for the question it asks: every screen showing the view. */
const askedAbout = (viewId: string) => outputs().filter((o) => o.viewId === viewId).map((o) => o.id);

describe("setViewRole — the screens the operator was shown", () => {
  it("THE RACE: a screen pointed at the view while the question was open is refused, naming the screens now, and nothing is written", async () => {
    const shown = askedAbout("wall-a");
    assert.deepEqual(shown, ["display-1", "display-2"]);
    // Somebody else points Spare at the view while the dialog is open.
    await stageController.setOutputView("display-5", "wall-a");
    const before = everything();
    await assert.rejects(
      () => stageController.setViewRole("wall-a", "console", { screens: shown }),
      (err: unknown) => {
        assert.ok(err instanceof ViewScreensChangedError, String(err));
        assert.equal(err.code, "screens-changed");
        assert.deepEqual(err.screens, [
          { id: "display-1", name: "Lobby TV" },
          { id: "display-2", name: "Hallway TV" },
          { id: "display-5", name: "Spare" },
        ]);
        return true;
      },
    );
    assert.equal(everything(), before, "a screen the operator was never shown was changed");
  });

  it("a screen pointed AWAY while the question was open is refused too", async () => {
    const shown = askedAbout("wall-a");
    await stageController.setOutputView("display-2", "wall-b");
    const before = everything();
    await assert.rejects(
      () => stageController.setViewRole("wall-a", "console", { screens: shown }),
      (err: unknown) => err instanceof ViewScreensChangedError && err.screens.length === 1 && err.screens[0].id === "display-1",
    );
    assert.equal(everything(), before);
  });

  it("refuses a call that asked about no screens when there is one now", async () => {
    const before = everything();
    await assert.rejects(
      () => stageController.setViewRole("wall-a", "console", { screens: [] }),
      (err: unknown) => err instanceof ViewScreensChangedError && err.screens.length === 2,
    );
    assert.equal(everything(), before);
  });

  it("refuses a list naming a screen that has left the view", async () => {
    await assert.rejects(
      () => stageController.setViewRole("wall-a", "console", { screens: ["display-1", "display-2", "display-5"] }),
      ViewScreensChangedError,
    );
  });

  it("goes ahead when the list matches, in any order", async () => {
    await stageController.setViewRole("wall-a", "console", { screens: ["display-2", "display-1"] });
    assert.deepEqual(live("display-1", "display-2"), [true, true]);
    assert.equal(viewSurface(view("wall-a")), "console");
  });

  it("with no list at all, changes whatever screens show the view: the call a script makes", async () => {
    await stageController.setOutputView("display-5", "wall-a");
    await stageController.setViewRole("wall-a", "console");
    assert.deepEqual(live("display-1", "display-2", "display-5"), [true, true, true]);
  });
});
