// Signage has to be a real view kind end to end.
//
// The failure this guards is quiet rather than loud. isDisplayKind is what a
// POST that routes an Output to a View is validated against, so a kind missing
// from it can be created in the picker and then silently refused when you try to
// bind a screen to it — the operator sees a view that exists and cannot be used,
// with no error naming the reason.
//
// The renderer's dispatch is a different shape of risk: it is an if-chain with a
// fallback, NOT an exhaustive switch, so nothing type-checks that "signage" has
// an arm. Without one a signage screen silently renders the slots grid.

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import { describe, test } from "node:test";

import { isDisplayKind } from "@main/services/routes/context";

describe("signage is a real view kind", () => {
  test("the server accepts it when routing an output to a view", () => {
    assert.equal(isDisplayKind("signage"), true);
  });

  test("and every other kind still passes", () => {
    for (const k of ["slots", "dashboard", "stage", "transcription", "custom", "script", "spl-rundown"]) {
      assert.equal(isDisplayKind(k), true, `${k} stopped being accepted`);
    }
  });

  test("while nonsense is still refused", () => {
    for (const bad of ["banana", "", null, undefined, 7, {}, ["signage"]]) {
      assert.equal(isDisplayKind(bad), false, `${String(bad)} was accepted as a view kind`);
    }
  });
});

describe("the display renderer", () => {
  // Read as source text on purpose, and this is the weaker kind of check: the
  // renderer's dispatch is an if-chain with a fallback, so a missing arm cannot
  // be caught by the type system OR by rendering (it would just draw slots). The
  // assertion is on the arm being present and routing to the player, which prose
  // in a comment cannot satisfy.
  const SRC = fs.readFileSync("renderer/main/stage-view.tsx", "utf8");

  test("has an arm for the signage kind", () => {
    assert.match(SRC, /kind === "signage"/, "a signage screen would fall through to the slots grid");
  });

  test("and that arm renders the signage surface", () => {
    const arm = SRC.slice(SRC.indexOf('kind === "signage"'), SRC.indexOf('kind === "signage"') + 400);
    assert.match(arm, /SignageScreen/, "the signage arm does not draw the signage surface");
  });

  test("which in turn draws the player", () => {
    // Two hops, so both are checked. A surface that rendered anything else -
    // a placeholder, a message - would be text on a wall.
    const screen = fs.readFileSync("renderer/main/signage-screen.tsx", "utf8");
    assert.match(screen, /<SignagePlayer/);
  });
});
