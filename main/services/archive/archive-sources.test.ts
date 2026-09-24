// The raw sources this archive writes, as a SORTED LIST, one entry per line.
//
// Not a count. A count cannot tell an add plus a remove from no change, and a
// single-line assertion is a guaranteed merge conflict between two branches each
// adding a source. Every source must be here: mergeInto walks this list, so one
// left out is a source a history merge silently leaves behind.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ARCHIVE_SOURCES } from "./sample-archive.js";

const EXPECTED = [
  "attendance",
  "baptism",
  "events",
  "spl",
];

describe("archive sources", () => {
  it("are exactly this sorted list", () => {
    assert.deepEqual([...ARCHIVE_SOURCES].sort(), EXPECTED);
  });
});
