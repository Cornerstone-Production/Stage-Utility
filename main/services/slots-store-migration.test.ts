// The v3 link migration. Runs once per install against config written by an older
// version — get it wrong and a configured mic board silently stops matching anyone.

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { migrateSlotLink } from "./slots-store.js";

describe("v2 -> v3 slot link migration", () => {
  test("a position + note becomes a single-entry range", () => {
    assert.deepEqual(
      migrateSlotLink({ kind: "pco", matchBy: "position", teamPositionName: "Vocals", notesStartsWith: "4" }),
      { kind: "pco", matchBy: "position", positions: [{ name: "Vocals", notesStartsWith: "4" }] },
    );
  });

  test("a position with no note keeps the entry, drops the key", () => {
    assert.deepEqual(
      migrateSlotLink({ kind: "pco", matchBy: "position", teamPositionName: "Acoustic" }),
      { kind: "pco", matchBy: "position", positions: [{ name: "Acoustic" }] },
    );
  });

  test("the empty-string default becomes an unconfigured slot", () => {
    // settings-view.tsx and the slot editors create links with teamPositionName: "".
    assert.deepEqual(
      migrateSlotLink({ kind: "pco", matchBy: "position", teamPositionName: "" }),
      { kind: "pco", matchBy: "position", positions: [] },
    );
  });

  test("an already-migrated link is returned untouched", () => {
    const v3 = { kind: "pco", matchBy: "position", positions: [{ name: "Keys" }] };
    assert.deepEqual(migrateSlotLink(v3), v3);
  });

  test("migration is idempotent", () => {
    const once = migrateSlotLink({ kind: "pco", matchBy: "position", teamPositionName: "Drums", notesStartsWith: "1" });
    assert.deepEqual(migrateSlotLink(once), once);
  });

  test("non-position links pass through unchanged", () => {
    for (const link of [
      { kind: "pco", matchBy: "person", personId: "123" },
      { kind: "static", label: "Pastor", color: "#336699" },
      { kind: "empty" },
      { kind: "spacer", showEmptyImage: true },
    ]) {
      assert.deepEqual(migrateSlotLink(link), link);
    }
  });

  test("garbage becomes an unconfigured position link rather than throwing", () => {
    // DataStore does not deep-merge on load, so a hand-edited file can hold anything.
    assert.deepEqual(migrateSlotLink(null), { kind: "pco", matchBy: "position", positions: [] });
    assert.deepEqual(migrateSlotLink({ kind: "pco", matchBy: "banana" }), { kind: "pco", matchBy: "position", positions: [] });
  });
});
