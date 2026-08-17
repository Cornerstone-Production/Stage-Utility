import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { migrateNeverChosenDefaults, countNeverChosen } from "./never-chosen-defaults.js";
import { IDIOM_TYPES, LEGACY_TRANSLUCENT_GROUNDS } from "../types/readout-types.js";
import type { View } from "../types/views.js";

// The widget idiom aligns left by default, and the alignment control still
// works. Both of those are only true because the centre alignment the object
// registry wrote into every object it created comes off first — it was never a
// choice, and treating it as one would flip every readout back to centred.
//
// This edits the operator's layouts, so the tests are as much about what it
// must NOT touch as what it must.

const obj = (type: string, style: Record<string, unknown> | undefined, children?: unknown[]) =>
  ({ id: `${type}-1`, x: 0, y: 0, w: 0.2, h: 0.2, z: 0, config: { type }, style, children }) as never;

const view = (objects: unknown[]): View =>
  ({ id: "v", name: "v", kind: "custom", layout: { version: 1, canvas: {}, objects } }) as never;

const alignOf = (views: View[], i = 0, j = 0) =>
  (views[i].layout!.objects[j] as { style?: { textAlign?: string } }).style?.textAlign;

describe("what it clears", () => {
  test("a readout's never-chosen centre comes off", () => {
    const out = migrateNeverChosenDefaults([view([obj("clock", { textAlign: "center", fontSize: 0.09 })])]);
    assert.equal(alignOf(out), undefined, "the centre alignment survived");
  });

  test("the rest of the style is untouched", () => {
    // Only the one field. A migration that rebuilt the style would silently
    // discard a colour or a font size the operator did choose.
    const out = migrateNeverChosenDefaults([
      view([obj("clock", { textAlign: "center", fontSize: 0.09, color: "#ff0000", vAlign: "top" })]),
    ]);
    const style = out[0].layout!.objects[0].style as unknown as Record<string, unknown>;
    assert.deepEqual(style, { fontSize: 0.09, color: "#ff0000", vAlign: "top" });
  });

  test("it reaches readouts nested inside containers", () => {
    // Layouts nest — a container of status pills is the normal shape. A pass
    // that only walked the top level would leave every grouped readout centred
    // and the operator with no way to tell why some moved and some did not.
    const out = migrateNeverChosenDefaults([
      view([obj("container", undefined, [obj("obs-status", { textAlign: "center" })])]),
    ]);
    const kid = (out[0].layout!.objects[0] as { children: { style?: { textAlign?: string } }[] }).children[0];
    assert.equal(kid.style?.textAlign, undefined, "a nested readout kept its centre");
  });

  test("every readout type is covered", () => {
    // An EXACT walk of the set, not a sample. A type missing from the migration
    // is a widget that stays centred forever while its neighbours move.
    for (const type of IDIOM_TYPES) {
      const out = migrateNeverChosenDefaults([view([obj(type, { textAlign: "center" })])]);
      assert.equal(alignOf(out), undefined, `${type} kept its never-chosen centre`);
    }
  });
});

const bgOf = (views: View[], i = 0, j = 0) =>
  (views[i].layout!.objects[j] as { style?: { background?: string } }).style?.background;

describe("the translucent card ground", () => {
  test("every preset ground becomes its opaque twin", () => {
    // An EXACT walk of the map. A preset left out is one card that goes on
    // letting the page read through it while its neighbours stop.
    for (const [translucent, opaque] of Object.entries(LEGACY_TRANSLUCENT_GROUNDS)) {
      const out = migrateNeverChosenDefaults([view([obj("text", { background: translucent })])]);
      assert.equal(bgOf(out), opaque, `${translucent} was not replaced`);
    }
  });

  test("it applies to any object type, not just readouts", () => {
    // The ground is on every card the registry ever made — a notes object and a
    // people panel bleed exactly as badly as a status pill.
    const out = migrateNeverChosenDefaults([view([obj("notes", { background: "rgba(255,255,255,0.04)" })])]);
    assert.equal(bgOf(out), "#141414");
  });

  test("whitespace in the stored value still matches", () => {
    // JSON written by a different code path may carry spaces after the commas.
    // Matching the literal string alone would silently skip those objects.
    const out = migrateNeverChosenDefaults([view([obj("text", { background: "rgba(255, 255, 255, 0.04)" })])]);
    assert.equal(bgOf(out), "#141414", "a spaced rgba was not recognised");
  });

  test("a background the operator chose is left alone", () => {
    for (const chosen of ["#ff0000", "rgba(0,0,0,0.5)", "rgba(255,255,255,0.20)"]) {
      const out = migrateNeverChosenDefaults([view([obj("text", { background: chosen })])]);
      assert.equal(bgOf(out), chosen, `${chosen} was overwritten`);
    }
  });

  test("both defaults come off the same object in one pass", () => {
    const out = migrateNeverChosenDefaults([
      view([obj("clock", { textAlign: "center", background: "rgba(255,255,255,0.04)" })]),
    ]);
    assert.equal(alignOf(out), undefined, "the alignment survived");
    assert.equal(bgOf(out), "#141414", "the ground survived");
  });
});

describe("what it must not touch", () => {
  test("an alignment the operator actually chose survives", () => {
    // `right` is impossible to arrive at by accident — the registry only ever
    // wrote `center` — so it is a decision, and decisions are not ours to undo.
    const out = migrateNeverChosenDefaults([view([obj("clock", { textAlign: "right" })])]);
    assert.equal(alignOf(out), "right", "a chosen alignment was cleared");
  });

  test("a non-readout keeps its centre", () => {
    // Plain text, slide text, service items: centred is their default and their
    // composition, and nothing about this change touches them.
    const out = migrateNeverChosenDefaults([view([obj("text", { textAlign: "center" })])]);
    assert.equal(alignOf(out), "center", "a text object lost its alignment");
  });

  test("an object with no style at all is left alone", () => {
    const out = migrateNeverChosenDefaults([view([obj("clock", undefined)])]);
    assert.equal(alignOf(out), undefined);
  });
});

describe("running it twice", () => {
  test("the array comes back BY REFERENCE when there is nothing to do", () => {
    // So the caller skips the write. This runs on every load beside two other
    // migrations over the same file; a fresh array each launch is a rewrite for
    // nothing, and three writers racing is how one of them loses.
    const views = [view([obj("clock", { textAlign: "right" }), obj("text", { textAlign: "center" })])];
    assert.equal(migrateNeverChosenDefaults(views), views);
  });

  test("a second run changes nothing", () => {
    const once = migrateNeverChosenDefaults([view([obj("clock", { textAlign: "center" })])]);
    assert.equal(migrateNeverChosenDefaults(once), once);
  });
});

describe("the count that gets logged", () => {
  test("it matches what was actually cleared", () => {
    // The log line is how an operator whose layouts moved finds out why. A count
    // that disagreed with the migration would send them looking for a bug that
    // is not there.
    const views = [
      view([
        obj("clock", { textAlign: "center" }),
        obj("text", { textAlign: "center" }),
        obj("obs-status", { textAlign: "right" }),
        obj("container", undefined, [obj("spl-meter", { textAlign: "center" })]),
      ]),
    ];
    assert.equal(countNeverChosen(views), 2);
  });

  test("it is zero once the migration has run", () => {
    const views = [view([obj("clock", { textAlign: "center" })])];
    assert.equal(countNeverChosen(migrateNeverChosenDefaults(views)), 0);
  });
});
