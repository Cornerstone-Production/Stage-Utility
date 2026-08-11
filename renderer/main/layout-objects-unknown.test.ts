// Layouts outlive the build that wrote them.
//
// `views.json` is a CONFIG store: it is exported, imported, backed up and
// restored, and none of that is version-locked. Upload a config saved by a newer
// version onto an older server — which is exactly what "restore my settings"
// does — and it arrives holding object types this build has never heard of.
//
// The type system says that cannot happen: every `LayoutObjectType` is a key of
// `LAYOUT_OBJECTS`. That guarantee is true within one build and worthless across
// two, so every accessor reading straight off the lookup threw on the undefined
// it was told it could not get. Opening the layout editor on such a view failed
// with `can't access property "label", undefined` and white-screened the entire
// Views page — no route back except hand-editing config on disk.
//
// These call the accessors with a type that is deliberately NOT in the registry.
// Restore any of the bare `LAYOUT_OBJECTS[t].x` reads and this file throws.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  LAYOUT_OBJECTS,
  defaultConfig,
  defaultStyle,
  findLayoutObjectSpec,
  isKnownObjectType,
  isStylingOnly,
  objectIntegration,
  objectRetired,
  typeLabel,
  usesPropInstance,
} from "./layout-objects";

// A type from the future, cast the way a parsed config reaches this code.
const FROM_THE_FUTURE = "some-object-a-later-version-added" as LayoutObjectType;

describe("layout objects from a build we are not", () => {
  it("is genuinely absent from the registry (the premise of every case below)", () => {
    assert.equal(Object.hasOwn(LAYOUT_OBJECTS, FROM_THE_FUTURE), false);
  });

  it("reports itself unknown rather than pretending", () => {
    assert.equal(isKnownObjectType(FROM_THE_FUTURE), false);
    assert.equal(findLayoutObjectSpec(FROM_THE_FUTURE), null);
    // And a real one still resolves, so this is not passing by breaking everything.
    assert.equal(isKnownObjectType("clock" as LayoutObjectType), true);
    assert.ok(findLayoutObjectSpec("clock" as LayoutObjectType));
  });

  it("names it instead of throwing — this is the crash that white-screened Views", () => {
    const label = typeLabel(FROM_THE_FUTURE);
    assert.ok(label.includes(FROM_THE_FUTURE), "the label should say WHICH object is missing");
  });

  it("answers every capability query without throwing", () => {
    // The editor asks all of these while building the inspector for a selection.
    assert.equal(isStylingOnly(FROM_THE_FUTURE), false);
    assert.equal(usesPropInstance(FROM_THE_FUTURE), false);
    assert.equal(objectIntegration(FROM_THE_FUTURE), undefined);
    assert.equal(objectRetired(FROM_THE_FUTURE), undefined);
  });

  it("hands back inert config and style rather than exploding", () => {
    assert.deepEqual(defaultConfig(FROM_THE_FUTURE), { type: FROM_THE_FUTURE });
    assert.deepEqual(defaultStyle(FROM_THE_FUTURE), {});
  });

  it("still returns real values for every type this build DOES have", () => {
    // An EXACT sweep, not a spot check: a fallback that silently swallowed a
    // registry entry would otherwise look like resilience.
    const types = Object.keys(LAYOUT_OBJECTS) as LayoutObjectType[];
    assert.ok(types.length > 20, `expected the full registry, saw ${types.length}`);
    for (const t of types) {
      assert.ok(findLayoutObjectSpec(t), `${t} vanished from the registry`);
      assert.equal(isKnownObjectType(t), true, `${t} reported unknown`);
      assert.ok(typeLabel(t).length > 0, `${t} has no label`);
      assert.ok(!typeLabel(t).startsWith("Unsupported"), `${t} fell through to the unknown label`);
      assert.equal(defaultConfig(t).type, t, `${t} default config has the wrong type`);
    }
  });
});
