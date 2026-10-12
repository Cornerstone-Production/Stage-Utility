// A screen is a control surface exactly when the view it shows is a console, so
// the one way a read-only screen could start rendering live controls is a view
// changing underneath it. That is what these attempt against the real controller:
// pointing a screen at either kind of view, and changing the surface of a view
// that screens show. They deliberately do not scan the source for a check: a
// comment satisfies a source scan, and this repository has shipped a guard that
// passed on exactly that.

import assert from "node:assert/strict";
import { describe, it, before, beforeEach } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-surface-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { stageController } = await import("./stage-controller.js");
const { viewSurface, screenIsControlSurface } = await import("../types/views.js");

type Mutable = {
  state: {
    views: View[];
    outputs: Output[];
    [k: string]: unknown;
  };
  broadcast: () => void;
  recomputeResolved: () => void;
};

const ctl = stageController as unknown as Mutable;

/** Put the controller in a known state without booting the whole app. */
function seed() {
  ctl.state = {
    ...ctl.state,
    views: [
      { id: "vd", name: "Lobby Countdown", kind: "custom", createdAt: "", surface: "display" },
      { id: "vc", name: "FOH Console", kind: "custom", createdAt: "", surface: "console" },
    ] as View[],
    outputs: [
      { id: "wall", name: "Lobby", viewId: null },
      { id: "booth", name: "Booth Touchscreen", viewId: null },
    ] as Output[],
  };
}

before(() => {
  // Neither of these should reach a socket in a unit test.
  ctl.broadcast = () => {};
  ctl.recomputeResolved = () => {};
});

beforeEach(seed);

const isControlSurface = (id: string) => screenIsControlSurface(ctl.state.outputs.find((o) => o.id === id)!, ctl.state.views);

describe("binding a view to a screen", () => {
  it("a screen showing a console is a control surface", async () => {
    // The view decides: there is no second field to set first, and nothing to refuse.
    assert.equal(isControlSurface("wall"), false);
    const s = await stageController.setOutputView("wall", "vc");
    assert.equal(s.outputs.find((o) => o.id === "wall")?.viewId, "vc");
    assert.equal(isControlSurface("wall"), true);
  });

  it("pointing a control surface at a wall view makes it read-only", async () => {
    await stageController.setOutputView("booth", "vc");
    assert.equal(isControlSurface("booth"), true);
    await stageController.setOutputView("booth", "vd");
    assert.equal(isControlSurface("booth"), false);
  });

  it("a screen with no view is read-only", async () => {
    await stageController.setOutputView("booth", "vc");
    await stageController.setOutputView("booth", null);
    assert.equal(isControlSurface("booth"), false);
  });

  it("allows a display view on any screen", async () => {
    assert.equal((await stageController.setOutputView("wall", "vd")).outputs[0].viewId, "vd");
    assert.equal((await stageController.setOutputView("booth", "vd")).outputs[1].viewId, "vd");
  });

  it("refuses Home on any screen, panel or wall", async () => {
    // Home is the operator's front page, not a screen: it has no geometry — it
    // reads presence and order only — so on a monitor it renders a stack of
    // cards sized for a browser column. The Screens picker no longer offers it,
    // but a Companion button or a restored config still can, which is why the
    // check is here and not only in the dropdown.
    ctl.state.views = [
      ...ctl.state.views,
      { id: "home", name: "Home", kind: "custom", createdAt: "", surface: "console" } as View,
    ];
    for (const screen of ["wall", "booth"]) {
      await assert.rejects(
        () => stageController.setOutputView(screen, "home"),
        /front page/i,
        `Home was accepted on ${screen}`,
      );
    }
  });

  it("does not let Home stand in for the operator's last view", async () => {
    // "You cannot delete your last view" counted Home, which is seeded on every
    // install and shown in no list. A fresh box read as 2 views, so deleting the
    // real one was allowed and left an operator with nothing but Home and an
    // empty Screens page.
    ctl.state.views = [
      { id: "only", name: "Stage", kind: "custom", createdAt: "", surface: "display" } as View,
      { id: "home", name: "Home", kind: "custom", createdAt: "", surface: "console" } as View,
    ];
    ctl.state.outputs = [];
    await assert.rejects(
      () => stageController.deleteView("only"),
      /last view/i,
      "the operator's last real view was deleted because Home padded the count",
    );
  });

  it("still allows unrouting", async () => {
    await stageController.setOutputView("booth", "vc");
    const s = await stageController.setOutputView("booth", null);
    assert.equal(s.outputs.find((o) => o.id === "booth")?.viewId, null);
  });
});

describe("converting a view's surface", () => {
  // Converting a view a screen shows changes that screen: a read-only screen goes
  // live, or a control surface stops working. setViewSurface refuses and names the
  // screens; setViewRole is the call that does it once the operator has been asked.
  it("refuses to make a wall view a console while a screen shows it, naming the screen", async () => {
    await stageController.setOutputView("wall", "vd");
    await assert.rejects(
      () => stageController.setViewSurface("vd", "console"),
      (e: Error) => {
        assert.match(e.message, /Lobby/, "the refusal must name the screen it would change, not just say no");
        assert.match(e.message, /control surface/);
        return true;
      },
    );
    assert.equal(viewSurface(ctl.state.views.find((v) => v.id === "vd")!), "display");
    assert.equal(isControlSurface("wall"), false, "a read-only screen went live");
  });

  it("refuses to make a console a wall view while a screen shows it", async () => {
    await stageController.setOutputView("booth", "vc");
    await assert.rejects(() => stageController.setViewSurface("vc", "display"), /Booth Touchscreen/);
    assert.equal(isControlSurface("booth"), true, "a control surface stopped working");
  });

  it("allows converting a view nothing is showing", async () => {
    const s = await stageController.setViewSurface("vd", "console");
    assert.equal(viewSurface(s.views.find((v) => v.id === "vd")!), "console");
  });

  it("names every screen showing it, not just the first", async () => {
    ctl.state.outputs = [
      { id: "a", name: "Lobby", viewId: "vd" },
      { id: "b", name: "Foyer", viewId: "vd" },
    ] as Output[];
    await assert.rejects(
      () => stageController.setViewSurface("vd", "console"),
      (e: Error) => {
        assert.match(e.message, /Lobby/);
        assert.match(e.message, /Foyer/);
        return true;
      },
    );
  });

  it("changes the view and its screens together once the screens are confirmed", async () => {
    await stageController.setOutputView("wall", "vd");
    await stageController.setViewRole("vd", "console");
    assert.equal(isControlSurface("wall"), true);
    await stageController.setViewRole("vd", "display");
    assert.equal(isControlSurface("wall"), false);
  });
});

describe("deleting a view", () => {
  it("takes its notes with it", async () => {
    // notesStore.forget() existed, was tested, and was called by NOTHING — so
    // notes.json would have accumulated the text of every object ever deleted
    // and carried it into every backup. The inline mic-slots beside it were
    // already cleaned up; this is the same rule applied to the same shape.
    const { notesStore } = await import("./notes-store.js");
    ctl.state.views = [
      { id: "v1", name: "Doomed", kind: "custom", createdAt: "", surface: "display",
        layout: { version: 1, canvas: { width: 1920, height: 1080, background: null },
          objects: [
            { id: "n1", x: 0, y: 0, w: 1, h: 1, z: 0, config: { type: "notes" } },
            { id: "box", x: 0, y: 0, w: 1, h: 1, z: 0, config: { type: "container" },
              children: [{ id: "n2", x: 0, y: 0, w: 1, h: 1, z: 0, config: { type: "notes" } }] },
          ] } },
      { id: "v2", name: "Keeper", kind: "custom", createdAt: "", surface: "display" },
    ] as View[];
    ctl.state.outputs = [] as Output[];

    await notesStore.set("n1", { text: "top level" });
    await notesStore.set("n2", { text: "nested in a container" });
    await notesStore.set("other", { text: "belongs to another view" });

    await stageController.deleteView("v1");

    assert.deepEqual(notesStore.get("n1"), {}, "the object's notes must go with it");
    assert.deepEqual(notesStore.get("n2"), {}, "including one nested in a container");
    assert.equal(notesStore.get("other").text, "belongs to another view", "and nothing else may be touched");
  });
});

// Duplicating a view must produce the SAME KIND of thing.
//
// The copy literal listed six fields and the View type has more, so everything
// it forgot was silently dropped. A duplicated console became a display: its
// buttons rendered and did nothing, with no error anywhere.
describe("duplicating a view", () => {
  it("a console duplicates as a console", async () => {
    await stageController.duplicateView("vc");
    const copy = ctl.state.views.find((v) => v.id !== "vc" && v.name.includes("FOH Console"));
    assert.ok(copy, "no copy was made");
    assert.equal(viewSurface(copy), "console", "a duplicated control surface became a display");
  });

  it("carries the ServiceCue layout the source was using", async () => {
    ctl.state.views = [
      ...ctl.state.views,
      { id: "vs", name: "Script", kind: "script", createdAt: "", serviceCueLayoutId: "svl-1" },
    ] as View[];
    await stageController.duplicateView("vs");
    const copy = ctl.state.views.find((v) => v.id !== "vs" && v.name.includes("Script"));
    assert.equal(copy?.serviceCueLayoutId, "svl-1", "the copy lost its ServiceCue layout");
  });

  it("does NOT carry layoutRev", async () => {
    // Deliberate: layoutRev is an optimistic-concurrency token. A fresh view
    // starts at its own revision, and inheriting the source's would make the
    // next save compare against a number that means nothing here.
    ctl.state.views = [
      ...ctl.state.views,
      { id: "vr", name: "Revved", kind: "custom", createdAt: "", surface: "display", layoutRev: 42 },
    ] as View[];
    await stageController.duplicateView("vr");
    const copy = ctl.state.views.find((v) => v.id !== "vr" && v.name.includes("Revved"));
    assert.notEqual(copy?.layoutRev, 42, "the copy inherited the source's revision token");
  });
});
