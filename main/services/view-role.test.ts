// stageController.setViewRole: change what a view is for AND every screen
// showing it, as one write that is undone if it fails part-way. Driven against
// the real controller, the real guards and real files in a temp data directory.
//
// What these are here for, in the order it would have gone wrong:
//
//  - The guard order. setOutputMode(display) refuses while the view it shows is
//    a console, and setViewSurface(console) refuses while a screen showing it is
//    not a panel. A call that writes in the wrong order is refused by the
//    server's own guards, in one direction or the other, so BOTH directions are
//    run against the real guards, with two screens on the view.
//  - A failure part-way leaving some screens changed and others not. Each
//    failure here is a real write failing (a directory where settings.json or
//    views.json goes, for the one call), and the files are read back off DISK:
//    the in-memory state is what the rollback fixes first and the file is what a
//    restart reads.
//  - A screen pointed at the view after the call started. Toward a console the
//    view's guard refuses, and everything before it is undone.
//  - A screen pointed AWAY from the view after the call started. Its own step
//    refuses, rather than changing a screen that is no longer the view's.
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

const { stageController, ScreenWriteError } = await import("./stage-controller.js");
const { viewSurface, outputMode } = await import("../types/views.js");

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
      { id: "display-2", name: "Hallway TV", viewId: "wall-a", mode: "display" },
      { id: "display-3", name: "Booth panel", viewId: "ctl-a", mode: "panel" },
      { id: "display-4", name: "Stage panel", viewId: "ctl-a", mode: "panel" },
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
const modes = (...ids: string[]) => ids.map((i) => outputMode(out(i)));

async function readDisk<T>(file: string, pick: (raw: unknown) => T): Promise<T> {
  return pick(JSON.parse(await fs.readFile(path.join(TMP, file), "utf8")));
}
const outputsOnDisk = () => readDisk("settings.json", (r) => ((r as { outputs?: Output[] }).outputs ?? []));
const viewsOnDisk = () =>
  readDisk("views.json", (r) => (Array.isArray(r) ? (r as View[]) : ((r as { views?: View[] }).views ?? [])));
const diskModes = async (...ids: string[]) => {
  const on = await outputsOnDisk();
  return ids.map((i) => outputMode(on.find((o) => o.id === i)!));
};

/** Write both files from the seeded state, so each exists and is cached before a
 *  test makes one of them fail. */
async function warm(): Promise<void> {
  for (const o of outputs()) await stageController.renameOutput(o.id, o.name);
  for (const v of views()) await stageController.renameView(v.id, v.name);
}

/** Everything about every screen and view, to prove a call left them as they were. */
const everything = () => JSON.stringify({ outputs: outputs(), views: views() });

/** Every screen that is not a control surface but shows a console: the pairing
 *  the server exists to refuse. Empty is the only right answer. */
const forbiddenPairings = () =>
  outputs()
    .filter((o) => outputMode(o) !== "panel" && o.viewId && viewSurface(view(o.viewId)) === "console")
    .map((o) => `${o.id} on ${o.viewId}`);

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

/** Run `fn` after the `nth` call to a controller method has landed, as a write
 *  from somewhere else arriving mid-call. */
function afterCall(method: string, nth: number, fn: () => Promise<void>): () => void {
  let calls = 0;
  own[method] = async function (this: unknown, ...args: unknown[]) {
    calls += 1;
    const result = await proto[method].apply(stageController, args);
    if (calls === nth) await fn();
    return result;
  };
  return () => { delete own[method]; };
}

/** Run `fn` BEFORE the `nth` call to a controller method. */
function beforeCall(method: string, nth: number, fn: () => Promise<void>): () => void {
  let calls = 0;
  own[method] = async function (this: unknown, ...args: unknown[]) {
    calls += 1;
    if (calls === nth) await fn();
    return proto[method].apply(stageController, args);
  };
  return () => { delete own[method]; };
}

describe("setViewRole — to a control surface", () => {
  it("makes every screen showing the view a control surface, then the view, against the real guards", async () => {
    await stageController.setViewRole("wall-a", "console");
    assert.deepEqual(modes("display-1", "display-2"), ["panel", "panel"]);
    assert.equal(viewSurface(view("wall-a")), "console");
    assert.deepEqual(forbiddenPairings(), []);
  });

  it("persists the screens and the view", async () => {
    await stageController.setViewRole("wall-a", "console");
    assert.deepEqual(await diskModes("display-1", "display-2"), ["panel", "panel"]);
    assert.equal((await viewsOnDisk()).find((v) => v.id === "wall-a")?.surface, "console");
  });

  it("leaves every other screen and view exactly as it was", async () => {
    const others = () => JSON.stringify([out("display-3"), out("display-4"), out("display-5"), out("display-6"), view("ctl-a"), view("wall-b"), view("cal-a")]);
    const before = others();
    await stageController.setViewRole("wall-a", "console");
    assert.equal(others(), before);
  });

  it("changes a view no screen shows on its own, with nothing to convert", async () => {
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
  it("makes the view a wall-screen view, then every screen showing it a wall display, against the real guards", async () => {
    await stageController.setViewRole("ctl-a", "display");
    assert.equal(viewSurface(view("ctl-a")), "display");
    assert.deepEqual(modes("display-3", "display-4"), ["display", "display"]);
    assert.deepEqual(forbiddenPairings(), []);
  });

  it("persists the view and the screens", async () => {
    await stageController.setViewRole("ctl-a", "display");
    assert.equal((await viewsOnDisk()).find((v) => v.id === "ctl-a")?.surface, "display");
    assert.deepEqual(await diskModes("display-3", "display-4"), ["display", "display"]);
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

  it("says nothing when there was nothing to decide", async () => {
    assert.deepEqual(await logged(() => stageController.setViewRole("wall-a", "display")), []);
  });
});

describe("setViewRole — nothing to change", () => {
  it("is not an error, and writes nothing", async () => {
    await warm();
    const before = everything();
    const settingsBefore = await fs.readFile(path.join(TMP, "settings.json"), "utf8");
    await stageController.setViewRole("wall-a", "display");
    await stageController.setViewRole("ctl-a", "console");
    assert.equal(everything(), before);
    assert.equal(await fs.readFile(path.join(TMP, "settings.json"), "utf8"), settingsBefore);
  });

  it("still brings along a screen that does not match a view already as asked", async () => {
    // A console with a wall display left on it (an older build, a hand edit).
    ctl.state = { ...ctl.state, outputs: outputs().map((o) => (o.id === "display-3" ? { ...o, mode: "display" as const } : o)) as Output[] };
    await stageController.setViewRole("ctl-a", "console");
    assert.deepEqual(modes("display-3", "display-4"), ["panel", "panel"]);
  });
});

describe("setViewRole — a write that fails part-way is taken back", () => {
  it("to a control surface, the second screen's write fails: both screens and the view are as they were", async () => {
    await warm();
    const before = everything();
    const diskBefore = JSON.stringify([await outputsOnDisk(), await viewsOnDisk()]);
    const restore = breakDiskOnCall("setOutputMode", "settings.json", 2);
    try {
      await assert.rejects(
        () => stageController.setViewRole("wall-a", "console"),
        (err: unknown) => {
          assert.ok(err instanceof ScreenWriteError, String(err));
          assert.match(err.failed, /"Hallway TV".*control surface/);
          assert.equal(err.rolledBack.length, 2, `rolled back: ${err.rolledBack.join("; ")}`);
          assert.deepEqual(err.notRolledBack, []);
          return true;
        },
      );
    } finally {
      restore();
    }
    assert.deepEqual(modes("display-1", "display-2"), ["display", "display"]);
    assert.equal(viewSurface(view("wall-a")), "display");
    assert.equal(JSON.stringify([await outputsOnDisk(), await viewsOnDisk()]), diskBefore, "what a restart reads is not as it was");
    assert.equal(everything(), before);
  });

  it("to a control surface, the view's write fails last: both screens are put back too", async () => {
    await warm();
    const diskBefore = JSON.stringify([await outputsOnDisk(), await viewsOnDisk()]);
    const restore = breakDiskOnCall("setViewSurface", "views.json", 1);
    try {
      await assert.rejects(
        () => stageController.setViewRole("wall-a", "console"),
        (err: unknown) => {
          assert.ok(err instanceof ScreenWriteError, String(err));
          assert.match(err.failed, /make the view a control surface/);
          assert.deepEqual(err.notRolledBack, []);
          assert.equal(err.rolledBack.length, 3, `rolled back: ${err.rolledBack.join("; ")}`);
          return true;
        },
      );
    } finally {
      restore();
    }
    assert.deepEqual(modes("display-1", "display-2"), ["display", "display"]);
    assert.equal(viewSurface(view("wall-a")), "display");
    assert.equal(JSON.stringify([await outputsOnDisk(), await viewsOnDisk()]), diskBefore);
  });

  it("to a wall display, the second screen's write fails: the view and the first screen are put back", async () => {
    await warm();
    const diskBefore = JSON.stringify([await outputsOnDisk(), await viewsOnDisk()]);
    const restore = breakDiskOnCall("setOutputMode", "settings.json", 2);
    try {
      await assert.rejects(
        () => stageController.setViewRole("ctl-a", "display"),
        (err: unknown) => {
          assert.ok(err instanceof ScreenWriteError, String(err));
          assert.match(err.failed, /"Stage panel".*wall display/);
          assert.deepEqual(err.notRolledBack, []);
          assert.equal(err.rolledBack.length, 3, `rolled back: ${err.rolledBack.join("; ")}`);
          return true;
        },
      );
    } finally {
      restore();
    }
    assert.equal(viewSurface(view("ctl-a")), "console");
    assert.deepEqual(modes("display-3", "display-4"), ["panel", "panel"]);
    assert.equal(JSON.stringify([await outputsOnDisk(), await viewsOnDisk()]), diskBefore);
    assert.deepEqual(forbiddenPairings(), []);
  });

  it("says so when an undo could not be done, and never leaves a wall display on a console", async () => {
    // The view lands in memory, fails, and cannot be put back. Putting the
    // screens back as displays would then be wall displays on a console.
    await warm();
    let calls = 0;
    own.setViewSurface = async (id: string, surface: string) => {
      calls += 1;
      if (calls > 1) throw new Error("still failing");
      await proto.setViewSurface.call(stageController, id, surface);
      throw new Error("late failure");
    };
    try {
      await assert.rejects(
        () => stageController.setViewRole("wall-a", "console"),
        (err: unknown) => {
          assert.ok(err instanceof ScreenWriteError, String(err));
          // The view, and each screen: putting either back as a wall display
          // would show a console on it.
          assert.equal(err.notRolledBack.length, 3, `not rolled back: ${err.notRolledBack.join("; ")}`);
          assert.deepEqual(err.rolledBack, []);
          return true;
        },
      );
    } finally {
      delete own.setViewSurface;
    }
    assert.equal(viewSurface(view("wall-a")), "console");
    assert.deepEqual(modes("display-1", "display-2"), ["panel", "panel"]);
    assert.deepEqual(forbiddenPairings(), []);
  });
});

describe("setViewRole — a screen pointed at the view after it started", () => {
  it("to a control surface: the view's own guard refuses, and every screen is put back", async () => {
    // display-5 is pointed at the view once the first screen has been changed.
    // The view is still a wall-screen view, so the server allows it, and then
    // the view cannot become a console under a wall display.
    const restore = afterCall("setOutputMode", 1, async () => {
      await stageController.setOutputView("display-5", "wall-a");
    });
    try {
      await assert.rejects(
        () => stageController.setViewRole("wall-a", "console"),
        (err: unknown) => {
          assert.ok(err instanceof ScreenWriteError, String(err));
          assert.match(err.failed, /make the view a control surface/);
          assert.match(err.reason, /Spare/);
          return true;
        },
      );
    } finally {
      restore();
    }
    assert.equal(viewSurface(view("wall-a")), "display", "the view was made a console under a wall display");
    assert.deepEqual(modes("display-1", "display-2", "display-5"), ["display", "display", "display"]);
    assert.equal(out("display-5").viewId, "wall-a", "the screen that arrived was moved: it was not this call's to move");
    assert.deepEqual(forbiddenPairings(), []);
  });

  it("to a wall display: a view turned back into a console meanwhile is refused by the screen's guard, and undone", async () => {
    const restore = beforeCall("setOutputMode", 1, async () => {
      // The view has already become a wall-screen view; somebody makes it a
      // console again while the screens are still control surfaces.
      await proto.setViewSurface.call(stageController, "ctl-a", "console");
    });
    try {
      await assert.rejects(
        () => stageController.setViewRole("ctl-a", "display"),
        (err: unknown) => {
          assert.ok(err instanceof ScreenWriteError, String(err));
          assert.match(err.failed, /wall display/);
          assert.match(err.reason, /control surface/);
          assert.deepEqual(err.notRolledBack, []);
          return true;
        },
      );
    } finally {
      restore();
    }
    assert.equal(viewSurface(view("ctl-a")), "console");
    assert.deepEqual(modes("display-3", "display-4"), ["panel", "panel"]);
    assert.deepEqual(forbiddenPairings(), []);
  });
});

describe("setViewRole — a screen pointed AWAY from the view after it started", () => {
  it("to a control surface: the screen that left is not changed, and the rest is undone", async () => {
    // Hallway TV is recalled to another view once Lobby TV has been changed.
    // Changing it anyway would make a control surface out of a screen that no
    // longer shows the view.
    const restore = afterCall("setOutputMode", 1, async () => {
      await stageController.setOutputView("display-2", "wall-b");
    });
    try {
      await assert.rejects(
        () => stageController.setViewRole("wall-a", "console"),
        (err: unknown) => {
          assert.ok(err instanceof ScreenWriteError, String(err));
          assert.match(err.failed, /"Hallway TV"/);
          assert.match(err.reason, /another view meanwhile/);
          assert.deepEqual(err.notRolledBack, []);
          return true;
        },
      );
    } finally {
      restore();
    }
    assert.deepEqual({ viewId: out("display-2").viewId, mode: outputMode(out("display-2")) }, { viewId: "wall-b", mode: "display" });
    assert.deepEqual(modes("display-1"), ["display"]);
    assert.equal(viewSurface(view("wall-a")), "display");
    assert.deepEqual(forbiddenPairings(), []);
  });

  it("to a wall display: the same, after the view has already changed", async () => {
    const restore = afterCall("setOutputMode", 1, async () => {
      await stageController.setOutputView("display-4", "wall-b");
    });
    try {
      await assert.rejects(
        () => stageController.setViewRole("ctl-a", "display"),
        (err: unknown) => {
          assert.ok(err instanceof ScreenWriteError, String(err));
          assert.match(err.failed, /"Stage panel"/);
          assert.deepEqual(err.notRolledBack, []);
          return true;
        },
      );
    } finally {
      restore();
    }
    assert.deepEqual({ viewId: out("display-4").viewId, mode: outputMode(out("display-4")) }, { viewId: "wall-b", mode: "panel" });
    assert.deepEqual(modes("display-3"), ["panel"]);
    assert.equal(viewSurface(view("ctl-a")), "console");
    assert.deepEqual(forbiddenPairings(), []);
  });
});
