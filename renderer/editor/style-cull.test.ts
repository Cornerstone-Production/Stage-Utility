import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { readFileSync } from "node:fs";

// Phase 6 removes on purpose, so this asserts the INTENDED set rather than that
// everything survived. The parity guard from Phase 5 would fail by design here,
// and replacing it with its inverse is the honest move: state what is offered
// and fail if that drifts, in either direction.
//
// The evidence behind the cull, measured against a real config of 24 objects
// across 12 views: three style fields were never used at all, six had a single
// distinct value, three only ever moved together as a preset. `color` was the
// one with genuine variation.

const INSPECTOR = readFileSync(new URL("./inspector.tsx", import.meta.url), "utf8");
const RENDERER = readFileSync(new URL("../main/layout-renderer.tsx", import.meta.url), "utf8");

/** Every style field the inspector still writes, from its onStyle calls. */
function offeredStyleFields(): string[] {
  const found = new Set<string>();
  for (const m of INSPECTOR.matchAll(/onStyle\(\{\s*([a-zA-Z]+)\s*[:}]/g)) found.add(m[1]);
  return [...found].sort();
}

describe("the inspector offers exactly what we decided to keep", () => {
  test("one style field: colour", () => {
    assert.deepEqual(offeredStyleFields(), ["color"]);
  });

  const GONE = [
    "fontSize", "fontWeight", "italic", "uppercase", "letterSpacing",
    "textAlign", "vAlign", "background", "opacity", "cornerRadius",
    "padding", "borderColor", "borderWidth", "textShadow", "boxShadow", "lineClamp",
  ];
  for (const field of GONE) {
    test(`${field} is no longer offered`, () => {
      assert.ok(
        !new RegExp(`onStyle\\(\\{\\s*${field}\\b`).test(INSPECTOR),
        `${field} came back - if that is deliberate, update this list and say why`,
      );
    });
  }
});

describe("removed fields are ignored, never stripped", () => {
  // Never delete an operator's data to tidy up. A rollback must restore the old
  // look, which is only possible if the values are still in the file.
  test("nothing deletes style keys on save", () => {
    const suspicious = /delete\s+\w*\.?style\.|omit\(.*style|strip.*[Ss]tyle/;
    assert.ok(!suspicious.test(INSPECTOR), "the inspector must not strip style keys");
  });

  test("resetting a look replaces style, it does not purge the object", () => {
    // resetLook assigns defaultStyle; it must not reach for config or geometry.
    const EDITOR = readFileSync(new URL("./layout-editor.tsx", import.meta.url), "utf8");
    assert.match(EDITOR, /style:\s*defaultStyle\(o\.config\.type\)/);
  });
});

describe("the frame decides the look, not the object", () => {
  test("boxStyle reads the object's style exactly once, for the shape exception", () => {
    // Counting READS rather than looking for field names by spelling. The first
    // version of this test matched `s.opacity`, so reintroducing the bug as
    // `(o.style ?? {}).opacity` sailed straight past it - the guard passed on
    // the very defect it was written for. Any new read of o.style inside the
    // frame is a culled field creeping back, whatever it is called.
    const body = RENDERER.slice(
      RENDERER.indexOf("export function boxStyle("),
      RENDERER.indexOf("/** Text-level CSS"),
    );
    const reads = body.match(/o\.style/g) ?? [];
    assert.equal(
      reads.length,
      1,
      `boxStyle should read o.style once (the shape's fill); found ${reads.length}`,
    );
  });

  test("the body is opaque and follows the canvas colour", () => {
    // Transparent lets an overlapping widget's text bleed through; hardcoded
    // black punches holes in a non-default canvas.
    assert.match(RENDERER, /background:\s*canvasBg \|\| "var\(--kiosk-bg/);
  });

  test("a shape keeps its fill, because a shape IS its fill", () => {
    assert.match(RENDERER, /config\.type === "shape"[\s\S]{0,200}s\.background/);
  });
});
