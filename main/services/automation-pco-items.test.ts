import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { findItemByTitle } from "./automation-pco-items.js";

const items = [
  { id: "1", title: "Pre-Service" },
  { id: "2", title: "Doors Open" },
  { id: "3", title: "Welcome" },
];

describe("findItemByTitle", () => {
  it("matches a case-insensitive substring", () => {
    assert.equal(findItemByTitle(items, "doors")?.id, "2");
    assert.equal(findItemByTitle(items, "DOORS")?.id, "2");
  });

  it("returns the FIRST match when several could match", () => {
    const dupes = [
      { id: "a", title: "Doors" },
      { id: "b", title: "Doors Close" },
    ];
    assert.equal(findItemByTitle(dupes, "doors")?.id, "a");
  });

  it("returns null when nothing matches, so the caller can log why", () => {
    assert.equal(findItemByTitle(items, "offering"), null);
  });

  it("returns null for an empty or whitespace title rather than matching everything", () => {
    // A rule saved with the title cleared must fire nothing, not the first item.
    assert.equal(findItemByTitle(items, ""), null);
    assert.equal(findItemByTitle(items, "   "), null);
  });

  it("ignores surrounding whitespace in the needle", () => {
    assert.equal(findItemByTitle(items, "  doors  ")?.id, "2");
  });
});
