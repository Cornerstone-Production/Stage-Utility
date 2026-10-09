// createScreen and setOutputRole, driven against the real controller and real
// files in a temp data directory.
//
// What these are here for, in the order it would have gone wrong:
//
//  - A screen made in several writes that fails part-way and leaves a piece
//    behind: an empty screen, or a view nobody asked for. Every failure test
//    reads settings.json and views.json back off DISK, because the in-memory
//    state is what the rollback fixes first and the file is what a restart reads.
//  - A refusal that comes AFTER something was written. Validation is asserted to
//    leave no trace at all.
//  - Changing one screen's role changing ANOTHER screen. The copy path is
//    asserted by snapshotting every other screen and view before and after.
//  - The guard order. setOutputMode(display) refuses while the screen shows a
//    console and setViewSurface(console) refuses while a screen showing it is not
//    a panel; a role change that does its writes in the wrong order is refused by
//    the server's own guards, and the tests here use the real guards.
//
// Every id and name is invented.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, it } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-create-role-"));
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
      { id: "wall-b", name: "Hallway loop", kind: "custom", surface: "display", createdAt: NOW, layout },
      { id: "ctl-a", name: "Booth controls", kind: "custom", surface: "console", createdAt: NOW, layout },
      { id: "ctl-b", name: "Stage controls", kind: "custom", surface: "console", createdAt: NOW, layout },
    ] as unknown as View[],
    outputs: [
      { id: "display-1", name: "Lobby TV", viewId: "wall-a" },
      { id: "display-2", name: "Hallway TV", viewId: "wall-a" },
      { id: "display-3", name: "Booth panel", viewId: "ctl-a", mode: "panel" },
      { id: "display-4", name: "Stage panel", viewId: "ctl-a", mode: "panel" },
      { id: "display-5", name: "Spare", viewId: null },
    ] as unknown as Output[],
  };
  ctl.recomputeResolved();
}
beforeEach(seed);

const outputs = () => stageController.getState().outputs;
const views = () => stageController.getState().views;
const out = (id: string) => outputs().find((o) => o.id === id)!;
const view = (id: string) => views().find((v) => v.id === id)!;

async function readDisk<T>(file: string, pick: (raw: unknown) => T): Promise<T> {
  return pick(JSON.parse(await fs.readFile(path.join(TMP, file), "utf8")));
}
const outputsOnDisk = () => readDisk("settings.json", (r) => ((r as { outputs?: Output[] }).outputs ?? []));
const viewsOnDisk = () =>
  readDisk("views.json", (r) => (Array.isArray(r) ? (r as View[]) : ((r as { views?: View[] }).views ?? [])));

/** Everything about the screens and views a role change may NOT touch. */
const snapshot = (screenIds: string[], viewIds: string[]) =>
  JSON.stringify({
    outputs: screenIds.map((i) => out(i)),
    views: viewIds.map((i) => view(i)),
  });

/** Make one controller method fail the next time it is called, then restore it. */
function failNext<K extends keyof typeof stageController>(method: K, message: string): () => void {
  const target = stageController as unknown as Record<string, unknown>;
  const original = target[method as string] as (...a: unknown[]) => unknown;
  target[method as string] = async () => {
    target[method as string] = original;
    throw new Error(message);
  };
  return () => { target[method as string] = original; };
}

describe("createScreen — the original { name, viewId } call", () => {
  it("makes a display routed to the view as given, with no role written", async () => {
    const { output } = await stageController.createScreen({ name: "Cafe TV", viewId: "wall-b" });
    assert.equal(output.name, "Cafe TV");
    assert.equal(output.viewId, "wall-b");
    assert.equal(output.mode, undefined, "a role the caller never stated must not be written");
    assert.equal(outputMode(output), "display");
    assert.equal(views().length, 4, "no view may be made for a call that did not ask for one");
  });

  it("takes the view id as given, as it always did: no role stated, no fit check", async () => {
    const { output } = await stageController.createScreen({ name: "Odd", viewId: "ctl-b" });
    assert.equal(output.viewId, "ctl-b");
  });

  it("names the screen 'Display N' when no name is given", async () => {
    const { output } = await stageController.createScreen({});
    assert.match(output.name, /^Display \d+$/);
    assert.equal(output.viewId, null);
  });
});

describe("createScreen — a stated role", () => {
  it("makes a control surface on a control-surface view", async () => {
    const { output } = await stageController.createScreen({ name: "Wing panel", mode: "panel", viewId: "ctl-b" });
    assert.equal(output.mode, "panel");
    assert.equal(output.viewId, "ctl-b");
    assert.equal((await outputsOnDisk()).find((o) => o.id === output.id)?.mode, "panel", "not written to settings.json");
  });

  it("refuses a wall-screen view for a control surface, and writes nothing", async () => {
    const before = snapshot(outputs().map((o) => o.id), views().map((v) => v.id));
    await assert.rejects(
      () => stageController.createScreen({ name: "Nope", mode: "panel", viewId: "wall-a" }),
      /control surface needs a control-surface view/,
    );
    assert.equal(snapshot(outputs().map((o) => o.id), views().map((v) => v.id)), before);
    assert.equal(outputs().length, 5);
    assert.equal((await outputsOnDisk()).some((o) => o.name === "Nope"), false);
  });

  it("refuses a console view for a wall display, and writes nothing", async () => {
    await assert.rejects(
      () => stageController.createScreen({ name: "Nope", mode: "display", viewId: "ctl-a" }),
      /live controls/,
    );
    assert.equal(outputs().length, 5);
  });

  it("refuses a view that does not exist, and Home", async () => {
    await assert.rejects(() => stageController.createScreen({ mode: "display", viewId: "ghost" }), /not found/);
    await assert.rejects(() => stageController.createScreen({ mode: "display", viewId: "home" }), /front page/);
    assert.equal(outputs().length, 5);
  });

  it("refuses a view AND a new view", async () => {
    await assert.rejects(
      () => stageController.createScreen({ mode: "display", viewId: "wall-a", newView: true }),
      /alternatives/,
    );
    assert.equal(outputs().length, 5);
  });

  it("refuses a mode that is neither", async () => {
    await assert.rejects(() => stageController.createScreen({ mode: "kiosk" as never }), /mode must be/);
    assert.equal(outputs().length, 5);
  });
});

describe("createScreen — the friendly link", () => {
  it("keeps a valid slug, lower-cased, on disk", async () => {
    const { output } = await stageController.createScreen({ name: "Cafe", slug: "  Cafe-TV " });
    assert.equal(output.slug, "cafe-tv");
    assert.equal((await outputsOnDisk()).find((o) => o.id === output.id)?.slug, "cafe-tv");
  });

  it("refuses a slug another screen holds, before writing anything", async () => {
    await stageController.createScreen({ name: "First", slug: "cafe" });
    const count = outputs().length;
    await assert.rejects(() => stageController.createScreen({ name: "Second", slug: "cafe" }), /already used/);
    assert.equal(outputs().length, count);
  });

  it("refuses a built-in page and bad characters", async () => {
    await assert.rejects(() => stageController.createScreen({ slug: "settings" }), /built-in page/);
    await assert.rejects(() => stageController.createScreen({ slug: "no spaces" }), /lowercase letters/);
    assert.equal(outputs().length, 5);
  });

  it("refuses a slug equal to the id the screen is about to be given, and leaves no screen", async () => {
    // The next id does not exist to be checked until it is allocated, so this is
    // the one slug check that happens inside the write. Ids never come back, so
    // a probe screen shows where the counter is.
    const probe = (await stageController.createScreen({ name: "Probe" })).output.id;
    await stageController.removeOutput(probe);
    const next = `display-${Number(probe.replace("display-", "")) + 1}`;
    const count = outputs().length;
    await assert.rejects(() => stageController.createScreen({ name: "Clash", slug: next }), /already used/);
    assert.equal(outputs().length, count);
    assert.equal((await outputsOnDisk()).some((o) => o.name === "Clash"), false);
  });
});

describe("createScreen — a new view", () => {
  it("makes a blank control-surface view named after the screen, for a control surface", async () => {
    const { output, createdViewId } = await stageController.createScreen({ name: "Green room", mode: "panel", newView: true });
    assert.ok(createdViewId);
    const made = view(createdViewId!);
    assert.equal(made.name, "Green room");
    assert.equal(made.kind, "custom");
    assert.equal(viewSurface(made), "console");
    assert.equal(output.viewId, createdViewId);
    assert.equal(output.mode, "panel");
    assert.ok((await viewsOnDisk()).some((v) => v.id === createdViewId), "the view is not in views.json");
  });

  it("makes a wall-screen view for a wall display", async () => {
    const { createdViewId } = await stageController.createScreen({ name: "Atrium", mode: "display", newView: true });
    assert.equal(viewSurface(view(createdViewId!)), "display");
  });
});

describe("createScreen — the sidebar listing", () => {
  it("lists nothing in the sidebar when told not to, on a view made for the screen", async () => {
    const { createdViewId } = await stageController.createScreen({ name: "Quiet", mode: "panel", newView: true, showInSidebar: false });
    assert.equal(view(createdViewId!).showInSidebar, false);
    assert.equal((await viewsOnDisk()).find((v) => v.id === createdViewId)?.showInSidebar, false);
  });

  it("writes it on an existing control-surface view the screen shows", async () => {
    await stageController.createScreen({ name: "Quiet", mode: "panel", viewId: "ctl-b", showInSidebar: false });
    assert.equal(view("ctl-b").showInSidebar, false);
  });

  it("does not touch a view for a wall display, where the listing means nothing", async () => {
    await stageController.createScreen({ name: "Wall", mode: "display", viewId: "wall-b", showInSidebar: false });
    assert.equal(view("wall-b").showInSidebar, undefined);
  });
});

describe("createScreen — a write that fails part-way is taken back", () => {
  it("removes the screen AND the view it made, and says what it undid", async () => {
    const restore = failNext("setViewShowInSidebar", "disk full");
    try {
      await assert.rejects(
        () => stageController.createScreen({ name: "Doomed", mode: "panel", newView: true, showInSidebar: false }),
        (err: unknown) => {
          assert.ok(err instanceof ScreenWriteError, String(err));
          assert.equal(err.failed, "set the sidebar listing");
          assert.deepEqual(err.rolledBack.sort(), ["add the screen", "make the view"]);
          assert.deepEqual(err.notRolledBack, []);
          assert.match(err.message, /disk full/);
          return true;
        },
      );
    } finally {
      restore();
    }
    assert.equal(outputs().length, 5, "a screen was left behind");
    assert.equal(views().length, 4, "a view was left behind");
    assert.equal((await outputsOnDisk()).some((o) => o.name === "Doomed"), false, "settings.json still has it");
    assert.equal((await viewsOnDisk()).some((v) => v.name === "Doomed"), false, "views.json still has it");
  });

  it("puts an existing view's listing back, even when the write that changed it is the one that failed", async () => {
    // Lands in memory, then fails: the state a controller write is in when its
    // save fails. The step that failed has to be undone too, not only the ones
    // before it.
    const proto = Object.getPrototypeOf(stageController) as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const real = proto.setViewShowInSidebar;
    (stageController as unknown as Record<string, unknown>).setViewShowInSidebar = async (id: string, v: boolean) => {
      await real.call(stageController, id, v);
      throw new Error("late failure");
    };
    try {
      await assert.rejects(
        () => stageController.createScreen({ name: "Late", mode: "panel", viewId: "ctl-b", showInSidebar: false }),
        ScreenWriteError,
      );
    } finally {
      delete (stageController as unknown as Record<string, unknown>).setViewShowInSidebar;
    }
    assert.equal(outputs().some((o) => o.name === "Late"), false, "the screen was left behind");
    assert.notEqual(view("ctl-b").showInSidebar, false, "the failed create left the console hidden from the sidebar");
  });
});

describe("undoCreateScreen", () => {
  it("removes the screen and the view, even when that view is the only one", async () => {
    const { output, createdViewId } = await stageController.createScreen({ name: "Temp", mode: "display", newView: true });
    // Leave exactly one user view: deleteView would refuse to drop it, and a
    // rollback that cannot drop the view it made is not a rollback.
    ctl.state = { ...ctl.state, views: views().filter((v) => v.id === createdViewId) };
    const left = await stageController.undoCreateScreen({ outputId: output.id, viewId: createdViewId });
    assert.deepEqual(left, []);
    assert.equal(outputs().some((o) => o.id === output.id), false);
    assert.equal(views().some((v) => v.id === createdViewId), false);
  });

  it("returns what it could not remove instead of throwing", async () => {
    const left = await stageController.undoCreateScreen({ outputId: "display-nope", viewId: null });
    assert.equal(left.length, 1);
    assert.match(left[0], /display-nope/);
  });
});

describe("setOutputRole — a view only this screen shows", () => {
  it("turns a screen into a control surface and its view with it", async () => {
    const { copiedViewId } = await stageController.setOutputRole("display-5", "panel");
    assert.equal(copiedViewId, null);
    // display-5 shows nothing: only the role moves.
    assert.equal(out("display-5").mode, "panel");
  });

  it("flips the view's kind with the screen, in the order the guards allow", async () => {
    await stageController.setOutputView("display-5", "wall-b");
    await stageController.setOutputRole("display-5", "panel");
    assert.equal(out("display-5").mode, "panel");
    assert.equal(viewSurface(view("wall-b")), "console");
    // And back. The screen is a panel on a console: setOutputMode(display) alone
    // is refused by the server, so the view must lead.
    await stageController.setOutputRole("display-5", "display");
    assert.equal(out("display-5").mode, "display");
    assert.equal(viewSurface(view("wall-b")), "display");
  });
});

describe("setOutputRole — a view other screens also show", () => {
  it("is refused when it would change them, naming them, and changes nothing", async () => {
    // display-4 is a panel on the console it shares with display-3.
    const before = snapshot(["display-3", "display-4"], ["ctl-a"]);
    await assert.rejects(
      () => stageController.setOutputRole("display-4", "display"),
      (e: Error) => {
        assert.match(e.message, /Booth panel/, "must name the other screen");
        assert.match(e.message, /Use a copy/);
        return true;
      },
    );
    assert.equal(snapshot(["display-3", "display-4"], ["ctl-a"]), before);
  });

  it("copies the view for a wall display, and leaves the other control surface alone", async () => {
    const others = snapshot(["display-1", "display-2", "display-3", "display-5"], ["wall-a", "wall-b", "ctl-a", "ctl-b"]);
    const { copiedViewId } = await stageController.setOutputRole("display-4", "display", { copyView: true });
    assert.ok(copiedViewId);
    const copy = view(copiedViewId!);
    assert.equal(copy.name, "Booth controls (wall)");
    assert.equal(viewSurface(copy), "display");
    assert.equal(out("display-4").mode, "display");
    assert.equal(out("display-4").viewId, copiedViewId);
    assert.equal(snapshot(["display-1", "display-2", "display-3", "display-5"], ["wall-a", "wall-b", "ctl-a", "ctl-b"]), others,
      "another screen or the original view changed");
    assert.equal(out("display-3").mode, "panel");
    assert.equal(viewSurface(view("ctl-a")), "console");
  });

  it("copies the view for a control surface, and leaves the other wall display alone", async () => {
    const others = snapshot(["display-2", "display-3", "display-4", "display-5"], ["wall-a", "wall-b", "ctl-a", "ctl-b"]);
    const { copiedViewId } = await stageController.setOutputRole("display-1", "panel", { copyView: true });
    const copy = view(copiedViewId!);
    assert.equal(copy.name, "Lobby loop (control surface)");
    assert.equal(viewSurface(copy), "console");
    assert.equal(out("display-1").mode, "panel");
    assert.equal(out("display-1").viewId, copiedViewId);
    assert.equal(snapshot(["display-2", "display-3", "display-4", "display-5"], ["wall-a", "wall-b", "ctl-a", "ctl-b"]), others);
    assert.equal(viewSurface(view("wall-a")), "display", "the shared view was flipped under the other screen");
    assert.equal(out("display-2").viewId, "wall-a");
  });

  it("persists the copy and the screen", async () => {
    const { copiedViewId } = await stageController.setOutputRole("display-4", "display", { copyView: true });
    assert.ok((await viewsOnDisk()).some((v) => v.id === copiedViewId));
    const disk = await outputsOnDisk();
    assert.equal(disk.find((o) => o.id === "display-4")?.viewId, copiedViewId);
    assert.equal(disk.find((o) => o.id === "display-4")?.mode, "display");
  });

  it("points this screen at a view that already fits, changing nothing else", async () => {
    const others = snapshot(["display-1", "display-2", "display-3", "display-5"], ["wall-a", "wall-b", "ctl-a", "ctl-b"]);
    await stageController.setOutputRole("display-4", "display", { viewId: "wall-b" });
    assert.equal(out("display-4").mode, "display");
    assert.equal(out("display-4").viewId, "wall-b");
    assert.equal(snapshot(["display-1", "display-2", "display-3", "display-5"], ["wall-a", "wall-b", "ctl-a", "ctl-b"]), others);
    await stageController.setOutputRole("display-4", "panel", { viewId: "ctl-b" });
    assert.equal(out("display-4").mode, "panel");
    assert.equal(out("display-4").viewId, "ctl-b");
  });

  it("refuses a chosen view that does not fit, and changes nothing", async () => {
    const before = snapshot(["display-4"], ["ctl-a"]);
    await assert.rejects(() => stageController.setOutputRole("display-4", "display", { viewId: "ctl-b" }), /does not fit a wall display/);
    await assert.rejects(() => stageController.setOutputRole("display-4", "display", { viewId: "ghost" }), /not found/);
    assert.equal(snapshot(["display-4"], ["ctl-a"]), before);
  });

  it("refuses a copy AND a chosen view", async () => {
    await assert.rejects(() => stageController.setOutputRole("display-4", "display", { copyView: true, viewId: "wall-b" }), /alternatives/);
  });
});

describe("setOutputRole — a step that fails is taken back", () => {
  it("removes the copy and restores the screen's mode and view", async () => {
    const before = snapshot(["display-3", "display-4"], ["ctl-a"]);
    // The copy is made, then pointing the screen at it fails.
    const restore = failNext("setOutputView", "disk full");
    try {
      await assert.rejects(
        () => stageController.setOutputRole("display-4", "display", { copyView: true }),
        (err: unknown) => {
          assert.ok(err instanceof ScreenWriteError, String(err));
          assert.equal(err.failed, "point the screen at the copy");
          assert.ok(err.rolledBack.includes("copy the view"), `rolled back: ${err.rolledBack.join(", ")}`);
          assert.deepEqual(err.notRolledBack, []);
          return true;
        },
      );
    } finally {
      restore();
    }
    assert.equal(views().some((v) => v.name === "Booth controls (wall)"), false, "the copy was left behind");
    assert.equal(snapshot(["display-3", "display-4"], ["ctl-a"]), before, "a screen or view is not as it was");
    assert.equal(views().length, 4);
    assert.equal((await viewsOnDisk()).length, 4, "views.json still has the copy");
    assert.equal((await outputsOnDisk()).find((o) => o.id === "display-4")?.mode, "panel");
  });

  it("restores the screen when the second of two writes fails", async () => {
    // Panel on a view only this screen shows: the screen goes first, the view's
    // kind second. If the kind fails, the screen must go back to a display.
    await stageController.setOutputView("display-5", "wall-b");
    const before = snapshot(["display-5"], ["wall-b"]);
    const restore = failNext("setViewSurface", "disk full");
    try {
      await assert.rejects(() => stageController.setOutputRole("display-5", "panel"), ScreenWriteError);
    } finally {
      restore();
    }
    assert.equal(snapshot(["display-5"], ["wall-b"]), before);
  });
});
