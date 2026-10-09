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

/** A harness: what was asked, what was sent, and how the operator answers.
 *  `replies` answers each send in turn: undefined lands, an Error is thrown. */
function run(viewId: string, surface: "display" | "console", answer: boolean | boolean[], replies: (Error | undefined)[] = []) {
  const asked: { title: string; message?: string; confirmLabel?: string }[] = [];
  const sent: string[][] = [];
  const answers = Array.isArray(answer) ? [...answer] : null;
  const result = changeViewRole({
    state,
    viewId,
    surface,
    ask: async (q) => { asked.push(q); return answers ? answers.shift()! : (answer as boolean); },
    send: async (screens) => {
      sent.push(screens);
      const reply = replies[sent.length - 1];
      if (reply) throw reply;
    },
  });
  return { result, asked, sent: () => sent.length, sentScreens: () => sent };
}

/** The 409 the server answers when the screens asked about are stale. */
function screensChanged(screens: { id: string; name: string }[]): Error {
  return Object.assign(new Error("The screens showing this view changed while you were deciding."), {
    status: 409,
    code: "screens-changed",
    body: { error: "x", code: "screens-changed", screens },
  });
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

  it("sends the change once it is confirmed, with the ids of the screens it named", async () => {
    const h = run("wall-a", "console", true);
    assert.equal(await h.result, true);
    assert.deepEqual(h.sentScreens(), [["display-1", "display-2"]]);
  });

  it("sends NOTHING when it is declined", async () => {
    const h = run("wall-a", "console", false);
    assert.equal(await h.result, false);
    assert.equal(h.sent(), 0);
  });

  it("does not name a screen already a control surface, or one on another view", () => {
    assert.deepEqual(screensChangedBy(state, "ctl-a", "console"), []);
    assert.deepEqual(screensChangedBy(state, "wall-a", "console"), [
      { id: "display-1", name: "Lobby TV" },
      { id: "display-2", name: "Hallway TV" },
    ]);
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
  it("asks nothing and sends the change, saying it asked about no screens", async () => {
    const h = run("wall-b", "console", false);
    assert.equal(await h.result, true);
    assert.deepEqual(h.asked, []);
    assert.deepEqual(h.sentScreens(), [[]]);
  });

  it("asks nothing when every screen already matches", async () => {
    const h = run("ctl-a", "console", false);
    await h.result;
    assert.deepEqual(h.asked, []);
  });

  it("throws what the server refused with, so the caller can tell the operator", async () => {
    const h = run("wall-b", "console", true, [new Error("disk full")]);
    await assert.rejects(h.result, /disk full/);
    assert.equal(h.sent(), 1, "an ordinary refusal is not asked about again");
  });
});

describe("the screens changed while the question was open", () => {
  const now = [
    { id: "display-1", name: "Lobby TV" },
    { id: "display-2", name: "Hallway TV" },
    { id: "display-5", name: "Spare" },
  ];

  it("asks again, naming the screens as the server has them, and sends those", async () => {
    const h = run("wall-a", "console", true, [screensChanged(now)]);
    assert.equal(await h.result, true);
    assert.equal(h.asked.length, 2);
    assert.equal(
      h.asked[1]!.message,
      "The screens showing it changed while you were deciding. Lobby TV, Hallway TV and Spare will become control surfaces. Anyone at them can press their buttons.",
    );
    assert.deepEqual(h.sentScreens(), [["display-1", "display-2"], ["display-1", "display-2", "display-5"]]);
  });

  it("sends nothing more when the second question is declined", async () => {
    const h = run("wall-a", "console", [true, false], [screensChanged(now)]);
    assert.equal(await h.result, false);
    assert.equal(h.sent(), 1);
  });

  it("asks once more and no further: a second refusal is thrown", async () => {
    const h = run("wall-a", "console", true, [screensChanged(now), screensChanged(now)]);
    await assert.rejects(h.result, /changed while you were deciding/);
    assert.equal(h.sent(), 2);
  });

  it("asked about nothing, it asks now that there is a screen", async () => {
    const h = run("wall-b", "console", true, [screensChanged([{ id: "display-5", name: "Spare" }])]);
    assert.equal(await h.result, true);
    assert.equal(h.asked.length, 1);
    assert.match(h.asked[0]!.message!, /Spare will become a control surface/);
    assert.deepEqual(h.sentScreens(), [[], ["display-5"]]);
  });
});
