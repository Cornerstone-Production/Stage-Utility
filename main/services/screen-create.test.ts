// createScreen, driven against the real controller and real files in a temp data
// directory.
//
// What these are here for, in the order it would have gone wrong:
//
//  - A screen made in several writes that fails part-way and leaves a piece
//    behind: an empty screen, or a view nobody asked for. Every failure test
//    reads settings.json and views.json back off DISK, because the in-memory
//    state is what the rollback fixes first and the file is what a restart reads.
//  - A refusal that comes AFTER something was written. Validation is asserted to
//    leave no trace at all.
//  - A screen's role. It is a control surface when the view it shows is a console,
//    so what is asserted is the view a screen was given, read through the one
//    function every reader uses.
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
      { id: "wall-b", name: "Hallway loop", kind: "custom", surface: "display", createdAt: NOW, layout },
      { id: "ctl-a", name: "Booth controls", kind: "custom", surface: "console", createdAt: NOW, layout },
      { id: "ctl-b", name: "Stage controls", kind: "custom", surface: "console", createdAt: NOW, layout },
    ] as unknown as View[],
    outputs: [
      { id: "display-1", name: "Lobby TV", viewId: "wall-a" },
      { id: "display-2", name: "Hallway TV", viewId: "wall-a" },
      { id: "display-3", name: "Booth panel", viewId: "ctl-a" },
      { id: "display-4", name: "Stage panel", viewId: "ctl-a" },
      { id: "display-5", name: "Spare", viewId: null },
    ] as unknown as Output[],
  };
  ctl.recomputeResolved();
}
beforeEach(seed);

const outputs = () => stageController.getState().outputs;
const views = () => stageController.getState().views;
const view = (id: string) => views().find((v) => v.id === id)!;
const isControlSurface = (o: Output) => screenIsControlSurface(o, views());

async function readDisk<T>(file: string, pick: (raw: unknown) => T): Promise<T> {
  return pick(JSON.parse(await fs.readFile(path.join(TMP, file), "utf8")));
}
const outputsOnDisk = () => readDisk("settings.json", (r) => ((r as { outputs?: Output[] }).outputs ?? []));
const viewsOnDisk = () =>
  readDisk("views.json", (r) => (Array.isArray(r) ? (r as View[]) : ((r as { views?: View[] }).views ?? [])));

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

describe("createScreen — { name, viewId }", () => {
  it("makes a screen routed to the view, with no view made", async () => {
    const { output } = await stageController.createScreen({ name: "Cafe TV", viewId: "wall-b" });
    assert.equal(output.name, "Cafe TV");
    assert.equal(output.viewId, "wall-b");
    assert.equal("mode" in output, false, "a screen has no stored role");
    assert.equal(isControlSurface(output), false);
    assert.equal(views().length, 4, "no view may be made for a call that did not ask for one");
  });

  it("a screen made on a console is a control surface: the view decides", async () => {
    const { output } = await stageController.createScreen({ name: "Wing panel", viewId: "ctl-b" });
    assert.equal(output.viewId, "ctl-b");
    assert.equal(isControlSurface(output), true);
    assert.equal((await outputsOnDisk()).find((o) => o.id === output.id)?.viewId, "ctl-b", "not written to settings.json");
    assert.equal("mode" in ((await outputsOnDisk()).find((o) => o.id === output.id) ?? {}), false);
  });

  it("names the screen 'Display N' when no name is given, and shows nothing", async () => {
    const { output } = await stageController.createScreen({});
    assert.match(output.name, /^Display \d+$/);
    assert.equal(output.viewId, null);
    assert.equal(isControlSurface(output), false);
  });

  it("refuses a view that does not exist, and Home, and writes nothing", async () => {
    await assert.rejects(() => stageController.createScreen({ viewId: "ghost" }), /not found/);
    await assert.rejects(() => stageController.createScreen({ viewId: "home" }), /front page/);
    assert.equal(outputs().length, 5);
  });

  it("refuses a view AND a new view", async () => {
    await assert.rejects(
      () => stageController.createScreen({ viewId: "wall-a", newView: "wall" }),
      /alternatives/,
    );
    assert.equal(outputs().length, 5);
  });

  it("refuses a newView that is neither kind", async () => {
    await assert.rejects(() => stageController.createScreen({ newView: "kiosk" as never }), /newView must be/);
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
    const { output, createdViewId } = await stageController.createScreen({ name: "Green room", newView: "control" });
    assert.ok(createdViewId);
    const made = view(createdViewId!);
    assert.equal(made.name, "Green room");
    assert.equal(made.kind, "custom");
    assert.equal(viewSurface(made), "console");
    assert.equal(output.viewId, createdViewId);
    assert.equal(isControlSurface(output), true);
    assert.ok((await viewsOnDisk()).some((v) => v.id === createdViewId), "the view is not in views.json");
  });

  it("makes a wall-screen view for a wall display", async () => {
    const { output, createdViewId } = await stageController.createScreen({ name: "Atrium", newView: "wall" });
    assert.equal(viewSurface(view(createdViewId!)), "display");
    assert.equal(isControlSurface(output), false);
  });
});

describe("createScreen — the sidebar listing", () => {
  it("lists nothing in the sidebar when told not to, on a view made for the screen", async () => {
    const { createdViewId } = await stageController.createScreen({ name: "Quiet", newView: "control", showInSidebar: false });
    assert.equal(view(createdViewId!).showInSidebar, false);
    assert.equal((await viewsOnDisk()).find((v) => v.id === createdViewId)?.showInSidebar, false);
  });

  it("writes it on an existing control-surface view the screen shows", async () => {
    await stageController.createScreen({ name: "Quiet", viewId: "ctl-b", showInSidebar: false });
    assert.equal(view("ctl-b").showInSidebar, false);
  });

  it("refuses a listing where no control surface will be shown, rather than dropping it", async () => {
    // The listing belongs to a control surface's view. Sent where there is none,
    // it used to be accepted and silently ignored.
    await assert.rejects(
      () => stageController.createScreen({ name: "Wall", viewId: "wall-b", showInSidebar: false }),
      /showInSidebar/,
    );
    await assert.rejects(() => stageController.createScreen({ name: "Wallnew", newView: "wall", showInSidebar: false }), /showInSidebar/);
    await assert.rejects(() => stageController.createScreen({ name: "Bare", showInSidebar: false }), /showInSidebar/);
    assert.equal(view("wall-b").showInSidebar, undefined);
    assert.equal(outputs().length, 5, "a screen was made");
  });
});

describe("createScreen — a write that fails part-way is taken back", () => {
  it("removes the screen AND the view it made, and says what it undid", async () => {
    const restore = failNext("setViewShowInSidebar", "disk full");
    try {
      await assert.rejects(
        () => stageController.createScreen({ name: "Doomed", newView: "control", showInSidebar: false }),
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
        () => stageController.createScreen({ name: "Late", viewId: "ctl-b", showInSidebar: false }),
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
      assert.rejects(() => stageController.createScreen({ name: "Phantom" }), ScreenWriteError));
    assert.equal(outputs().some((o) => o.name === "Phantom"), false, "the screen is still in memory");
    // The next write that lands must not carry it to disk.
    await stageController.renameOutput("display-1", "Lobby TV again");
    assert.equal((await outputsOnDisk()).some((o) => o.name === "Phantom"), false, "the next write persisted the phantom screen");
  });

  it("a view made for a screen, whose views.json write fails", async () => {
    await stageController.renameView("wall-b", "Hallway loop"); // views.json exists and is cached
    const before = views().length;
    await withUnwritable("views.json", () =>
      assert.rejects(() => stageController.createScreen({ name: "Lost", newView: "control" }), ScreenWriteError));
    assert.equal(views().length, before, "the view made for the screen is still in memory");
    assert.equal(outputs().some((o) => o.name === "Lost"), false);
    await stageController.renameView("wall-b", "Hallway loop 2");
    assert.equal((await viewsOnDisk()).some((v) => v.name === "Lost"), false, "the next write persisted the phantom view");
  });
});

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
});

describe("createScreen — a caller's last step that fails", () => {
  // The claim route binds a device as createScreen's last step, so a binding
  // that fails is taken back by the same rollback as everything else.
  const failing = { label: "bind the device", run: async () => { throw new Error("devices file unwritable"); } };

  it("takes back the screen, the view made for it, and an existing view's listing", async () => {
    await assert.rejects(
      () => stageController.createScreen({ name: "Kiosk", viewId: "ctl-b", showInSidebar: false }, failing),
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
    await assert.rejects(() => stageController.createScreen({ name: "Only", newView: "wall" }, failing), ScreenWriteError);
    assert.deepEqual(views(), []);
    assert.equal(outputs().some((o) => o.name === "Only"), false);
  });

  it("hands the step the screen it made", async () => {
    let given: string | null = null;
    const { output } = await stageController.createScreen({ name: "Handed" }, { label: "look", run: async (o) => { given = o.id; } });
    assert.equal(given, output.id);
  });
});
