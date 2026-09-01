// The two things that decide whether a PCO-sourced checklist is trustworthy:
// what counts as a row, and whether a tick survives the note being edited.
//
// The tick-stability tests are the reason this module is keyed by wording
// rather than by line number. An index key passes a naive "the rows are right"
// test and then, the first Saturday somebody adds a line to the top of the
// note, silently moves every tick down one row — the operator sees jobs ticked
// that nobody did. That is the failure these guard.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { noteLines, planChecklistItems, selectNotes, type PlanNoteDTO } from "./plan-note-checklist.js";

function note(partial: Partial<PlanNoteDTO> & { content: string }): PlanNoteDTO {
  return {
    id: "n1",
    categoryName: "Production",
    teamNames: ["Production"],
    ...partial,
  };
}

/** The keys a tick would be stored against, for a given note body. */
const keysFor = (content: string) => planChecklistItems([note({ content })]).map((i) => i.key);

/**
 * ROW TEXT -> the key its tick is stored against.
 *
 * The comparison has to go through the text. Asserting only that a key still
 * EXISTS after an edit is satisfied by an index key — "Production 0" is still
 * in the list once a line is added above it, it just belongs to a different job
 * now. That is the whole bug, and the first version of these tests passed on it.
 */
const keyByText = (content: string) =>
  new Map(planChecklistItems([note({ content })]).map((i) => [i.text, i.key]));

describe("what counts as a row", () => {
  it("takes every non-blank line when nothing is bulleted", () => {
    assert.deepEqual(noteLines("Batteries fresh\nCO2 hooked up"), ["Batteries fresh", "CO2 hooked up"]);
  });

  it("takes ONLY the bulleted lines when any line is bulleted", () => {
    // The preamble is context. Turning it into a row nobody can complete is how
    // a checklist stops being read at all.
    assert.deepEqual(
      noteLines("Doors at 8, band on stage 8:30.\n- Batteries fresh\n- CO2 hooked up"),
      ["Batteries fresh", "CO2 hooked up"],
    );
  });

  it("strips the marker rather than keeping it in the text", () => {
    assert.deepEqual(noteLines("- Batteries\n* CO2\n[ ] Signage\n[x] Playlist"), [
      "Batteries",
      "CO2",
      "Signage",
      "Playlist",
    ]);
  });

  it("drops blank lines and a rule used as a separator", () => {
    assert.deepEqual(noteLines("Batteries\n\n---\n\nCO2"), ["Batteries", "CO2"]);
  });

  it("is empty for an empty note rather than producing one blank row", () => {
    assert.deepEqual(noteLines("   \n\n"), []);
  });
});

describe("a tick survives the note being edited", () => {
  it("does not move when a line is INSERTED ABOVE it", () => {
    // The whole reason keys are wording and not position.
    const before = keyByText("- Batteries fresh\n- CO2 hooked up");
    const after = keyByText("- Doors unlocked\n- Batteries fresh\n- CO2 hooked up");
    for (const text of ["Batteries fresh", "CO2 hooked up"]) {
      assert.equal(
        after.get(text),
        before.get(text),
        `"${text}" changed identity when a line was added above it — its tick moved to another row`,
      );
    }
  });

  it("does not move when the rows are REORDERED", () => {
    const before = keyByText("- Batteries fresh\n- CO2 hooked up");
    const after = keyByText("- CO2 hooked up\n- Batteries fresh");
    for (const text of ["Batteries fresh", "CO2 hooked up"]) {
      assert.equal(after.get(text), before.get(text), `"${text}" changed identity when the rows were reordered`);
    }
  });

  it("survives a typo fix that does not change the words", () => {
    // Capitalisation and a double space are not a different job.
    assert.deepEqual(keysFor("- Batteries  fresh"), keysFor("- batteries fresh"));
  });

  it("CLEARS when the row is reworded, because that is a different job", () => {
    const [before] = keysFor("- Batteries fresh");
    const [after] = keysFor("- Batteries replaced");
    assert.notEqual(before, after);
  });

  it("gives two identical rows two identities", () => {
    // Sharing a key would tick both at once, which reads as a bug.
    const keys = keysFor("- Check batteries\n- Check batteries");
    assert.equal(new Set(keys).size, 2, `duplicate rows shared a key: ${JSON.stringify(keys)}`);
  });

  it("keeps rows apart across categories that word a job the same way", () => {
    const items = planChecklistItems([
      note({ id: "a", categoryName: "Production", content: "- Check batteries" }),
      note({ id: "b", categoryName: "Worship", content: "- Check batteries" }),
    ]);
    assert.equal(new Set(items.map((i) => i.key)).size, 2);
  });
});

describe("which notes are on the list", () => {
  const notes = [
    note({ id: "a", categoryName: "Production", teamNames: ["Production"], content: "- Batteries" }),
    note({ id: "b", categoryName: "Worship", teamNames: ["Band"], content: "- Tune up" }),
    note({ id: "c", categoryName: "General", teamNames: [], content: "- Parking lot" }),
  ];

  it("chooses NOTHING when nothing has been chosen", () => {
    // Not everything. A checklist that fills itself with every note on the plan
    // the moment PCO connects cannot be told apart from one somebody asked for.
    assert.deepEqual(selectNotes(notes, [], []), []);
  });

  it("matches a category by name, ignoring case", () => {
    assert.deepEqual(selectNotes(notes, ["production"], []).map((n) => n.id), ["a"]);
  });

  it("matches a team by name", () => {
    assert.deepEqual(selectNotes(notes, [], ["Band"]).map((n) => n.id), ["b"]);
  });

  it("takes a note that matches EITHER, not only both", () => {
    assert.deepEqual(selectNotes(notes, ["Production"], ["Band"]).map((n) => n.id), ["a", "b"]);
  });

  it("never matches a note assigned to no team on an empty team name", () => {
    assert.deepEqual(selectNotes(notes, [], [""]).map((n) => n.id), []);
  });
});
