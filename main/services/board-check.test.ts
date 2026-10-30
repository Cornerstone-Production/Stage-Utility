// "This plan's check": who is on the plan, named by a board, and on no slot; and
// which slots accept no position at all. Pure, over invented boards and people.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { checkBoards } from "./board-check.js";
import type { Slot, TeamMemberDTO } from "../types/stage.js";

const pos = (id: string, names: (string | { name?: string; notesStartsWith?: string })[]): Slot =>
  ({
    id,
    channel: id.toUpperCase(),
    order: 0,
    link: { kind: "pco", matchBy: "position", positions: names.map((n) => (typeof n === "string" ? { name: n } : n)) },
  }) as unknown as Slot;
const person = (id: string, name: string, position: string, personId = id): TeamMemberDTO =>
  ({ id: `tm-${id}`, personId, name, photoUrl: null, teamPositionName: position, teamName: "Band", status: "C", notes: null });

describe("people on the plan and on no slot", () => {
  test("names whoever a board's position takes but who did not land, with every board naming it", () => {
    const boards = [
      { id: "b-left", name: "Left", slots: [pos("v1", ["Vocals"])] },
      { id: "b-right", name: "Right", slots: [pos("v2", ["Vocals"]), pos("k", ["Keys"])] },
    ];
    // Three vocalists, two vocal slots across two boards (each board claims
    // independently, so both take Ana); Ben and Cy are left over, and Dee plays
    // keys, which a slot takes.
    const roster = [person("a", "Ana", "Vocals"), person("b", "Ben", "Vocals"), person("c", "Cy", "Vocals"), person("d", "Dee", "Keys")];
    const { unplaced } = checkBoards(boards, roster);
    assert.deepEqual(unplaced, [
      { personId: "b", name: "Ben", position: "Vocals", boards: [{ id: "b-left", name: "Left" }, { id: "b-right", name: "Right" }] },
      { personId: "c", name: "Cy", position: "Vocals", boards: [{ id: "b-left", name: "Left" }, { id: "b-right", name: "Right" }] },
    ]);
  });

  test("leaves out people whose position no board names", () => {
    const { unplaced } = checkBoards([{ id: "b", name: "B", slots: [pos("v", ["Vocals"])] }], [person("x", "Xan", "Lighting")]);
    assert.deepEqual(unplaced, []);
  });

  test("counts a person scheduled twice once, placed when either membership is", () => {
    const roster = [person("a", "Ana", "Vocals"), { ...person("a2", "Ana", "AG", "a") }];
    const { unplaced } = checkBoards([{ id: "b", name: "B", slots: [pos("v", ["Vocals"]), pos("x", ["AG"])] }], roster.slice(0, 1).concat(roster[1]!));
    assert.deepEqual(unplaced, []);
  });
});

describe("slots that accept no position", () => {
  test("lists a position slot with no usable entry, by board and place", () => {
    const boards = [{ id: "b", name: "Left", slots: [pos("ok", ["Vocals"]), pos("none", []), pos("blank", [{ name: "  " }]), pos("note", [{ notesStartsWith: "HS" }])] }];
    assert.deepEqual(checkBoards(boards, []).noPosition, [
      { boardId: "b", boardName: "Left", slotId: "none", channel: "NONE", index: 2 },
      { boardId: "b", boardName: "Left", slotId: "blank", channel: "BLANK", index: 3 },
    ]);
  });

  test("never lists a spacer, a label, an empty slot or a by-person slot", () => {
    const other = (kind: string): Slot => ({ id: kind, channel: "", order: 0, link: { kind } }) as unknown as Slot;
    const byPerson = { id: "p", channel: "", order: 0, link: { kind: "pco", matchBy: "person", personId: "1" } } as unknown as Slot;
    assert.deepEqual(checkBoards([{ id: "b", name: "B", slots: [other("spacer"), other("static"), other("empty"), byPerson] }], []).noPosition, []);
  });
});
