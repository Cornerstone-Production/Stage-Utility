// Where a cue button lands on a console, and what is said when a console refuses.
//
// The placement is pure and is checked on plain layouts. The writes go through
// the views API in the dialog's own test (new-cue-dialog.test.tsx), against the
// real routes; here the seam is replaced so a refusal can be made to happen.

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import type { LayoutDTO, LayoutObject, View } from "@main/types/views";

import {
  BUTTON_GAP,
  DEFAULT_BUTTON_SIZE,
  addCueButtonToConsoles,
  consoleButtonDeps,
  consolesWithLayouts,
  withCueButton,
} from "./console-cue-buttons.js";

const obj = (over: Partial<LayoutObject> & { config?: LayoutObject["config"] }): LayoutObject => ({
  id: "o",
  x: 0.1,
  y: 0.1,
  w: 0.2,
  h: 0.1,
  z: 1,
  config: { type: "clock" } as LayoutObject["config"],
  ...over,
});
const layoutOf = (...objects: LayoutObject[]): LayoutDTO => ({ version: 1, canvas: { width: 1920, height: 1080 }, objects });
const button = (id: string, over: Partial<LayoutObject> = {}): LayoutObject =>
  obj({ id, config: { type: "cue-button", cue: "other" }, style: { fontSize: 0.07 }, ...over });

const added = (l: LayoutDTO): LayoutObject => l.objects.at(-1)!;

describe("withCueButton", () => {
  test("goes under the lowest object, in the last button's column, sized and styled like it", () => {
    const l = layoutOf(
      obj({ id: "clock", y: 0.05, h: 0.2 }),
      button("b1", { x: 0.05, y: 0.3, w: 0.4, h: 0.12, z: 2 }),
      button("b2", { x: 0.55, y: 0.5, w: 0.35, h: 0.14, z: 3 }),
    );
    const { layout, overEdge } = withCueButton(l, "projectors_on_cue", "Projectors on");
    const b = added(layout);
    assert.equal(layout.objects.length, 4);
    assert.equal(overEdge, false);
    assert.deepEqual(b.config, { type: "cue-button", cue: "projectors_on_cue", label: "Projectors on", showDevice: true });
    assert.equal(b.w, 0.35, "sized like the last button");
    assert.equal(b.h, 0.14);
    assert.equal(b.x, 0.55, "in the last button's column");
    assert.ok(Math.abs(b.y - (0.5 + 0.14 + BUTTON_GAP)) < 1e-9, `at ${b.y}`);
    assert.deepEqual(b.style, { fontSize: 0.07 }, "styled like the last button");
    assert.equal(b.z, 4, "in front of everything");
  });

  test("the original layout is not changed", () => {
    const l = layoutOf(button("b1"));
    withCueButton(l, "x", "");
    assert.equal(l.objects.length, 1);
  });

  test("with no button to copy: the default size, centred", () => {
    const { layout } = withCueButton(layoutOf(obj({ id: "clock", y: 0.05, h: 0.2 })), "x", "");
    const b = added(layout);
    assert.equal(b.w, DEFAULT_BUTTON_SIZE.w);
    assert.equal(b.h, DEFAULT_BUTTON_SIZE.h);
    assert.ok(Math.abs(b.x - (1 - DEFAULT_BUTTON_SIZE.w) / 2) < 1e-9, `at x ${b.x}`);
    assert.ok(Math.abs(b.y - (0.25 + BUTTON_GAP)) < 1e-9, `at y ${b.y}`);
    assert.equal(b.config.type, "cue-button");
    assert.ok(b.style && Object.keys(b.style).length > 0, "no default style");
  });

  test("an empty layout puts it along the bottom edge", () => {
    const { layout, overEdge } = withCueButton(layoutOf(), "x", "");
    const b = added(layout);
    assert.equal(overEdge, false);
    assert.ok(Math.abs(b.y + b.h - (1 - BUTTON_GAP)) < 1e-9, `bottom at ${b.y + b.h}`);
  });

  test("any kind of button is a button to copy, and an object that is not one is not", () => {
    const l = layoutOf(
      obj({ id: "act", config: { type: "action-button", actionId: "log.message" }, w: 0.5, h: 0.2, y: 0.1 }),
      obj({ id: "clock", w: 0.9, h: 0.05, y: 0.4 }),
    );
    const b = added(withCueButton(l, "x", "").layout);
    assert.equal(b.w, 0.5);
    assert.equal(b.h, 0.2);
  });

  test("with no room below, it is against the bottom edge and says it overlaps", () => {
    const l = layoutOf(obj({ id: "wall", y: 0.1, h: 0.85 }), button("b", { y: 0.2, h: 0.2, x: 0.3, w: 0.3 }));
    const { layout, overEdge } = withCueButton(l, "x", "");
    const b = added(layout);
    assert.equal(overEdge, true);
    assert.ok(Math.abs(b.y + b.h - 1) < 1e-9, `bottom at ${b.y + b.h}`);
  });

  test("a nested object does not move the bottom: its box is a fraction of its container's", () => {
    const l = layoutOf(
      obj({ id: "box", y: 0.1, h: 0.2, config: { type: "container" } as LayoutObject["config"], children: [obj({ id: "inner", y: 0.9, h: 0.5 })] }),
    );
    const b = added(withCueButton(l, "x", "").layout);
    assert.ok(Math.abs(b.y - (0.3 + BUTTON_GAP)) < 1e-9, `at ${b.y}`);
  });
});

describe("consolesWithLayouts", () => {
  const v = (id: string, over: Partial<View>): View => ({ id, name: id, kind: "custom", createdAt: "", ...over });
  test("a custom console only: not a wall view, not a calendar console", () => {
    const views = [
      v("a", { surface: "console" }),
      v("b", {}),
      v("c", { surface: "console", kind: "calendar" }),
      v("d", { surface: "console", kind: "slots" }),
    ];
    assert.deepEqual(consolesWithLayouts(views).map((x) => x.id), ["a"]);
  });
});

describe("addCueButtonToConsoles", () => {
  const original = { ...consoleButtonDeps };
  afterEach(() => Object.assign(consoleButtonDeps, original));

  const console1 = (id: string, rev = 1): View => ({
    id,
    name: `Console ${id}`,
    kind: "custom",
    surface: "console",
    createdAt: "",
    layout: layoutOf(button("b")),
    layoutRev: rev,
  });

  test("one failure does not stop the next, and each console gets its own result", async () => {
    const written: string[] = [];
    consoleButtonDeps.readViews = async () => [console1("a"), console1("b"), console1("c")];
    consoleButtonDeps.writeLayout = async (id) => {
      if (id === "b") throw new Error("the disk is full");
      written.push(id);
    };
    const results = await addCueButtonToConsoles(["a", "b", "c"], "x", "");
    assert.deepEqual(written, ["a", "c"]);
    assert.deepEqual(
      results.map((r) => [r.viewId, r.ok, r.error ?? ""]),
      [["a", true, ""], ["b", false, "the disk is full"], ["c", true, ""]],
    );
    assert.equal(results[1].name, "Console b", "the failure names the console");
  });

  test("a stale revision is retried once from a fresh read, and then reported", async () => {
    const revs: (number | undefined)[] = [];
    let reads = 0;
    consoleButtonDeps.readViews = async () => [console1("a", ++reads)];
    consoleButtonDeps.writeLayout = async (_id, _layout, rev) => {
      revs.push(rev);
      throw Object.assign(new Error("changed by someone else"), { status: 409 });
    };
    const results = await addCueButtonToConsoles(["a"], "x", "");
    assert.deepEqual(revs, [1, 2], "the retry must carry the fresh revision");
    assert.equal(results[0].ok, false);
    assert.equal(results[0].error, "changed by someone else");

    const again: (number | undefined)[] = [];
    reads = 0;
    let first = true;
    consoleButtonDeps.writeLayout = async (_id, _layout, rev) => {
      again.push(rev);
      if (first) {
        first = false;
        throw Object.assign(new Error("stale"), { status: 409 });
      }
    };
    const retried = await addCueButtonToConsoles(["a"], "x", "");
    assert.deepEqual(again, [1, 2]);
    assert.equal(retried[0].ok, true, "the retry succeeded, so the console is written");
  });

  test("a console that is gone, or no longer has a layout, is a result and not a throw", async () => {
    consoleButtonDeps.readViews = async () => [{ ...console1("a"), surface: "display" }];
    consoleButtonDeps.writeLayout = async () => assert.fail("nothing should be written");
    const results = await addCueButtonToConsoles(["gone", "a"], "x", "");
    assert.deepEqual(results.map((r) => [r.viewId, r.ok]), [["gone", false], ["a", false]]);
    assert.match(results[0].error ?? "", /no longer exists/);
    assert.match(results[1].error ?? "", /no longer a console/);
  });

  test("a read that fails is that console's failure", async () => {
    consoleButtonDeps.readViews = async () => {
      throw new Error("server down");
    };
    const results = await addCueButtonToConsoles(["a"], "x", "");
    assert.equal(results[0].ok, false);
    assert.equal(results[0].error, "server down");
  });
});
