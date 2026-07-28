// resolveSlots is pure, so everything here is data in / data out — no devices.
//
// The load-bearing rule is claiming: slots with an IDENTICAL positions set compete
// for distinct people; slots that differ resolve independently. Get that backwards
// and either a guitarist appears in three slots at once, or the acoustic player
// vanishes from the slot holding their pack.

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { resolveSlots } from "./slot-resolver.js";
import type { Slot, SlotLink, TeamMemberDTO } from "../types/stage.js";
import type { DeviceStatus } from "../types/devices.js";

const NO_DEVICES = new Map<string, DeviceStatus>();

function member(personId: string, name: string, teamPositionName: string, notes: string | null = null): TeamMemberDTO {
  return { personId, name, teamPositionName, notes, photoUrl: null } as unknown as TeamMemberDTO;
}

function slot(id: string, link: SlotLink, order = 0): Slot {
  return {
    id, order, link,
    displayName: null, photoUrl: null,
    deviceBinding: null, iemBinding: null,
    deviceLabel: null, iemLabel: null,
    chargeSource: "mic", chargeBayId: null, hideRf: false,
  } as unknown as Slot;
}

const pos = (...positions: Array<{ name?: string; notesStartsWith?: string }>): SlotLink =>
  ({ kind: "pco", matchBy: "position", positions });

const names = (out: Slot[]) => out.map((s) => s.displayName);

describe("matching one slot", () => {
  const team = [
    member("p1", "Sarah", "Vocals", "1"),
    member("p2", "Dana", "Vocals", "10"),
    member("p3", "Ali", "Acoustic"),
  ];

  test("a single position with a note behaves exactly as before", () => {
    assert.deepEqual(names(resolveSlots([slot("s", pos({ name: "Vocals", notesStartsWith: "1" }))], team, NO_DEVICES)), ["Sarah"]);
  });

  test('an exact note wins so "1" does not grab "10"', () => {
    assert.deepEqual(names(resolveSlots([slot("s", pos({ name: "Vocals", notesStartsWith: "1" }))], team, NO_DEVICES)), ["Sarah"]);
    assert.deepEqual(names(resolveSlots([slot("s", pos({ name: "Vocals", notesStartsWith: "10" }))], team, NO_DEVICES)), ["Dana"]);
  });

  test("a position with no note takes the first person in it", () => {
    assert.deepEqual(names(resolveSlots([slot("s", pos({ name: "Acoustic" }))], team, NO_DEVICES)), ["Ali"]);
  });

  test("a noted position never falls back to an arbitrary person", () => {
    // The HH-slot-shows-the-HS-pastor bug. A note that matches nobody = empty.
    assert.deepEqual(names(resolveSlots([slot("s", pos({ name: "Vocals", notesStartsWith: "9" }))], team, NO_DEVICES)), [null]);
  });

  test("sub-variant positions group under their base", () => {
    const bgv = [member("p9", "Chris", "Vocals (BGVs)", "3")];
    assert.deepEqual(names(resolveSlots([slot("s", pos({ name: "Vocals", notesStartsWith: "3" }))], bgv, NO_DEVICES)), ["Chris"]);
  });

  test("entries are tried in order — first hit wins", () => {
    const link = pos({ name: "Vocals", notesStartsWith: "4" }, { name: "Acoustic" });
    // No vocalist noted 4, so it falls through to Acoustic.
    assert.deepEqual(names(resolveSlots([slot("s", link)], team, NO_DEVICES)), ["Ali"]);
  });

  test("a nameless entry matches on the note across every position", () => {
    assert.deepEqual(names(resolveSlots([slot("s", pos({ notesStartsWith: "10" }))], team, NO_DEVICES)), ["Dana"]);
  });

  test("an entry with neither name nor note matches nobody", () => {
    // Guard against a misconfigured slot silently claiming the first person on the team.
    assert.deepEqual(names(resolveSlots([slot("s", pos({}))], team, NO_DEVICES)), [null]);
  });

  test("an empty range is an unconfigured slot", () => {
    assert.deepEqual(names(resolveSlots([slot("s", pos())], team, NO_DEVICES)), [null]);
  });
});

describe("claiming between slots", () => {
  test("identical sets compete — two guitarists fill two of three slots", () => {
    const team = [member("g1", "Ali", "Acoustic"), member("g2", "Bo", "Electric")];
    const link = pos({ name: "Acoustic" }, { name: "Electric" });
    const out = resolveSlots([slot("a", link, 0), slot("b", link, 1), slot("c", link, 2)], team, NO_DEVICES);
    assert.deepEqual(names(out), ["Ali", "Bo", null]);
  });

  test("different sets do NOT compete — the pack slot still shows the player", () => {
    // The operator's case: slot 4 accepts Vocals-4 or Acoustic; a separate slot
    // holds that player's acoustic pack. Both must show them.
    const team = [member("g1", "Ali", "Acoustic")];
    const slot4 = pos({ name: "Vocals", notesStartsWith: "4" }, { name: "Acoustic" });
    const packSlot = pos({ name: "Acoustic" });
    const out = resolveSlots([slot("s4", slot4, 0), slot("pack", packSlot, 1)], team, NO_DEVICES);
    assert.deepEqual(names(out), ["Ali", "Ali"]);
  });

  test("competing slots claim in board order", () => {
    const team = [member("g1", "Ali", "Acoustic"), member("g2", "Bo", "Acoustic")];
    const link = pos({ name: "Acoustic" });
    const out = resolveSlots([slot("a", link, 0), slot("b", link, 1)], team, NO_DEVICES);
    assert.deepEqual(names(out), ["Ali", "Bo"]);
  });

  test("entry order does not change whether two slots compete", () => {
    // Identical means the same SET, so [Acoustic, Electric] == [Electric, Acoustic].
    const team = [member("g1", "Ali", "Acoustic")];
    const a = pos({ name: "Acoustic" }, { name: "Electric" });
    const b = pos({ name: "Electric" }, { name: "Acoustic" });
    assert.deepEqual(names(resolveSlots([slot("a", a, 0), slot("b", b, 1)], team, NO_DEVICES)), ["Ali", null]);
  });

  test("notes are part of the identity — same position, different notes never compete", () => {
    const team = [member("p1", "Sarah", "Vocals", "1"), member("p2", "Dana", "Vocals", "2")];
    const out = resolveSlots(
      [slot("a", pos({ name: "Vocals", notesStartsWith: "1" }), 0), slot("b", pos({ name: "Vocals", notesStartsWith: "2" }), 1)],
      team, NO_DEVICES,
    );
    assert.deepEqual(names(out), ["Sarah", "Dana"]);
  });

  test("a person-linked slot is unaffected by claiming", () => {
    const team = [member("p1", "Sarah", "Vocals", "1")];
    const out = resolveSlots(
      [slot("a", { kind: "pco", matchBy: "person", personId: "p1" }, 0), slot("b", pos({ name: "Vocals" }), 1)],
      team, NO_DEVICES,
    );
    assert.deepEqual(names(out), ["Sarah", "Sarah"]);
  });

  test("spacer and empty slots resolve to nothing and claim nobody", () => {
    const team = [member("p1", "Sarah", "Vocals")];
    const out = resolveSlots(
      [slot("sp", { kind: "spacer" }, 0), slot("e", { kind: "empty" }, 1), slot("v", pos({ name: "Vocals" }), 2)],
      team, NO_DEVICES,
    );
    assert.deepEqual(names(out), [null, null, "Sarah"]);
  });
});
