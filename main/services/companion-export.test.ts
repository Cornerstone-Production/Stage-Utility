// Reading a Companion export.
//
// Every case runs the real parser over a document built from the real 5.0.3
// shapes (see fixtures/companion-export.ts). Three of these are guards against
// specific ways this reads as "Companion has no buttons" rather than as an
// error:
//
//  - text at `style.layers[].text.value`, not `style.text`
//  - a connection at `moduleId`, not `instance_type`
//  - the literal `\n` inside a two-line button's label
//
// Each was found by reading a real export, and each would leave the picker empty
// or the cue name unsayable while every other test here passed.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  collapse,
  exportBuild,
  findPairs,
  isSuggestedPair,
  isUtilityModule,
  parseButtons,
  slugForCue,
  slugsForPairs,
  UTILITY_MODULES,
} from "./companion-export.js";
import {
  FIXTURE_PAGES,
  FIXTURE_PAGE_IDS,
  companionExportFixture,
  fixtureActionId,
} from "./fixtures/companion-export.js";

const EXPORT = companionExportFixture();
const BUTTONS = parseButtons(EXPORT);
const at = (page: number, row: number, col: number) =>
  BUTTONS.find((b) => b.page === page && b.row === row && b.col === col);

describe("parseButtons", () => {
  test("finds every labelled or acting button, and nothing else", () => {
    // EXACT, not a floor. Seven on page 1, four on page 2, three on page 3,
    // none on the navigation-only page. A floor here is how the pagenum
    // furniture creeps back in and the picker grows 150 rows of "Page 4".
    assert.equal(BUTTONS.length, 14);
    assert.deepEqual(
      [...new Set(BUTTONS.map((b) => b.page))].sort((a, b) => a - b),
      [1, 2, 3],
    );
  });

  test("skips pagenum, pageup and pagedown", () => {
    // Every fixture page carries all three at row 7. None may be pressable.
    assert.equal(BUTTONS.filter((b) => b.row === 7).length, 0);
  });

  test("reads the label out of a 5.x text LAYER, not style.text", () => {
    assert.equal(at(1, 0, 1)?.label, "Projectors ON");
  });

  test("collapses Companion's literal \\n so a two-line label is sayable", () => {
    // The export stores a backslash and an n, not a newline. Left alone it ends
    // up inside a cue name.
    assert.equal(at(1, 1, 1)?.label, "Lobby: TVs ON");
  });

  test("names the module a button drives, from moduleId (5.x)", () => {
    assert.deepEqual(at(1, 0, 1)?.drives, ["generic-pjlink"]);
  });

  test("still reads instance_type (3.x), so an older export is not blank", () => {
    assert.deepEqual(at(1, 1, 1)?.drives, ["generic-tcp-udp"]);
  });

  test("keeps a button that acts but has no label", () => {
    const blank = at(1, 3, 0);
    assert.ok(blank, "a button with actions and no text is still pressable");
    assert.equal(blank.label, "");
  });

  test("carries the page name, for grouping in the picker", () => {
    assert.equal(at(2, 0, 0)?.pageName, FIXTURE_PAGES.lights);
  });

  test("carries the page's opaque id, which a renumber does not change", () => {
    // `page` is a position and moves; this is the identity a cue is pinned to.
    assert.equal(at(1, 0, 1)?.pageId, FIXTURE_PAGE_IDS[1]);
    assert.equal(at(2, 0, 0)?.pageId, FIXTURE_PAGE_IDS[2]);
  });

  test("carries the button's action ids, sorted, as its fingerprint", () => {
    const on = at(1, 0, 1)!;
    assert.deepEqual(on.actionIds, [fixtureActionId(1, 0, 1, 0)]);
    // And no two buttons share one. A fixture that derived the id from the
    // CONNECTION gave both halves of a pair the same fingerprint, so a moved ON
    // would have been "found" at the OFF's coordinates.
    const all = BUTTONS.flatMap((b) => b.actionIds);
    assert.equal(new Set(all).size, all.length, "two buttons share an action id");
  });

  test("a button that runs nothing has an empty fingerprint, not a made-up one", () => {
    // 59 of the 536 buttons on the install this was built against. They can only
    // ever be identified by their coordinates, and pretending otherwise is worse.
    assert.deepEqual(at(3, 0, 0)?.actionIds, []);
  });

  test("actions nested in a logic_if count, for both drives and the fingerprint", () => {
    // 28 actions on the real install live in `children.actions`. A walk that
    // stopped at the top level said this button drives nothing — which decides
    // whether the import ticks it — and gave it an empty fingerprint, so moving
    // it would have read as two different buttons.
    const nested = at(3, 0, 1)!;
    assert.deepEqual(nested.drives, ["generic-pjlink"]);
    assert.deepEqual(nested.actionIds, [fixtureActionId(3, 0, 1, 0), fixtureActionId(3, 0, 1, 99)].sort());
  });

  test("a feedback id inside the condition branch is NOT part of the fingerprint", () => {
    // `children.condition` holds feedbacks, which carry ids and are not actions.
    // Folding one in would make a fingerprint that changes when somebody edits
    // the button's colour rule.
    assert.equal(at(3, 0, 1)!.actionIds.length, 2);
  });

  test("junk in yields nothing out, never a throw", () => {
    for (const junk of [null, undefined, 42, "no", [], { pages: "no" }, { pages: { a: 1 } }]) {
      assert.deepEqual(parseButtons(junk), []);
    }
  });
});

describe("exportBuild", () => {
  test("reports the Companion build", () => {
    assert.equal(exportBuild(EXPORT), "5.0.3+9703-stable-2daa0d7670");
  });
  test("null when absent", () => {
    assert.equal(exportBuild({}), null);
  });
});

describe("findPairs", () => {
  const pairs = findPairs(BUTTONS);
  const bases = pairs.map((p) => `${p.page}:${p.base}`);

  test("finds exactly the ON/OFF and Startup/Shutdown sets", () => {
    assert.deepEqual(bases, [
      "1:Lobby: TVs",
      "1:Projectors",
      "2:Projectors",
      "2:Rig",
    ]);
  });

  test("an ON with no OFF is not a pair", () => {
    assert.equal(bases.some((b) => b.includes("House Lights")), false);
  });

  test("a label with no suffix is not a pair", () => {
    assert.equal(bases.some((b) => b.includes("Take Screens")), false);
  });

  test("the same base on two pages stays two separate pairs", () => {
    // The failure this prevents is silent and expensive: "Projectors" on the
    // lighting page drives a different device from "Projectors" on the screens
    // page, and one cue for both is found out mid-setup.
    const projectors = pairs.filter((p) => p.base === "Projectors");
    assert.equal(projectors.length, 2);
    assert.deepEqual(projectors.map((p) => p.on.drives[0]), ["generic-pjlink", "malighting-msc"]);
  });

  test("each half points at its own coordinates", () => {
    const p = pairs.find((x) => x.page === 1 && x.base === "Projectors")!;
    assert.deepEqual([p.on.row, p.on.col], [0, 1]);
    assert.deepEqual([p.off.row, p.off.col], [0, 2]);
  });
});

describe("slugForCue", () => {
  test("makes a sayable snake_case name", () => {
    assert.equal(slugForCue("Projectors"), "projectors");
    assert.equal(slugForCue("Lobby: TVs"), "lobby_tvs");
    assert.equal(slugForCue("Conf TV HL"), "conf_tv_hl");
    assert.equal(slugForCue("Proj. 1"), "proj_1");
  });
  test("a label with nothing usable in it yields nothing, not an underscore", () => {
    assert.equal(slugForCue("---"), "");
    assert.equal(slugForCue(""), "");
  });
});

describe("slugsForPairs", () => {
  const pairs = findPairs(BUTTONS);
  const slugs = slugsForPairs(pairs);

  test("a base used on one page keeps its plain name", () => {
    assert.equal(slugs.get("1:lobby_tvs"), "lobby_tvs");
    assert.equal(slugs.get("2:rig"), "rig");
  });

  test("a base used on TWO pages is prefixed with the page, on both", () => {
    // Found on the real Companion this was built against: "Conf TVs ON" exists
    // on two auditoriums' pages driving different televisions. Without this the
    // second import is refused as a duplicate and one room quietly has no cue.
    assert.equal(slugs.get("1:projectors"), "room_a_screens_projectors");
    assert.equal(slugs.get("2:projectors"), "room_a_lighting_projectors");
  });

  test("no two pairs end up with the same name", () => {
    const names = [...slugs.values()];
    assert.equal(new Set(names).size, names.length);
  });
});

describe("collapse", () => {
  test("handles real whitespace and the literal escape alike", () => {
    assert.equal(collapse("a\n b"), "a b");
    assert.equal(collapse("a\\nb"), "a b");
    assert.equal(collapse("  a   b  "), "a b");
  });
});

describe("isSuggestedPair", () => {
  // Which pairs the import dialog TICKS. This used to be a list of one site's
  // Companion page names, which means nothing on anybody else's install — what a
  // button drives is in every export.
  const pairs = findPairs(BUTTONS);
  const suggested = pairs.filter(isSuggestedPair).map((p) => `${p.page}:${p.base}`);

  test("ticks the pairs that drive a utility device, and only those", () => {
    // EXACT. Projectors on page 1 drive generic-pjlink; Rig and Projectors on
    // page 2 drive malighting-msc, matched by the family wildcard. "Lobby: TVs"
    // drives generic-tcp-udp — something we cannot say is a projector — so it is
    // offered unticked rather than pre-armed.
    assert.deepEqual(suggested, ["1:Projectors", "2:Projectors", "2:Rig"]);
  });

  test("no page name appears anywhere in the rule", () => {
    // The whole point of the heuristic: a Companion page name is one building's
    // furniture and must not be in this repository at all.
    for (const m of UTILITY_MODULES) assert.match(m, /^[a-z0-9-]+\*?$/);
  });

  test("a family wildcard matches the family and nothing beyond it", () => {
    assert.equal(isUtilityModule("malighting-msc"), true);
    assert.equal(isUtilityModule("malighting-grandma3"), true);
    assert.equal(isUtilityModule("generic-pjlink"), true);
    assert.equal(isUtilityModule("GENERIC-PJLINK"), true);
    assert.equal(isUtilityModule("generic-pjlink-extra"), false);
    assert.equal(isUtilityModule("bmd-atem"), false);
    assert.equal(isUtilityModule(""), false);
  });
});
