// A slots widget draws in a box only the browser can measure — whichever board
// it shows.
//
// PCO's crop is centred and irreversible, so it may only be aimed at a shape
// something actually knows. A standalone slots SCREEN is a row of tall columns
// and the crop is modelled on exactly that. A slots WIDGET on a custom layout is
// a free-dragged rectangle, and that stays true when it shows the same board as
// a screen does: the two must resolve differently from one set of rows.
//
// Driven through the controller's real resolution rather than by reading its
// source: an earlier version of this file matched a regex over
// stage-controller.ts, which a comment naming the right call could satisfy.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-grid-crop-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { stageController } = await import("./stage-controller.js");

type Held = {
  state: StageState;
  rawSlotsByBoard: Map<string, Slot[]>;
  teamMembers: TeamMemberDTO[];
  recomputeResolved: () => void;
};
const ctl = stageController as unknown as Held;

const PHOTO = "https://avatars.example.com/people/1/face.jpg";
const vocalsSlot = { id: "s1", channel: "1", order: 0, link: { kind: "pco", matchBy: "position", positions: [{ name: "Vocals" }] } } as unknown as Slot;
const grid = (id: string, boardId: string) => ({ id, x: 0, y: 0, w: 0.5, h: 0.3, z: 1, config: { type: "slots-grid", boardId } });

function resolveWith(views: View[]): StageState {
  ctl.teamMembers = [{ id: "tm1", personId: "p1", name: "Ana", photoUrl: PHOTO, teamPositionName: "Vocals", teamName: "Band", status: "C", notes: null }];
  ctl.rawSlotsByBoard.set("b-shared", [vocalsSlot]);
  ctl.state = { ...ctl.state, views };
  ctl.recomputeResolved();
  return ctl.state;
}

describe("which slots get the whole image", () => {
  const views = [
    { id: "wall", name: "Wall", kind: "slots", ndiSource: null, createdAt: "", boardId: "b-shared" },
    {
      id: "pad", name: "Pad", kind: "custom", ndiSource: null, createdAt: "", surface: "console",
      layout: { version: 1, canvas: { width: 1920, height: 1080, background: null }, objects: [
        grid("top", "b-shared"),
        { id: "wrap", x: 0, y: 0, w: 1, h: 1, z: 2, config: { type: "container" }, children: [grid("nested", "b-shared")] },
      ] },
    },
  ] as unknown as View[];

  test("a widget asks for the whole image, keyed by its object", () => {
    const state = resolveWith(views);
    const url = state.slotsByLayoutObject.top?.[0]?.photoUrl ?? "";
    assert.match(url, /g=1000x1000(?!%23)/, "a widget is cropped to a guessed column shape");
  });

  test("nesting does not hide one", () => {
    const state = resolveWith(views);
    assert.match(state.slotsByLayoutObject.nested?.[0]?.photoUrl ?? "", /g=1000x1000(?!%23)/);
  });

  test("a screen showing the same board keeps its column crop", () => {
    const state = resolveWith(views);
    assert.match(state.slotsByView.wall?.[0]?.photoUrl ?? "", /%23/, "a display lost its byte-saving column crop");
  });
});
