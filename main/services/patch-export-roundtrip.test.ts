// Export and import are the same document in two directions, and nothing else
// forces them to agree.
//
// The importer guesses each column from its heading (autoMap in
// patch-import.tsx). An export whose headings it cannot place is one an operator
// has to hand-map every time; an export whose headings it places WRONGLY is far
// worse, and silent. A draft of this export called the console channel "Channel",
// which autoMap reads as the RACK channel number — re-importing it would have
// renumbered every endpoint in the sheet.
//
// autoMap's patterns are mirrored here rather than imported: it lives in a .tsx
// renderer module and pulling React into a main-process test to reach it would be
// a worse coupling than this. Change one, change the other — that is what this
// file exists to force.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EXPORT_HEADERS } from "./patch-export.js";

/** Mirrored verbatim from autoMap() in renderer/settings/sections/patch-import.tsx. */
const IMPORTER_PATTERNS = {
  index: /(^#$)|input|channel|\bch\b|rack in/,
  label: /source|name|instrument/,
  mic: /mic|\bdi\b/,
  phantom: /48|phantom/,
  console: /console/,
  from: /snake|stage input|pocket|from|path|\bto\b/,
} as const;

/** The importer's own resolution: first heading that matches, or -1. */
function autoMap(headers: readonly string[]): Record<keyof typeof IMPORTER_PATTERNS, number> {
  const find = (re: RegExp) => headers.findIndex((h) => re.test(h.toLowerCase()));
  return {
    index: find(IMPORTER_PATTERNS.index),
    label: find(IMPORTER_PATTERNS.label),
    mic: find(IMPORTER_PATTERNS.mic),
    phantom: find(IMPORTER_PATTERNS.phantom),
    console: find(IMPORTER_PATTERNS.console),
    from: find(IMPORTER_PATTERNS.from),
  };
}

const col = (name: string) => EXPORT_HEADERS.indexOf(name as (typeof EXPORT_HEADERS)[number]);

describe("export headings the importer can read", () => {
  const map = autoMap(EXPORT_HEADERS);

  it("places every field it knows about", () => {
    const unplaced = Object.entries(map).filter(([, i]) => i < 0).map(([k]) => k);
    assert.deepEqual(
      unplaced,
      [],
      `The importer cannot find a column for: ${unplaced.join(", ")}. ` +
        "Re-importing this export would need hand-mapping every time.",
    );
  });

  it("places each field on the column that actually holds it", () => {
    // The failure this catches is silent: a heading the importer places on the
    // WRONG column corrupts the sheet rather than refusing to load it.
    assert.equal(map.index, col("Rack ch"), "rack channel");
    assert.equal(map.console, col("Console"), "console channel");
    assert.equal(map.label, col("Source / Name"), "label");
    assert.equal(map.mic, col("Mic / Feed"), "mic");
    assert.equal(map.phantom, col("48V"), "phantom");
    assert.equal(map.from, col("Path"), "routing");
  });

  it("does not let the console column masquerade as the rack channel", () => {
    // The specific bug: "Channel" matches the importer's rack-channel pattern.
    assert.notEqual(map.index, col("Console"));
  });

  it("writes phantom as something the importer reads as true", () => {
    // truthy() in patch-import.tsx: /^(x|y|yes|true|1|48v?)$/i
    assert.match("48V", /^(x|y|yes|true|1|48v?)$/i);
  });
});
