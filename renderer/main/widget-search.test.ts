// The one predicate behind both widget searches.
//
// Home's add-widget sheet and the layout editor's palette offer the same
// "Search widgets…" box over the same registry. They used to be one search and
// one scroll; when the palette got its box, the temptation was a second copy of
// the filter, and two copies of a rule are two rules that drift.
//
// Everything below is derived from the registry AS IT IS at run time rather than
// from a snapshot of it, so the assertions are about what the predicate does —
// not about a list of labels that has to be re-typed whenever a widget is added.

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import type { LayoutObjectType } from "../../main/types/stage.js";
import { LAYOUT_OBJECTS, widgetMatchesQuery } from "./layout-objects.js";

const TYPES = Object.keys(LAYOUT_OBJECTS) as LayoutObjectType[];

/** Words in a spec's blurb that appear NOWHERE in its label or its type name, so
 *  matching one can only have come from reading the blurb. */
function blurbOnlyWords(t: LayoutObjectType): string[] {
  const spec = LAYOUT_OBJECTS[t];
  const elsewhere = `${spec.label} ${t}`.toLowerCase();
  return (spec.blurb.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !elsewhere.includes(w));
}

describe("searching the widget registry", () => {
  test("an empty query is not a filter — every type survives it", () => {
    for (const q of ["", "   ", "\t"]) {
      const kept = TYPES.filter((t) => widgetMatchesQuery(t, q));
      assert.equal(kept.length, TYPES.length, `"${q}" dropped ${TYPES.length - kept.length} types`);
    }
  });

  test("every type is found by its own label, whatever case it is typed in", () => {
    for (const t of TYPES) {
      const label = LAYOUT_OBJECTS[t].label;
      assert.ok(widgetMatchesQuery(t, label), `${t} is not found by its own label "${label}"`);
      assert.ok(widgetMatchesQuery(t, label.toUpperCase()), `${t} is not found by "${label.toUpperCase()}"`);
      assert.ok(widgetMatchesQuery(t, `  ${label.toLowerCase()}  `), `${t} is not found by its label with spaces`);
    }
  });

  test("every type is found by the name the app spells it as", () => {
    // What a config file, a support answer or a URL calls it. An operator who has
    // seen "spl-meter" written down should be able to type it.
    for (const t of TYPES) {
      assert.ok(widgetMatchesQuery(t, t), `${t} is not found by its own type name`);
      assert.ok(widgetMatchesQuery(t, t.toUpperCase()), `${t} is not found by its type name in caps`);
    }
  });

  test("a type is found by a word that appears ONLY in its blurb", () => {
    // The blurb is what says a widget shows "how loud the room is" when its label
    // only says "SPL meter". Dropping the blurb from the predicate is invisible
    // against label matches, so this asserts on words the label cannot supply.
    const withBlurbOnlyWords = TYPES.filter((t) => blurbOnlyWords(t).length > 0);
    // The loop below runs over this FILTERED list, so whatever bounds it bounds
    // the coverage of the whole test. A floor at half the registry would let
    // thirty types drop out of the extractor in silence and stay green; and a
    // floor is how three config stores went missing from every backup.
    //
    // Named, not counted: the failure has to say WHICH type stopped producing a
    // blurb-only word, since that is the thing to go and look at. Every one of
    // the registry's types has one today, so the answer is the empty list — and
    // an empty list is the one assertion that cannot be satisfied by luck.
    assert.deepEqual(
      TYPES.filter((t) => blurbOnlyWords(t).length === 0),
      [],
      "these types' blurbs say nothing their labels do not, so this test no longer checks them",
    );
    for (const t of withBlurbOnlyWords) {
      const word = blurbOnlyWords(t)[0];
      assert.ok(widgetMatchesQuery(t, word), `${t} is not found by "${word}", which is only in its blurb`);
    }
  });

  test("a query that matches nothing matches nothing", () => {
    const kept = TYPES.filter((t) => widgetMatchesQuery(t, "zzqqxx"));
    assert.equal(kept.length, 0, `"zzqqxx" matched ${kept.join(", ")}`);
  });

  test("a type this build has never heard of is still searchable by name", () => {
    // Layouts arrive from other builds (views.json is a config store, carried
    // across versions by every restore), so the palette can be handed a type with
    // no registry entry. It must not throw, and it must still answer its name.
    const unknown = "from-the-future" as LayoutObjectType;
    assert.equal(widgetMatchesQuery(unknown, "future"), true);
    assert.equal(widgetMatchesQuery(unknown, "clock"), false);
    assert.equal(widgetMatchesQuery(unknown, ""), true);
  });
});
