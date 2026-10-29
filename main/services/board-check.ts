// board-check.ts — "This plan's check" under the boards on the Mic slots page.
//
// Pure: the controller reads every board at one target and the plan's roster,
// and this says what is wrong with the two together. Who landed where comes
// from slot-resolver's matchMembers, the same rule the screens use, so the check
// cannot report somebody missing who is on a screen, or the other way round.
//
// Not here yet: filled slots with a mic but no Capsule tag. That needs the
// Planning Center prep tags, and arrives with them.

import { claimKey, matchMembers, positionMatches } from "./slot-resolver.js";
import type { BoardCheckNoPosition, BoardCheckUnplaced, PersonCardDTO, Slot, TeamMemberDTO } from "../types/stage.js";

export interface CheckedBoard {
  id: string;
  name: string;
  /** The board's raw slots at the target being checked. */
  slots: Slot[];
}

/** A position-matched slot's entries that can match anyone: a name or a notes
 *  prefix. An entry with neither is skipped by the matcher. */
function usableEntries(slot: Slot): { name: string | null }[] {
  if (slot.link.kind !== "pco" || slot.link.matchBy !== "position") return [];
  return slot.link.positions
    .filter((p) => (p.name && p.name.trim()) || (p.notesStartsWith && p.notesStartsWith.trim()))
    .map((p) => ({ name: p.name && p.name.trim() ? p.name : null }));
}

export function checkBoards(
  boards: readonly CheckedBoard[],
  members: readonly TeamMemberDTO[],
  people: ReadonlyMap<string, PersonCardDTO> = new Map(),
): { unplaced: BoardCheckUnplaced[]; noPosition: BoardCheckNoPosition[] } {
  const roster = [...members];
  const placed = new Set<string>();
  const noPosition: BoardCheckNoPosition[] = [];
  for (const board of boards) {
    const matched = matchMembers(board.slots, roster, people);
    for (const m of matched) if (m) placed.add(claimKey(m));
    board.slots.forEach((slot, i) => {
      if (slot.link.kind === "pco" && slot.link.matchBy === "position" && usableEntries(slot).length === 0) {
        noPosition.push({ boardId: board.id, boardName: board.name, slotId: slot.id, channel: slot.channel ?? "", index: i + 1 });
      }
    });
  }

  // One row per person, not per membership: somebody scheduled twice is placed
  // when either membership is, which is what the matcher's claim key says.
  const unplaced = new Map<string, BoardCheckUnplaced>();
  for (const m of roster) {
    const key = claimKey(m);
    if (placed.has(key)) continue;
    const boardsNaming: { id: string; name: string }[] = [];
    for (const board of boards) {
      const names = board.slots.some((slot) =>
        usableEntries(slot).some((e) => e.name !== null && positionMatches(e.name, m.teamPositionName)),
      );
      if (names) boardsNaming.push({ id: board.id, name: board.name });
    }
    if (boardsNaming.length === 0) continue;
    const row = unplaced.get(key);
    if (row) {
      for (const b of boardsNaming) if (!row.boards.some((x) => x.id === b.id)) row.boards.push(b);
      continue;
    }
    unplaced.set(key, { personId: m.personId, name: m.name, position: m.teamPositionName, boards: boardsNaming });
  }
  return { unplaced: [...unplaced.values()], noPosition };
}
