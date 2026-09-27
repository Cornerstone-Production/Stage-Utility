// The baptism raw layer's event names, as a SORTED LIST, one entry per line.
//
// Not a count. A count cannot tell an add plus a remove from no change, and a
// single-line assertion is a guaranteed merge conflict between two branches
// each adding an event. The replay task (next) switches on these names
// verbatim; one added or renamed here without that switch learning about it
// is silent data loss the replay has no way to detect on its own.
//
// BAPTISM_RAW_EVENTS is a runtime array in baptism.ts (not a bare `type`
// union) precisely so this can assert against it directly rather than parsing
// that file's source text — CLAUDE.md's guard rule prefers a check the type
// system enforces over one that reads source.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BAPTISM_RAW_EVENTS } from "./baptism.js";

const EXPECTED = [
  "baptisms-armed",
  "baptisms-start",
  "finish",
  "pause",
  "person-complete",
  "reset",
  "resume",
  "start",
  "testimony-end",
  "undo",
];

describe("BaptismRawEvent", () => {
  it("is exactly this sorted list of 10 events", () => {
    assert.deepEqual([...BAPTISM_RAW_EVENTS].sort(), EXPECTED);
  });
});
