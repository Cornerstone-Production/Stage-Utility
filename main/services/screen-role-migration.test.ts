import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { carriesStoredRole, planScreenRoles, type StoredOutput } from "./screen-role-migration.js";
import { screenIsControlSurface, viewSurface } from "../types/views.js";

// A screen's role now comes from its view. This takes the role an older build
// stored on the screen out of the data, and the property it must keep is the one
// nothing else notices: a screen that was read-only never becomes live, and one
// whose buttons worked keeps them. Each case is asserted in those terms, "was it
// live before, is it live after", not as field values.

const view = (id: string, over: Partial<View> = {}): View =>
  ({ id, name: id, kind: "custom", surface: "display", createdAt: "", ...over }) as View;
const screen = (id: string, viewId: string | null, mode?: string): StoredOutput =>
  ({ id, name: id, viewId, ...(mode === undefined ? {} : { mode }) }) as StoredOutput;

/** Apply a plan the way the controller does, minus the I/O: flips, then copies. */
function applied(plan: ReturnType<typeof planScreenRoles>, views: View[]) {
  let nextViews = views.map((v) => (plan.consoleViewIds.includes(v.id) ? { ...v, surface: "console" as const } : v));
  let outputs = plan.outputs;
  plan.copies.forEach((c, i) => {
    nextViews = [...nextViews, view(`copy-${i}`, { name: c.name, surface: c.surface })];
    outputs = outputs.map((o) => (c.screenIds.includes(o.id) ? { ...o, viewId: `copy-${i}` } : o));
  });
  return { views: nextViews, outputs };
}


describe("screens that already agree with their view", () => {
  const views = [view("wall"), view("ctl", { surface: "console" })];

  test("the stored role is dropped and nothing else changes", () => {
    const outputs = [screen("a", "wall", "display"), screen("b", "ctl", "panel")];
    const plan = planScreenRoles(views, outputs, { absentIsDisplay: false });
    assert.equal(plan.changed, 0);
    assert.deepEqual(plan.copies, []);
    assert.deepEqual(plan.consoleViewIds, []);
    assert.deepEqual(plan.outputs.map((o) => "mode" in o), [false, false]);
    const after = applied(plan, views);
    assert.deepEqual(after.views, views);
    assert.deepEqual(after.outputs.map((o) => o.viewId), ["wall", "ctl"]);
  });

  test("a screen with no view, or a view that is gone, just loses the role", () => {
    const plan = planScreenRoles(views, [screen("a", null, "panel"), screen("b", "deleted", "panel")], { absentIsDisplay: true });
    assert.equal(plan.changed, 0);
    assert.deepEqual(plan.outputs.map((o) => [o.viewId, "mode" in o]), [[null, false], ["deleted", false]]);
  });

  test("an unrecognised role reads as read-only, as it always did", () => {
    const plan = planScreenRoles(views, [screen("a", "ctl", "hologram")], { absentIsDisplay: false });
    assert.equal(plan.copies.length, 1, "a console on a screen that was never a panel must be copied, not woken");
  });
});

describe("a read-only screen on a console", () => {
  const views = [view("ctl", { name: "Booth controls", surface: "console" })];

  test("keeps showing it read-only, through a wall copy", () => {
    const outputs = [screen("a", "ctl", "display")];
    const plan = planScreenRoles(views, outputs, { absentIsDisplay: false });
    assert.deepEqual(plan.copies, [{ sourceViewId: "ctl", name: "Booth controls (wall)", surface: "display", screenIds: ["a"] }]);
    const after = applied(plan, views);
    assert.equal(screenIsControlSurface(after.outputs[0], after.views), false, "a read-only screen went live");
    assert.equal(viewSurface(after.views.find((v) => v.id === "ctl")!), "console", "the console itself is untouched");
  });

  test("screens that were read-only on the same console share one copy", () => {
    const plan = planScreenRoles(views, [screen("a", "ctl", "display"), screen("b", "ctl", "display")], { absentIsDisplay: false });
    assert.deepEqual(plan.copies.map((c) => c.screenIds), [["a", "b"]]);
  });

  test("a live screen on the same console is left on it", () => {
    const outputs = [screen("a", "ctl", "display"), screen("b", "ctl", "panel")];
    const plan = planScreenRoles(views, outputs, { absentIsDisplay: false });
    const after = applied(plan, views);
    assert.deepEqual(after.outputs.map((o) => screenIsControlSurface(o, after.views)), [false, true]);
  });

  test("a screen that never had a role is read-only too, on the first pass only", () => {
    const outputs = [screen("a", "ctl")];
    const first = planScreenRoles(views, outputs, { absentIsDisplay: true });
    assert.equal(first.copies.length, 1, "a console on a screen that never said so was read-only");
    const later = planScreenRoles(views, outputs, { absentIsDisplay: false });
    assert.equal(later.copies.length, 0, "a screen made after the upgrade has no role and shows its console live");
    assert.equal(later.outputs[0], outputs[0], "an untouched screen is not rebuilt");
  });
});

describe("a live screen on a wall view", () => {
  test("the view becomes a console when only live screens show it, and no copy is made", () => {
    const views = [view("wall", { name: "Lobby loop" })];
    const outputs = [screen("a", "wall", "panel"), screen("b", "wall", "panel")];
    const plan = planScreenRoles(views, outputs, { absentIsDisplay: false });
    assert.deepEqual(plan.consoleViewIds, ["wall"]);
    assert.deepEqual(plan.copies, []);
    const after = applied(plan, views);
    assert.deepEqual(after.outputs.map((o) => screenIsControlSurface(o, after.views)), [true, true]);
  });

  test("a read-only screen on the same view is never woken: the live screens get a control-surface copy", () => {
    const views = [view("wall", { name: "Lobby loop" })];
    const outputs = [screen("a", "wall", "panel"), screen("b", "wall", "display"), screen("c", "wall")];
    for (const absentIsDisplay of [true, false]) {
      const plan = planScreenRoles(views, outputs, { absentIsDisplay });
      assert.deepEqual(plan.consoleViewIds, [], "the shared view was made a console under a read-only screen");
      assert.deepEqual(plan.copies.map((c) => [c.name, c.surface, c.screenIds]), [["Lobby loop (control surface)", "console", ["a"]]]);
      const after = applied(plan, views);
      assert.deepEqual(after.outputs.map((o) => screenIsControlSurface(o, after.views)), [true, false, false]);
      assert.equal(viewSurface(after.views.find((v) => v.id === "wall")!), "display");
    }
  });

  test("a view that is not a custom view has no buttons to keep: only the role goes", () => {
    const views = [view("cal", { kind: "calendar" })];
    const plan = planScreenRoles(views, [screen("a", "cal", "panel")], { absentIsDisplay: false });
    assert.deepEqual([plan.consoleViewIds, plan.copies, plan.changed], [[], [], 0]);
    assert.equal("mode" in plan.outputs[0], false);
  });
});

describe("the principle, over every combination", () => {
  test("no screen that was read-only is live afterwards, and none that was live loses its buttons on a custom view", () => {
    const stored = [undefined, "display", "panel", "hologram"];
    const kinds = [
      { surface: "display" as const, kind: "custom" },
      { surface: "console" as const, kind: "custom" },
      { surface: "display" as const, kind: "calendar" },
    ];
    for (const absentIsDisplay of [true, false]) {
      for (const k of kinds) {
        for (const a of stored) {
          for (const b of stored) {
            const views = [view("v", { surface: k.surface, kind: k.kind as View["kind"] })];
            const outputs = [screen("a", "v", a), screen("b", "v", b)];
            const plan = planScreenRoles(views, outputs, { absentIsDisplay });
            const after = applied(plan, views);
            for (const [i, o] of outputs.entries()) {
              const live = screenIsControlSurface(after.outputs[i], after.views);
              const label = `${JSON.stringify([k, a, b, absentIsDisplay])} screen ${o.id}`;
              const before = o.mode === "panel" || (!absentIsDisplay && o.mode === undefined && k.surface === "console");
              if (!before) assert.equal(live, false, `a read-only screen went live: ${label}`);
              if (before && k.kind === "custom") assert.equal(live, true, `a live screen lost its buttons: ${label}`);
            }
            assert.equal(carriesStoredRole(plan.outputs), false, "a role was left in the data");
          }
        }
      }
    }
  });

  test("a second pass finds nothing", () => {
    const views = [view("ctl", { surface: "console" }), view("wall")];
    const outputs = [screen("a", "ctl", "display"), screen("b", "wall", "panel"), screen("c", "wall")];
    const first = planScreenRoles(views, outputs, { absentIsDisplay: true });
    const after = applied(first, views);
    const second = planScreenRoles(after.views, after.outputs, { absentIsDisplay: false });
    assert.equal(second.changed, 0);
    assert.deepEqual(second.copies, []);
    assert.deepEqual(second.notes, []);
    assert.equal(second.outputs.every((o, i) => o === after.outputs[i]), true);
  });
});

describe("what it reports", () => {
  test("names each screen it had to do something for", () => {
    const views = [view("ctl", { name: "Booth controls", surface: "console" })];
    const plan = planScreenRoles(views, [{ ...screen("a", "ctl", "display"), name: "Lobby TV" }], { absentIsDisplay: false });
    assert.equal(plan.notes.length, 1);
    assert.match(plan.notes[0], /"Lobby TV".*"Booth controls".*"Booth controls \(wall\)".*read-only/);
    assert.deepEqual([plan.checked, plan.changed], [1, 1]);
  });
});
