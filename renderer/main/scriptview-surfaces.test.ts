// One rundown, called from three places — and it has to stay that way.
//
// The requirement was that nothing looks different between the ScriptView page,
// the `script` View-kind and the layout object. That was true the day it was
// built, verified in a browser: the rundown TABLE hashed identically on the page
// and inside a custom layout. A browser check proves it once; this stops it
// quietly becoming false later, which is the failure mode that matters — nobody
// re-runs a manual comparison before shipping an unrelated change.
//
// Deliberately structural rather than visual. A screenshot diff would be the
// obvious answer and the wrong one: it needs a browser, real PCO data and a
// frozen clock, and it fails for reasons that have nothing to do with the claim.
// What actually guarantees identical output is that there is only ONE component,
// so that is what gets asserted — no surface may grow its own rundown markup.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { EMBEDDABLE_VIEW_KINDS, isEmbeddableViewKind } from "./layout-objects.js";
import { embedRefusal } from "./embed-chain.js";
import type { ViewKind } from "../../main/types/stage.js";

/** Every kind a View can be — so "exactly these are embeddable" is checked
 *  against the real set rather than a list that can quietly fall behind. */
const ALL_VIEW_KINDS: ViewKind[] = ["slots", "dashboard", "stage", "transcription", "custom", "script", "spl-rundown"];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f: string) => fs.readFileSync(path.join(HERE, f), "utf8");

/** The three files that put a plan rundown on a screen. The layout object no
 *  longer names ScriptView itself — every embedded View of every kind goes
 *  through embedded-view.tsx, so that is the surface now. */
const SURFACES = {
  page: "scriptview-plan-view.tsx",
  viewKind: "script-view.tsx",
  layoutObject: "embedded-view.tsx",
} as const;

/** The shared implementation every one of them must go through. */
const SHARED = "scriptview-body.tsx";

describe("the rundown has one implementation", () => {
  it("every surface renders the shared body", () => {
    for (const [name, file] of Object.entries(SURFACES)) {
      const src = read(file);
      const usesShared =
        /<ScriptViewBody\b/.test(src) || /<ScriptView\b/.test(src);
      assert.ok(usesShared, `${name} (${file}) no longer renders the shared rundown`);
    }
  });

  it("no surface builds its own rundown table", () => {
    // RundownTable is the row-level primitive. The moment a surface reaches for
    // it directly it has its own copy of the markup around it, which is exactly
    // how the three rundowns drifted apart the first time. Only the shared body
    // and the ScriptView settings preview may use it.
    for (const [name, file] of Object.entries(SURFACES)) {
      const src = read(file);
      assert.ok(
        !/<RundownTable\b/.test(src),
        `${name} (${file}) renders RundownTable directly — build on ${SHARED} instead`,
      );
    }
  });

  it("the shared body owns the column and live-state derivation", () => {
    // If a surface computed its own columns or its own "is this plan live", the
    // two could disagree while the markup stayed identical — a rundown
    // highlighting a row on a service that is not running looks fine and is
    // wrong. The derivation lives in the hook; nobody else may call the pieces.
    const shared = read(SHARED);
    for (const fn of ["buildScriptViewColumns", "resolveScriptViewSpec", "computeClocks"]) {
      assert.ok(shared.includes(fn), `${SHARED} should own ${fn}`);
    }
    for (const [name, file] of Object.entries(SURFACES)) {
      const src = read(file);
      for (const fn of ["buildScriptViewColumns", "resolveScriptViewSpec", "computeClocks"]) {
        assert.ok(
          !src.includes(fn),
          `${name} (${file}) derives ${fn} itself — use useScriptViewRender`,
        );
      }
    }
  });

  // Matched inside a className, never as a bare token. The first draft of this
  // scan looked for "100dvh" anywhere and failed on a COMMENT explaining why the
  // viewport height must not be used — a guard satisfied (here, broken) by prose
  // is the recurring bug in this repo, and stripping comments to fix it has its
  // own history of swallowing real code. A class attribute is a shape prose does
  // not take.
  const viewportHeightInClass = () => /className="[^"]*(?:h-\[100dvh\]|h-\[100vh\]|h-screen)/;

  it("the shared body claims no height of its own", () => {
    // It is embedded in boxes of three different shapes. A viewport height here
    // means 100% of the SCREEN rather than of the box it was given — on the page
    // that pushes the last rows past the clip, hidden by the sticky footer, so it
    // looks right and scrolls short. An earlier draft did exactly that.
    assert.ok(
      !viewportHeightInClass().test(read(SHARED)),
      `${SHARED} must not size itself to the viewport`,
    );
  });

  it("the embeddable View-kind sizes to its box, not the screen", () => {
    // ScriptView renders both on a display and inside a layout object. The kiosk
    // route supplies the screen height; the component must not assume it.
    assert.ok(
      !viewportHeightInClass().test(read(SURFACES.viewKind)),
      "script-view.tsx must size to h-full, not the viewport",
    );
  });
});

describe("embedding cannot recurse", () => {
  // The first version of this asserted that the string `kind !== "custom"`
  // appeared SOMEWHERE in a 2,500-line file, and that the renderer lacked one
  // particular literal. Both halves were satisfiable while the behaviour broke:
  // any unrelated expression keeps the positive half true, and a custom branch
  // spelled differently slips past the negative one. A guard that can pass on
  // the bug it guards is the recurring failure in this repo, so the decision was
  // moved into a function and the function is what gets called here.

  it("refuses a view that is already being drawn above this one", () => {
    // Custom views used to be barred outright, which made recursion impossible
    // by making the only nestable kind unavailable. They render now, so the
    // guard is a real one: the ancestor chain, checked per box.
    assert.equal(isEmbeddableViewKind("custom"), true);
    assert.ok(embedRefusal("v-1", ["v-1"]), "a view inside itself was not refused");
    assert.ok(embedRefusal("v-9", ["a", "b", "c"]), "unbounded nesting was not refused");
    assert.equal(embedRefusal("v-9", ["a", "b"]), null, "legal nesting was refused");
  });

  it("offers exactly the kinds that render in a box", () => {
    // EXACT, not a floor. Every kind renders now, so this is every kind — and it
    // stays a written-out list so that adding a View kind is a deliberate
    // decision to make it embeddable rather than something that happens by
    // accident. EmbeddedView's switch is exhaustive over ViewKind, so a kind
    // added and forgotten here is a compile error there.
    assert.deepEqual(
      [...EMBEDDABLE_VIEW_KINDS],
      ["slots", "dashboard", "stage", "transcription", "custom", "script", "spl-rundown"],
    );
    assert.deepEqual([...EMBEDDABLE_VIEW_KINDS].sort(), [...ALL_VIEW_KINDS].sort());
  });

  // "never offers a kind it cannot render" used to live here, walking every kind
  // and checking the picker against the renderer. It guarded a real hazard while
  // the two lists could differ; isOfferableInEmbedPicker now just calls
  // isEmbeddableViewKind, so the loop asserted a function equals itself. What
  // actually stops a kind being offered that cannot be drawn is EmbeddedView's
  // exhaustive switch over ViewKind — a compile error, not a test — plus the
  // list equality asserted above.
});
