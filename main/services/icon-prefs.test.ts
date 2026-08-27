// An icon colour did not survive a restart, and a glyph would have shipped with
// the same defect.
//
// Both setters write to settings.json and both are correct. Neither map was READ
// BACK when the state was built at boot, so the value sat on disk describing an
// icon nothing would ever draw again. Verified against a real server before the
// fix: set a colour, confirm it in /api/state and in settings.json, restart, and
// /api/state comes back with iconColors absent.
//
// Source text, because the alternative is booting a controller with a real data
// directory inside a unit test, and what has to hold is a property of the state
// BUILDER: every persisted map it can write, it also reads.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const SRC = readFileSync(new URL("./stage-controller.ts", import.meta.url), "utf8");

/** The block that builds the initial state from `settings`. */
function hydrationBlock(): string {
  const m = /appName: settings\.appName[\s\S]*?onboardingDismissed: settings\.onboardingDismissed[^\n]*\n/.exec(SRC);
  assert.ok(m, "could not find the state hydration block in stage-controller.ts");
  return m[0];
}

describe("what the operator set is still there after a restart", () => {
  test("icon colours are read back at boot", () => {
    assert.match(hydrationBlock(), /iconColors: settings\.iconColors/);
  });

  test("icon glyphs are read back at boot", () => {
    assert.match(hydrationBlock(), /iconGlyphs: settings\.iconGlyphs/);
  });

  test("every settings key the controller WRITES is READ somewhere at boot", () => {
    // The rule, rather than two more names to remember: a setter that patches
    // settings.<key> and a boot that never reads settings.<key> anywhere is the
    // defect, whichever key it is.
    //
    // "read somewhere", not "read in the state literal": several keys hydrate
    // through a local computed above it (`outputs`, `showQr`, the plan fields),
    // and pinning the literal's exact spelling would fail on a refactor that
    // changed nothing. What cannot pass is a key the file never reads at all,
    // which is exactly how iconColors was lost.
    const written = new Set(
      [...SRC.matchAll(/settingsStore\.patch\(\{\s*([A-Za-z0-9_]+)[:,\s}]/g)].map((m) => m[1]),
    );
    assert.ok(written.size >= 8, `expected the real setter list, found ${written.size}`);
    // Everything OUTSIDE the patch calls. A key that appears only where it is
    // written is a key nothing ever reads — which is the defect, whatever
    // spelling the read would have used (`settings.x` in the state literal, or
    // `(await settingsStore.get()).x` in a migration).
    const elsewhere = SRC.replace(/settingsStore\.patch\(\{[\s\S]*?\}\)/g, "");
    const unread = [...written].filter((k) => !elsewhere.includes(k));
    assert.deepEqual(unread, [], "written to settings.json but never read back");
  });
});
