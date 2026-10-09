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
      /cannot go on a control surface/,
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

/**
 * Put a directory where a store's file goes, so the next write onto it fails
 * for real (EISDIR) after the controller has already assigned its state, which
 * is what a full disk does. Puts the file back afterwards.
 */
async function withUnwritable<T>(file: string, body: () => Promise<T>): Promise<T> {
  const at = path.join(TMP, file);
  const saved = await fs.readFile(at, "utf8");
  await fs.rm(at);
  await fs.mkdir(at);
  try {
    return await body();
  } finally {
    await fs.rm(at, { recursive: true, force: true });
    await fs.writeFile(at, saved);
  }
}

describe("a write that fails on disk leaves nothing behind in memory either", () => {
  // The rollback used to learn what it made only when the call that made it
  // RESOLVED, and these calls assign the state before they write. A write that
  // failed left the thing in memory with nothing to undo it, the operator told
  // "Nothing was changed", and the next successful write persisted it.
  it("a screen whose settings.json write fails", async () => {
    await stageController.createScreen({ name: "Warm" }); // settings.json exists and is cached
    await withUnwritable("settings.json", () =>
      assert.rejects(() => stageController.createScreen({ name: "Phantom", mode: "display" }), ScreenWriteError));
    assert.equal(outputs().some((o) => o.name === "Phantom"), false, "the screen is still in memory");
    // The next write that lands must not carry it to disk.
    await stageController.renameOutput("display-1", "Lobby TV again");
    assert.equal((await outputsOnDisk()).some((o) => o.name === "Phantom"), false, "the next write persisted the phantom screen");
  });

  it("a view made for a screen, whose views.json write fails", async () => {
    await stageController.renameView("wall-b", "Hallway loop"); // views.json exists and is cached
    const before = views().length;
    await withUnwritable("views.json", () =>
      assert.rejects(() => stageController.createScreen({ name: "Lost", mode: "panel", newView: true }), ScreenWriteError));
    assert.equal(views().length, before, "the view made for the screen is still in memory");
    assert.equal(outputs().some((o) => o.name === "Lost"), false);
    await stageController.renameView("wall-b", "Hallway loop 2");
    assert.equal((await viewsOnDisk()).some((v) => v.name === "Lost"), false, "the next write persisted the phantom view");
  });

  it("the copy of a shared view, whose views.json write fails", async () => {
    await stageController.renameView("wall-b", "Hallway loop");
    const before = snapshot(["display-3", "display-4"], ["ctl-a"]);
    await withUnwritable("views.json", () =>
      assert.rejects(() => stageController.setOutputRole("display-4", "display", { copyView: true }), ScreenWriteError));
    assert.equal(views().some((v) => v.name === "Booth controls (wall)"), false, "the copy is still in memory");
    assert.equal(snapshot(["display-3", "display-4"], ["ctl-a"]), before);
    await stageController.renameView("wall-b", "Hallway loop 2");
    assert.equal((await viewsOnDisk()).some((v) => v.name === "Booth controls (wall)"), false, "the next write persisted the phantom copy");
  });
});

/** Every screen that is not a control surface but shows a console: the pairing
 *  the server exists to refuse. Empty is the only right answer. */
const forbiddenPairings = () =>
  outputs()
    .filter((o) => outputMode(o) !== "panel" && o.viewId && viewSurface(view(o.viewId)) === "console")
    .map((o) => `${o.id} (${o.mode ?? "display"}) on ${o.viewId}`);

describe("checks hold against a write that lands while they wait", () => {
  // Every check below used to run BEFORE the call joined the output write
  // queue, so two calls could both pass it and both write. Each test starts
  // both calls in the same turn and lets them race.
  it("two screens asking for the same friendly link: one gets it", async () => {
    const results = await Promise.allSettled([
      stageController.createScreen({ name: "Wing A", slug: "wing" }),
      stageController.createScreen({ name: "Wing B", slug: "wing" }),
    ]);
    assert.equal(outputs().filter((o) => o.slug === "wing").length, 1, "two screens hold /wing");
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  });

  it("a friendly link set on one screen while another is made with it", async () => {
    // The screen is made first, so it is setOutputSlug's check that must see it.
    await Promise.allSettled([
      stageController.createScreen({ name: "Wing", slug: "wing" }),
      stageController.setOutputSlug("display-5", "wing"),
    ]);
    assert.equal(outputs().filter((o) => o.slug === "wing").length, 1, "two screens hold /wing");
  });

  it("a wall display made on a view that is turned into a console meanwhile", async () => {
    await Promise.allSettled([
      stageController.createScreen({ name: "Atrium", mode: "display", viewId: "wall-b" }),
      stageController.setViewSurface("wall-b", "console"),
    ]);
    assert.deepEqual(forbiddenPairings(), []);
  });

  it("a role change flipping a view while another screen is made on it", async () => {
    await stageController.setOutputView("display-5", "wall-b");
    await Promise.allSettled([
      stageController.setOutputRole("display-5", "panel"),
      stageController.createScreen({ name: "Atrium", mode: "display", viewId: "wall-b" }),
    ]);
    assert.deepEqual(forbiddenPairings(), []);
  });

  it("a screen's mode and its view changed at once", async () => {
    // A control surface showing a wall view: each change is fine alone, and
    // together they make a wall display showing a console.
    // Both orders: whichever lands second is the one whose check has to see
    // the first.
    for (const viewFirst of [false, true]) {
      await stageController.setOutputMode("display-5", "panel");
      await stageController.setOutputView("display-5", "wall-b");
      const toDisplay = () => stageController.setOutputMode("display-5", "display");
      const toConsole = () => stageController.setOutputView("display-5", "ctl-b");
      await Promise.allSettled(viewFirst ? [toConsole(), toDisplay()] : [toDisplay(), toConsole()]);
      assert.deepEqual(forbiddenPairings(), [], viewFirst ? "the view landed first" : "the mode landed first");
    }
  });

  it("a view only this screen showed is not flipped once another screen shows it", async () => {
    // display-5 alone shows wall-b, so becoming a control surface flips it. A
    // control surface pointed at wall-b meanwhile is a pairing the guards allow,
    // and the flip would turn the view under it into a console it never chose.
    await stageController.setOutputView("display-5", "wall-b");
    await Promise.allSettled([
      stageController.setOutputRole("display-5", "panel"),
      stageController.setOutputView("display-3", "wall-b"),
    ]);
    if (out("display-3").viewId === "wall-b") {
      assert.equal(viewSurface(view("wall-b")), "display", "another screen's view was changed under it");
    }
  });

  it("putting a screen back never makes a pairing the guards refuse", async () => {
    // display-5 is a wall display on a view only it shows, becoming a control
    // surface: the screen leads, then the view's kind. The kind lands in memory
    // and fails, and putting the kind back fails too, so the view is left a
    // console. Putting the screen back as it was would be a wall display on it.
    await stageController.setOutputView("display-5", "wall-b");
    const proto = Object.getPrototypeOf(stageController) as Record<string, (...a: unknown[]) => Promise<unknown>>;
    let calls = 0;
    (stageController as unknown as Record<string, unknown>).setViewSurface = async (id: string, surface: string) => {
      calls += 1;
      if (calls === 1) {
        await proto.setViewSurface.call(stageController, id, surface);
        throw new Error("late failure");
      }
      throw new Error("still failing");
    };
    try {
      await assert.rejects(
        () => stageController.setOutputRole("display-5", "panel"),
        (err: unknown) => {
          assert.ok(err instanceof ScreenWriteError, String(err));
          assert.equal(err.notRolledBack.length, 2, `not rolled back: ${err.notRolledBack.join("; ")}`);
          return true;
        },
      );
    } finally {
      delete (stageController as unknown as Record<string, unknown>).setViewSurface;
    }
    assert.deepEqual(forbiddenPairings(), []);
  });
});

describe("createScreen — a caller's last step that fails", () => {
  // The claim route binds a device as createScreen's last step, so a binding
  // that fails is taken back by the same rollback as everything else.
  const failing = { label: "bind the device", run: async () => { throw new Error("devices file unwritable"); } };

  it("takes back the screen, the view made for it, and an existing view's listing", async () => {
    await assert.rejects(
      () => stageController.createScreen({ name: "Kiosk", mode: "panel", viewId: "ctl-b", showInSidebar: false }, failing),
      (err: unknown) => {
        assert.ok(err instanceof ScreenWriteError, String(err));
        assert.equal(err.failed, "bind the device");
        assert.deepEqual(err.rolledBack.sort(), ["add the screen", "set the sidebar listing"]);
        return true;
      },
    );
    assert.equal(outputs().some((o) => o.name === "Kiosk"), false, "the screen was left behind");
    assert.notEqual(view("ctl-b").showInSidebar, false, "the console was left hidden from the sidebar");
  });

  it("drops the view it made even when that view is the only one", async () => {
    // deleteView refuses the last view; a rollback that could not drop the view
    // it made would not be a rollback.
    ctl.state = { ...ctl.state, views: [] };
    await assert.rejects(() => stageController.createScreen({ name: "Only", mode: "display", newView: true }, failing), ScreenWriteError);
    assert.deepEqual(views(), []);
    assert.equal(outputs().some((o) => o.name === "Only"), false);
  });

  it("hands the step the screen it made", async () => {
    let given: string | null = null;
    const { output } = await stageController.createScreen({ name: "Handed" }, { label: "look", run: async (o) => { given = o.id; } });
    assert.equal(given, output.id);
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
    await assert.rejects(() => stageController.setOutputRole("display-4", "display", { viewId: "ctl-b" }), /cannot go on a wall display/);
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
