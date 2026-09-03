// The ScriptView rundown fills its page instead of sitting in a white frame.
//
// It paints a kiosk surface — a dark ground, edge to edge — but it is routed
// INSIDE the operator shell, which gutters its content: 20px each side and 16px
// under the strip. So a dark slab rendered inside a light border on all four
// sides, which is what was reported.
//
// It also asked for `h-[100dvh]`. It was written as a standalone full-screen page
// and it does not own the viewport here: it sits below a 44px context bar, so it
// came out 60px taller than the space it was given and scrolled by exactly the
// height of the chrome above it. Measured in a browser at 713x820: slot 760px,
// page 820px.
//
// The sides are cancelled the way a console cancels them, with negative margins.
// The TOP is withheld by the shell, because a negative top margin on an h-full
// box moves it without giving it the height back and simply puts the band at the
// bottom — the mistake made once already on the console and not worth making
// twice.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { isFullBleedPath, isConsolePath } from "./active-page.js";
import type { View } from "../../main/types/views.js";

const VIEWS = [
  { id: "view-1", name: "Bench Console", kind: "custom", surface: "console" },
  { id: "display-1", name: "Display 1", kind: "slots", surface: "display" },
] as unknown as View[];

describe("which routes paint their own surface", () => {
  it("the rundown does", () => {
    assert.equal(isFullBleedPath("/scriptview/weekend/audio", VIEWS), true);
    assert.equal(isFullBleedPath("/scriptview/cornerstone-youth/full", VIEWS), true);
  });

  it("and so does a console — the rule generalises rather than replacing it", () => {
    assert.equal(isFullBleedPath("/consoles/view-1", VIEWS), true);
    assert.equal(isConsolePath("/consoles/view-1", VIEWS), true);
  });

  it("but NOT ScriptView's own ordinary pages", () => {
    // `/scriptview` is a list and `/scriptview/presets` is a settings page. Both
    // are pages in the ordinary sense and want the gutter; taking it away would
    // press them against the strip and the window edge.
    assert.equal(isFullBleedPath("/scriptview", VIEWS), false);
    assert.equal(isFullBleedPath("/scriptview/presets", VIEWS), false);
  });

  it("and not a deeper path that happens to start the same way", () => {
    assert.equal(isFullBleedPath("/scriptview/weekend/audio/extra", VIEWS), false);
  });

  it("and not an ordinary page", () => {
    for (const p of ["/", "/screens", "/patch", "/settings/integrations"]) {
      assert.equal(isFullBleedPath(p, VIEWS), false, `${p} was taken for a full-bleed route`);
    }
  });
});

describe("the page and the shell each do their half", () => {
  const shell = readFileSync(new URL("./shell.tsx", import.meta.url), "utf8");
  const page = readFileSync(new URL("../main/scriptview-plan-view.tsx", import.meta.url), "utf8");

  it("the shell withholds the top gutter for a full-bleed route", () => {
    assert.match(
      shell,
      /!chromeless && !fullBleed && "sm:pt-4"/,
      "the shell applies its top gutter regardless, so the band above the rundown comes back",
    );
  });

  it("the page cancels the side gutter itself", () => {
    // Width is not h-full: negative inline margins genuinely widen the box, which
    // is why this half CAN be done from the page.
    assert.match(page, /-mx-5 max-sm:-mx-3/, "the rundown sits inside the 20px side gutter again");
  });

  it("the page sizes to its slot, not to the viewport", () => {
    assert.doesNotMatch(
      page,
      /h-\[100dvh\]/,
      "the rundown asks for the whole viewport again — below a 44px bar that is 60px of overflow",
    );
    assert.match(page, /flex flex-col h-full overflow-hidden kiosk-surface/, "the rundown no longer fills its slot");
  });

  it("the page does NOT try to cancel the top with a negative margin", () => {
    // The mistake made once on the console: it moves the box without resizing it,
    // so the white band goes to the bottom instead of going away.
    const outer = /className="flex flex-col h-full[^"]*"/.exec(page)?.[0] ?? "";
    assert.doesNotMatch(outer, /-mt-/, "the rundown pulls itself up — that moves the band, it does not remove it");
  });
});
