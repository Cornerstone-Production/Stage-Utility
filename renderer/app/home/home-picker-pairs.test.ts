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
import { describe, it } from "node:test";
import { LAYOUT_OBJECTS, SUPERSEDED_ON_HOME, PALETTE_GROUPS } from "../../main/layout-objects.js";
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

  it("the wall palette is untouched by this change", () => {
    // It carries all 15 home-* cards as well as the wall widgets — the pickers
    // overlap in BOTH directions, and only the Home half is being changed here.
    // Whether a wall should stop offering the six home cards whose wall twin it
    // already has is the mirror of this question and has not been asked.
    const onWall = PALETTE_GROUPS.flatMap((g) => g.types as readonly string[]);
    assert.equal(onWall.filter((t) => t.startsWith("home-")).length, 15);
  });
});
