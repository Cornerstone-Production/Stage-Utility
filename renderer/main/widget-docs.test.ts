// Every widget the app can draw is described in docs/reference/widgets.md.
//
// The doc is the only place an operator can find out what a widget shows and
// where the number comes from, and a widget added to the registry without a line
// there is invisible to everyone who did not write it. That is not hypothetical:
// the registry grew past fifty entries while the docs described a handful.
//
// Matched on the LABEL — the words in the palette — rather than the type id,
// because the label is what a reader is looking at when they reach for the doc.
// The count is EXACT in both directions, so a widget that is renamed, removed or
// added fails here rather than drifting.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { LAYOUT_OBJECTS } from "./layout-objects.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DOC = path.join(ROOT, "docs", "reference", "widgets.md");

const doc = readFileSync(DOC, "utf8");

/** The bolded name in each table row: `| **Clock** | … |`. Only those — prose
 *  emphasis elsewhere in the file must not count as documenting a widget. */
function documentedNames(): Set<string> {
  return new Set([...doc.matchAll(/^\|\s*\*\*([^*]+)\*\*/gm)].map((m) => m[1].trim()));
}

describe("the widget reference covers the registry", () => {
  // Compared verbatim, both ways. A row may qualify its name after the bold —
  // "**Recording** *(Home)*" — and that qualifier is outside the capture, so
  // nothing needs normalising. An earlier version stripped parentheses to cope
  // with it and thereby turned "Service order (legacy)" into "Service order",
  // reporting the one widget it was documenting correctly as missing.
  const documented = documentedNames();
  const registry = Object.values(LAYOUT_OBJECTS).map((e) => (e as { label: string }).label);

  test("the scan finds rows at all", () => {
    // Guards the regex. A silently-empty scan would make this file vacuous —
    // which is exactly how an earlier coverage check in this repo went green
    // while missing what it was written to catch.
    assert.ok(documented.size >= 40, `only found ${documented.size} documented widgets; the table format changed`);
  });

  test("every widget in the palette is described", () => {
    const missing = registry.filter((label) => !documented.has(label)).sort();
    assert.deepEqual(
      missing,
      [],
      `in the palette but not in docs/reference/widgets.md: ${missing.join(", ")}`,
    );
  });

  test("and nothing is described that the palette does not offer", () => {
    // The other direction, which is the one that rots quietly: a widget removed
    // from the app leaves a paragraph telling operators to use something that is
    // no longer there.
    const known = new Set(registry);
    const stale = [...documented].filter((name) => !known.has(name)).sort();
    assert.deepEqual(stale, [], `documented but not in the palette: ${stale.join(", ")}`);
  });
});
