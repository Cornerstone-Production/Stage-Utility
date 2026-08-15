// A wall display must not be able to render a live control. That property lives
// on the SERVER, not in the settings dropdown: a dropdown that only offers
// bindable views makes the mistake hard to reach, but an API call, a Companion
// button or a restored config can still ask for it.
//
// So these ATTEMPT the binding against the real controller and assert the
// refusal. They deliberately do not scan the source for the check — a comment
// satisfies a source scan, and this repository has shipped a guard that passed
// on exactly that.

import assert from "node:assert/strict";
import { describe, it, before, beforeEach } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-surface-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { stageController } = await import("./stage-controller.js");
const { viewSurface, outputMode } = await import("../types/views.js");

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
      { id: "booth", name: "Booth Touchscreen", viewId: null, mode: "panel" },
    ] as Output[],
  };
}

before(() => {
  // Neither of these should reach a socket in a unit test.
  ctl.broadcast = () => {};
  ctl.recomputeResolved = () => {};
});

beforeEach(seed);

describe("binding a view to a screen", () => {
  it("refuses a console view on a display screen", async () => {
    await assert.rejects(
      () => stageController.setOutputView("wall", "vc"),
      /console/i,
      "a console on a wall screen must be refused, not silently allowed",
    );
  });

  it("names both sides and what to do about it", async () => {
    // A refusal that just says no leaves the operator guessing which of the two
    // things they touched was wrong.
    await assert.rejects(
      () => stageController.setOutputView("wall", "vc"),
      (e: Error) => {
        assert.match(e.message, /FOH Console/, "must name the view");
        assert.match(e.message, /Lobby/, "must name the screen");
        // The exact words the screen's menu uses. An instruction naming
        // something the operator cannot find is worse than no instruction —
        // this refusal used to say "panel mode", which appears nowhere in the UI.
        assert.match(e.message, /Use as a touch panel/, "must name the menu item, in its words");
        assert.ok(!/^\w+:\w+ —/.test(e.message), "must not carry the internal handler name");
        return true;
      },
    );
  });

  it("allows a console view on a panel", async () => {
    const s = await stageController.setOutputView("booth", "vc");
    assert.equal(s.outputs.find((o) => o.id === "booth")?.viewId, "vc");
  });

  it("allows a display view on either", async () => {
    // A panel is a superset: it accepts both. Only the wall is restricted.
    assert.equal((await stageController.setOutputView("wall", "vd")).outputs[0].viewId, "vd");
    assert.equal((await stageController.setOutputView("booth", "vd")).outputs[1].viewId, "vd");
  });

  it("still allows unrouting", async () => {
    await stageController.setOutputView("booth", "vc");
    const s = await stageController.setOutputView("booth", null);
    assert.equal(s.outputs.find((o) => o.id === "booth")?.viewId, null);
  });
});

describe("changing a screen's mode", () => {
  it("promotes a display to a panel", async () => {
    const s = await stageController.setOutputMode("wall", "panel");
    assert.equal(outputMode(s.outputs.find((o) => o.id === "wall")!), "panel");
  });

  it("refuses to demote a panel that is showing a console", async () => {
    // Demoting would leave a screen bound to a view it may not render. Refusing
    // is better than silently unbinding: a blank screen with no reason given is
    // discovered on Sunday morning.
    await stageController.setOutputView("booth", "vc");
    await assert.rejects(
      () => stageController.setOutputMode("booth", "display"),
      /showing the control surface/i,
    );
  });

  it("allows demoting a panel that is showing nothing", async () => {
    const s = await stageController.setOutputMode("booth", "display");
    assert.equal(outputMode(s.outputs.find((o) => o.id === "booth")!), "display");
  });
});

describe("converting a view's surface", () => {
  it("refuses to convert a view that a display screen is showing", async () => {
    await stageController.setOutputView("wall", "vd");
    await assert.rejects(
      () => stageController.setViewSurface("vd", "console"),
      /Lobby/,
      "the refusal must name the screen it would strand, not just say no",
    );
  });

  it("allows converting a view nothing is showing", async () => {
    const s = await stageController.setViewSurface("vd", "console");
    assert.equal(viewSurface(s.views.find((v) => v.id === "vd")!), "console");
  });

  it("allows converting a view only panels are showing", async () => {
    await stageController.setOutputView("booth", "vd");
    const s = await stageController.setViewSurface("vd", "console");
    assert.equal(viewSurface(s.views.find((v) => v.id === "vd")!), "console");
  });

  it("names every stranded screen, not just the first", async () => {
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

  it("always allows converting back to a display", async () => {
    // Demotion is the safe direction and must never be blocked - it is the
    // action the migration log tells an operator to take.
    await stageController.setOutputView("booth", "vc");
    const s = await stageController.setViewSurface("vc", "display");
    assert.equal(viewSurface(s.views.find((v) => v.id === "vc")!), "display");
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
