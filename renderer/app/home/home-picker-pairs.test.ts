// Home offers its own card, not the wall widget it replaces.
//
// The Home picker was built from every entry in LAYOUT_OBJECTS, filtered only by
// `retired` and canvas-only. The wall palette is built from PALETTE_GROUPS, which
// carries no `home-*` type at all — so the convention was enforced in one
// direction and absent in the other, and six wall widgets appeared on Home beside
// the card written to replace them.
//
// "ProVideoPlayer now" and "On screen now" was the pair that got reported. They
// are not duplicates: the wall one lets you pick WHICH layer and draws its own
// card, the Home one has no layer choice and is BARE because Home draws the card.
// On Home the wall version is a card inside a card, which is why it is the one
// that goes.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { LAYOUT_OBJECTS, SUPERSEDED_ON_HOME, SUPERSEDED_ON_WALL, PALETTE_GROUPS } from "../../main/layout-objects.js";
import type { LayoutObjectType } from "@main/types/views.js";

const spec = (t: string) => LAYOUT_OBJECTS[t as keyof typeof LAYOUT_OBJECTS] as
  | { homeCardFor?: LayoutObjectType; homeSize?: string; style?: unknown }
  | undefined;

describe("every home card names the wall widget it replaces", () => {
  // EXACT. Six is the number that exists; a seventh pair added without a row
  // here is a pair nobody has checked renders correctly on Home.
  it("there are exactly six pairs", () => {
    assert.equal(
      SUPERSEDED_ON_HOME.size,
      6,
      `expected 6 wall types superseded on Home, found ${SUPERSEDED_ON_HOME.size}: ${[...SUPERSEDED_ON_HOME].join(", ")}`,
    );
  });

  it("names the pairs that were reported as duplicates", () => {
    for (const wall of ["pvp-now", "pvp-layers", "record-status", "obs-status", "reaper-status", "spl-meter"]) {
      assert.ok(SUPERSEDED_ON_HOME.has(wall as LayoutObjectType), `${wall} is still offered on Home`);
    }
  });

  it("every wall type named actually exists", () => {
    // A typo here would silently supersede nothing.
    for (const wall of SUPERSEDED_ON_HOME) {
      assert.ok(spec(wall), `homeCardFor names "${wall}", which is not a layout object`);
    }
  });

  it("a home card never supersedes another home card", () => {
    for (const wall of SUPERSEDED_ON_HOME) {
      assert.ok(!wall.startsWith("home-"), `${wall} is a Home card and cannot be the wall version of anything`);
    }
  });

  it("the card doing the replacing is offered on Home itself", () => {
    // Hiding the wall widget while its replacement is also absent would leave
    // the reading unreachable on Home — a removal wearing a fix's clothes.
    for (const [type, s] of Object.entries(LAYOUT_OBJECTS)) {
      const home = s as { homeCardFor?: string; homeSize?: string };
      if (!home.homeCardFor) continue;
      assert.ok(home.homeSize, `${type} replaces ${home.homeCardFor} on Home but is not offered there`);
    }
  });
});

describe("the wall palette is unchanged", () => {
  it("still offers every superseded widget", () => {
    // They are hidden on HOME only. A wall is exactly where they belong.
    const onWall = new Set(PALETTE_GROUPS.flatMap((g) => g.types as readonly string[]));
    for (const wall of SUPERSEDED_ON_HOME) {
      assert.ok(onWall.has(wall), `${wall} was removed from the wall palette, which is where it belongs`);
    }
  });

  it("hides exactly the six Home cards whose wall twin exists", () => {
    assert.equal(
      SUPERSEDED_ON_WALL.size,
      6,
      `expected 6 Home cards hidden from the wall, found ${SUPERSEDED_ON_WALL.size}: ${[...SUPERSEDED_ON_WALL].join(", ")}`,
    );
    for (const t of SUPERSEDED_ON_WALL) {
      assert.ok(t.startsWith("home-"), `${t} is not a Home card and has no business being hidden from a wall`);
    }
  });

  it("the streaming three are NOT hidden — they are the wall widget", () => {
    // There is no separate wall object for Resi or YouTube. layout-renderer
    // diverts these to a wall presentation through WALL_TWIN precisely so one
    // type serves both surfaces; hiding them takes Resi and YouTube status off
    // walls and consoles entirely.
    for (const t of ["home-streaming", "home-streaming-resi", "home-streaming-youtube"]) {
      assert.ok(!SUPERSEDED_ON_WALL.has(t as never), `${t} was hidden from the wall, where it is the only option`);
    }
  });

  it("a Home card with no wall equivalent is NOT hidden", () => {
    // Readiness, Next service, Service timer, Recent services, Screens online.
    // Hiding these removes the reading rather than relocating it.
    for (const t of ["home-readiness", "home-next-service", "home-live-status", "home-recent-services", "home-screens"]) {
      assert.ok(!SUPERSEDED_ON_WALL.has(t as never), `${t} has no wall twin, so hiding it removes the reading`);
    }
  });

  it("the two directions name the same six pairs", () => {
    // Both sets are derived from the same `homeCardFor` declarations, so a pair
    // can never be hidden on one surface and offered on the other.
    assert.equal(SUPERSEDED_ON_WALL.size, SUPERSEDED_ON_HOME.size);
    for (const home of SUPERSEDED_ON_WALL) {
      const wall = (LAYOUT_OBJECTS[home as keyof typeof LAYOUT_OBJECTS] as { homeCardFor?: string }).homeCardFor;
      assert.ok(wall && SUPERSEDED_ON_HOME.has(wall as never), `${home} hides from the wall but its twin ${wall} is still offered on Home`);
    }
  });

  it("the wall palette still carries the nine that stay", () => {
    // It carries all 15 home-* cards as well as the wall widgets — the pickers
    // overlap in BOTH directions, and only the Home half is being changed here.
    // Whether a wall should stop offering the six home cards whose wall twin it
    // already has is the mirror of this question and has not been asked.
    const onWall = PALETTE_GROUPS.flatMap((g) => g.types as readonly string[]);
    const offered = onWall.filter((t) => t.startsWith("home-") && !SUPERSEDED_ON_WALL.has(t as never));
    assert.equal(offered.length, 9, `expected 9 Home cards still offered on a wall, found ${offered.length}`);
  });
});

describe("the palette and the right-click menu agree", () => {
  // They are the same set by design — "two lists that could disagree about
  // which objects exist is how an operator finds a widget in one place and not
  // the other", says the comment above the submenu. Each carried its own copy of
  // the filter, so the wall rule would have gone into one and not the other.
  const src = readFileSync(new URL("../../editor/layout-editor.tsx", import.meta.url), "utf8");

  it("both read one predicate", () => {
    assert.match(src, /const offersType = useCallback/, "the shared predicate is gone");
    const uses = [...src.matchAll(/\.filter\(offersType\)/g)].length;
    assert.equal(uses, 2, `expected the palette and the submenu to use it, found ${uses}`);
  });

  it("and that predicate actually applies the wall rule", () => {
    // WITHOUT THIS the two above pass with the rule deleted: they check that one
    // predicate exists and that both lists call it, not that it does anything.
    // Removing the SUPERSEDED_ON_WALL line left every guard here green — the
    // exact shape this repo keeps shipping.
    const fn = /const offersType = useCallback\(([\s\S]*?)\n {2}\);/.exec(src)?.[1] ?? "";
    assert.match(
      fn,
      /SUPERSEDED_ON_WALL\.has\(t\)/,
      "the editor offers every Home card again — the six with a wall twin are back in the palette",
    );
  });

  it("neither carries its own copy of the integration filter any more", () => {
    const copies = [...src.matchAll(/hideUnconfigured && need && !configuredIntegrations\.has/g)].length;
    assert.equal(copies, 1, `the filter is written out ${copies} times; it drifted once already`);
  });
});
