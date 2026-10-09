// The question asked before a view's role changes every screen showing it.
// Drives the real function with a fake dialog and a fake send, and reads what
// was asked and what was sent.
//
// Every id and name is invented.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { StageState } from "@main/types/stage";
import { changeViewRole, screensChangedBy, viewRoleQuestion } from "./view-role-change";

type Slim = Pick<StageState, "views" | "outputs">;
const state = {
  views: [
    { id: "wall-a", name: "Lobby loop", kind: "custom", surface: "display" },
    { id: "ctl-a", name: "Booth controls", kind: "custom", surface: "console" },
    { id: "wall-b", name: "Unplaced loop", kind: "custom", surface: "display" },
  ],
  outputs: [
    { id: "display-1", name: "Lobby TV", viewId: "wall-a" },
    { id: "display-2", name: "Hallway TV", viewId: "wall-a", mode: "display" },
    { id: "display-3", name: "Booth panel", viewId: "ctl-a", mode: "panel" },
    { id: "display-4", name: "", viewId: "ctl-a", mode: "panel" },
    { id: "display-5", name: "Spare", viewId: null },
  ],
} as unknown as Slim;

/** A harness: what was asked, what was sent, and how the operator answers. */
function run(viewId: string, surface: "display" | "console", answer: boolean, sendOk = true) {
  const asked: { title: string; message?: string; confirmLabel?: string }[] = [];
  let sent = 0;
  const result = changeViewRole({
    state,
    viewId,
    surface,
    ask: async (q) => { asked.push(q); return answer; },
    send: async () => { sent += 1; return sendOk; },
  });
  return { result, asked, sent: () => sent };
}

describe("changing a view to a control surface", () => {
  it("names the screens that will change, in the confirm", async () => {
    const h = run("wall-a", "console", true);
    await h.result;
    assert.deepEqual(h.asked, [{
      title: 'Make "Lobby loop" a control surface?',
      message: "Lobby TV and Hallway TV will become control surfaces. Anyone at them can press their buttons.",
      confirmLabel: "Make them control surfaces",
    }]);
  });

  it("sends the change once it is confirmed", async () => {
    const h = run("wall-a", "console", true);
    assert.equal(await h.result, true);
    assert.equal(h.sent(), 1);
  });

  it("sends NOTHING when it is declined", async () => {
    const h = run("wall-a", "console", false);
    assert.equal(await h.result, false);
    assert.equal(h.sent(), 0);
  });

  it("does not name a screen already a control surface, or one on another view", () => {
    assert.deepEqual(screensChangedBy(state, "ctl-a", "console"), []);
    assert.deepEqual(screensChangedBy(state, "wall-a", "console"), ["Lobby TV", "Hallway TV"]);
  });
});

describe("changing a view to a wall display", () => {
  it("names the screens, falling back to the id for one with no name", async () => {
    const h = run("ctl-a", "display", true);
    await h.result;
    assert.deepEqual(h.asked, [{
      title: 'Make "Booth controls" a wall display?',
      message: "Booth panel and display-4 will become wall displays. Their buttons will stop working.",
      confirmLabel: "Make them wall displays",
    }]);
  });

  it("says it in the singular for one screen", () => {
    assert.deepEqual(viewRoleQuestion("Booth controls", "display", ["Booth panel"]), {
      title: 'Make "Booth controls" a wall display?',
      message: "Booth panel will become a wall display. Its buttons will stop working.",
      confirmLabel: "Make it a wall display",
    });
    assert.equal(
      viewRoleQuestion("Lobby loop", "console", ["Lobby TV"])?.message,
      "Lobby TV will become a control surface. Anyone at it can press its buttons.",
    );
  });

  it("lists three or more with commas and a closing and", () => {
    assert.equal(
      viewRoleQuestion("Lobby loop", "console", ["A", "B", "C"])?.message,
      "A, B and C will become control surfaces. Anyone at them can press their buttons.",
    );
  });

  it("sends NOTHING when it is declined", async () => {
    const h = run("ctl-a", "display", false);
    await h.result;
    assert.equal(h.sent(), 0);
  });
});

describe("a view no screen shows, or one already as asked", () => {
  it("asks nothing and sends the change", async () => {
    const h = run("wall-b", "console", false);
    assert.equal(await h.result, true);
    assert.deepEqual(h.asked, []);
    assert.equal(h.sent(), 1);
  });

  it("asks nothing when every screen already matches", async () => {
    const h = run("ctl-a", "console", false);
    await h.result;
    assert.deepEqual(h.asked, []);
  });

  it("answers false when the server refused, so the caller can tell", async () => {
    const h = run("wall-b", "console", true, false);
    assert.equal(await h.result, false);
  });
});
