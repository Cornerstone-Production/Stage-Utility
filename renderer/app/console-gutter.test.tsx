// A console gets no gutter under the strip, and gets the height instead.
//
// The shell gives every page `sm:pt-4` — air between the context strip and the
// page under it. A console has no page to give air to: it fills its area edge to
// edge, so that 16px rendered as a band of empty white between the strip and the
// stage-black, thicker below the strip's text than above it, reading as part of
// the bar rather than as page padding.
//
// THE FIRST FIX WAS WRONG AND THIS IS THE HALF THAT CATCHES IT. The console
// cancelled the padding itself with `sm:-mt-4`, the way it already cancels the
// horizontal gutter with `-mx-5`. But the console is `h-full`, and a negative
// margin moves a box without giving it the height back — so it still measured
// the padded area, ended 16px short, and the white band simply moved from above
// the console to below it. Measured in a browser at 900x800:
//
//     before          console 740px   16px above   0 below
//     -mt-4           console 740px    0 above    16 below
//     no padding      console 756px    0 above     0 below
//
// So the padding has to not be applied at all, which is a decision only the
// shell can make. Both halves are asserted here: the shell must know a console
// path when it sees one, and the console must NOT try to cancel padding itself.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { isConsolePath } from "./active-page.js";
import { withoutComments } from "../source-comments.js";
import type { View } from "../../main/types/views.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const VIEWS = [
  { id: "view-1", name: "Bench Console", kind: "custom", surface: "console" },
  { id: "display-1", name: "Display 1", kind: "slots", surface: "display" },
  { id: "home", name: "Home", kind: "custom", surface: "console" },
] as unknown as View[];

describe("the shell can tell a console from a page", () => {
  test("a console's own path is one", () => {
    assert.equal(isConsolePath("/consoles/view-1", VIEWS), true);
  });

  test("Home is not, even though it is a console View", () => {
    // consoleViewList filters it out — the rail once carried two Home entries —
    // and /consoles/home redirects to /. So the gutter rule must not fire on it.
    assert.equal(isConsolePath("/consoles/home", VIEWS), false);
  });

  test("a display View is not — it is served by a different document", () => {
    assert.equal(isConsolePath("/consoles/display-1", VIEWS), false);
  });

  test("an ordinary page is not", () => {
    for (const p of ["/", "/screens", "/settings/integrations", "/patch"]) {
      assert.equal(isConsolePath(p, VIEWS), false, `${p} was taken for a console`);
    }
  });

  test("a CHILD of a console is not — exact match, never a prefix", () => {
    // A prefix would carry the no-gutter rule onto a route the operator never
    // set it on, which is the same trap consoleHidesChrome documents.
    assert.equal(isConsolePath("/consoles/view-1/edit", VIEWS), false);
  });

  test("no views, no consoles", () => {
    assert.equal(isConsolePath("/consoles/view-1", undefined), false);
    assert.equal(isConsolePath("/consoles/view-1", []), false);
  });
});

describe("the gutter is decided in one place", () => {
  // COMMENTS STRIPPED FIRST. Both files explain the bug in prose, naming the very
  // class this forbids — so a raw-text scan fails on the explanation of the fix
  // rather than on the fix being absent. That is the same defect as a comment
  // SATISFYING a scan, arriving from the other side.
  const shell = withoutComments(readFileSync(path.join(HERE, "shell.tsx"), "utf8"));
  const consoleRoute = withoutComments(readFileSync(path.join(HERE, "console-route.tsx"), "utf8"));

  test("the shell withholds the padding on a console", () => {
    // The predicate generalised when ScriptView's rundown turned out to have the
    // same problem — it is `isFullBleedPath` now, of which a console is one case.
    // See scriptview-full-bleed.test.ts, which pins the membership.
    assert.match(
      shell,
      /!chromeless && !fullBleed && "sm:pt-4"/,
      "the shell applies its top gutter without asking whether this route paints its own surface — a console renders it as a white band against the stage-black",
    );
  });

  test("the console does not try to cancel it with a negative margin", () => {
    // The exact shape of the bug: it moves the band to the bottom instead.
    assert.doesNotMatch(
      consoleRoute,
      /-mt-\d/,
      "the console pulls itself up to cancel padding — it is h-full, so that moves the white band to the BOTTOM rather than giving the console the height",
    );
  });

  test("the horizontal cancel stays, because that one does work", () => {
    // Width is not h-full: the negative inline margins genuinely widen the box.
    assert.match(consoleRoute, /-mx-5/, "the console lost its full-bleed width");
  });
});
