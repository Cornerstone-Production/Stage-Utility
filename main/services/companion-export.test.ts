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
  cueSlugs,
  customVariableNames,
  exportBuild,
  findPairs,
  importedCueNames,
  importedCues,
  isCompanionVariableName,
  isCompanionVariableRef,
  isSuggestedPair,
  isUtilityModule,
  parseButtons,
  parseVariableRef,
  singleButtons,
  slugForCue,
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
    // EXACT, not a floor. Seven on page 1, four on page 2, eight on page 3,
    // eleven on the recorders page, none on the navigation-only page. A floor
    // here is how the pagenum furniture creeps back in and the picker grows 150
    // rows of "Page 4".
    assert.equal(BUTTONS.length, 30);
    assert.deepEqual(
      [...new Set(BUTTONS.map((b) => b.page))].sort((a, b) => a - b),
      [1, 2, 3, 5],
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

  test("finds exactly the ON/OFF, Startup/Shutdown and START/STOP sets", () => {
    assert.deepEqual(bases, [
      "1:Lobby: TVs",
      "1:Projectors",
      "2:Projectors",
      "2:Rig",
      "5:Deck 1",
      "5:PTZ",
    ]);
  });

  test("START/STOP is a pair, and its cues are still named _on and _off", () => {
    // How a recorder is labelled. Without it the two halves of every deck,
    // encoder and camera recording were two unrelated one-shot cues.
    const deck = pairs.find((p) => p.base === "Deck 1");
    assert.equal(deck?.on.label, "Deck 1 START");
    assert.equal(deck?.off.label, "Deck 1 STOP");
    // The NAMES the import writes, from the one function the import and the
    // reconcile both ask.
    const cues = importedCues(BUTTONS);
    assert.equal(cues.get("5:1:0")?.slug, "deck_1_on");
    assert.equal(cues.get("5:1:1")?.slug, "deck_1_off");
    assert.equal(cues.get("5:1:0")?.pair?.half, "on");
    // And a relabelled half is still recognised as named after its button, so
    // the reconcile renames it rather than leaving it alone as hand-named.
    assert.ok(importedCueNames("Deck 1 START", FIXTURE_PAGES.recorders).includes("deck_1_on"));
  });

  test("a START and a STOP on different devices do NOT pair", () => {
    // Same page, adjacent keys, no shared base: "Deck 2 START" and "Encoder
    // STOP". Paired, saying "deck 2 off" would stop the encoder.
    assert.equal(bases.includes("5:Deck 2"), false);
    assert.equal(bases.includes("5:Encoder"), false);
    const singles = singleButtons(BUTTONS, pairs).map((b) => b.label);
    assert.ok(singles.includes("Deck 2 START"));
    assert.ok(singles.includes("Encoder STOP"));
  });

  test("the START half is what the state source is inferred from", () => {
    // A deck has no power state; `status` is its transport, and the `rec`
    // action on the START half is what says the pair is about recording.
    const deck = pairs.find((p) => p.base === "Deck 1");
    assert.deepEqual(deck?.on.stateSource, {
      variable: "MA_HyperDeck_01:status",
      onValue: "Record",
      offValue: "*",
      moduleId: "bmd-hyperdeck",
    });
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

describe("cueSlugs", () => {
  const pairs = findPairs(BUTTONS);
  const singles = singleButtons(BUTTONS, pairs);
  const slugs = cueSlugs(pairs, singles);

  test("a base used on one page keeps its plain name", () => {
    assert.equal(slugs.pairs.get("1:lobby_tvs"), "lobby_tvs");
    assert.equal(slugs.pairs.get("2:rig"), "rig");
  });

  test("a base used on TWO pages is prefixed with the page, on both", () => {
    // Found on the real Companion this was built against: "Conf TVs ON" exists
    // on two auditoriums' pages driving different televisions. Without this the
    // second import is refused as a duplicate and one room quietly has no cue.
    assert.equal(slugs.pairs.get("1:projectors"), "room_a_screens_projectors");
    assert.equal(slugs.pairs.get("2:projectors"), "room_a_lighting_projectors");
  });

  test("no two offers end up with the same cue name", () => {
    const names = [
      ...[...slugs.pairs.values()].filter(Boolean).flatMap((b) => [`${b}_on`, `${b}_off`]),
      ...[...slugs.buttons.values()].filter(Boolean),
    ];
    assert.equal(new Set(names).size, names.length);
  });

  test("a single button and a PAIR half that would share a name are both qualified", () => {
    // Counted per family this is invisible: "House Lights ON" is the only
    // single called that, and the pair is the only pair called that, so each is
    // unique in its own list and both come out `house_lights_on`. The import
    // then creates one and refuses the other, and a room quietly has no cue.
    const together = [
      // A lone ON, offered as a script.
      at(1, 2, 1)!,
      // A whole pair on another page, offered as a switch.
      { ...at(1, 2, 1)!, page: 2, pageName: FIXTURE_PAGES.lights, row: 5, col: 0 },
      {
        ...at(1, 2, 1)!,
        page: 2,
        pageName: FIXTURE_PAGES.lights,
        row: 5,
        col: 1,
        label: "House Lights OFF",
      },
    ];
    const p = findPairs(together);
    assert.equal(p.length, 1, "the fixture for this case is not a pair");
    const s = cueSlugs(p, singleButtons(together, p));

    assert.equal(s.buttons.get("1:2:1"), "room_a_screens_house_lights_on");
    assert.equal(s.pairs.get("2:house_lights"), "room_a_lighting_house_lights");
  });

  test("a pair is NOT qualified by a single button whose name collides with neither half", () => {
    // `projectors` and `projectors_on`/`projectors_off` are three different cue
    // names. Counting bases rather than names would page-qualify the pair over
    // a button that never clashed with it.
    const together = [
      at(1, 0, 1)!,
      at(1, 0, 2)!,
      { ...at(1, 2, 3)!, label: "Projectors" },
    ];
    const p = findPairs(together);
    const s = cueSlugs(p, singleButtons(together, p));
    assert.equal(s.pairs.get("1:projectors"), "projectors");
    assert.equal(s.buttons.get("1:2:3"), "projectors");
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
    // page 2 drive malighting-msc, matched by the family wildcard. "Deck 1"
    // drives a HyperDeck — a recorder is setup gear in the same sense, started
    // before a service and stopped after. "Lobby: TVs" drives generic-tcp-udp
    // — something we cannot say is a projector — so it is offered unticked
    // rather than pre-armed, and so is the Panasonic camera's power pair.
    assert.deepEqual(suggested, ["1:Projectors", "2:Projectors", "2:Rig", "5:Deck 1"]);
  });

  test("no page name appears anywhere in the rule", () => {
    // The whole point of the heuristic: a Companion page name is one building's
    // furniture and must not be in this repository at all.
    for (const m of UTILITY_MODULES) assert.match(m, /^[a-z0-9-]+\*?$/);
  });

  test("a recorder pair is a utility pair", () => {
    assert.equal(isUtilityModule("bmd-hyperdeck"), true);
    assert.equal(isUtilityModule("magewell-ultrastream"), true);
    // Not every recording device: a camera is pointed at things during a
    // service, and a pre-ticked camera cue is one somebody can say by accident.
    assert.equal(isUtilityModule("red-rcp2"), false);
    assert.equal(isUtilityModule("panasonic-cameras"), false);
    assert.equal(isUtilityModule("obs-studio"), false);
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

describe("customVariableNames", () => {
  test("reads the KEYS of the export's custom_variables, sorted", () => {
    // EXACT. The fixture declares five and two of them are names Companion's own
    // value API could never answer for, so a list of five here is a dialog
    // offering a binding that reads 404 forever.
    assert.deepEqual(customVariableNames(EXPORT), ["house_lights_state", "lobby_tvs", "rig.state"]);
  });

  test("an export with no custom variables is an empty list, not an error", () => {
    // Some builds omit the `custom_variables` key entirely. Reading that as a
    // failure would make the import dialog unusable on an install that simply
    // has none. (This file used to claim the 5.0.3 export it was written
    // against had no such key; 5.0.3+9703's has one, an object of ten.)
    assert.deepEqual(customVariableNames({ version: 12, type: "full", pages: {} }), []);
    assert.deepEqual(customVariableNames({ custom_variables: {} }), []);
    assert.deepEqual(customVariableNames(null), []);
    assert.deepEqual(customVariableNames("nonsense"), []);
  });

  test("an array of named entries is read too", () => {
    assert.deepEqual(
      customVariableNames({ custom_variables: [{ name: "b_state" }, { name: "a_state" }, {}] }),
      ["a_state", "b_state"],
    );
  });

  test("the name rule is Companion's, and a path traversal is not a name", () => {
    assert.equal(isCompanionVariableName("projectors_state"), true);
    assert.equal(isCompanionVariableName("rig.state"), true);
    assert.equal(isCompanionVariableName("Room-A_2"), true);
    assert.equal(isCompanionVariableName("  padded  "), true);
    assert.equal(isCompanionVariableName(""), false);
    assert.equal(isCompanionVariableName("not a name"), false);
    assert.equal(isCompanionVariableName("state:projectors"), false);
    assert.equal(isCompanionVariableName("../../int/export/full"), false);
    assert.equal(isCompanionVariableName("a/b"), false);
    assert.equal(isCompanionVariableName("x".repeat(101)), false);
  });
});

describe("parseVariableRef", () => {
  test("a bare name stays a CUSTOM variable", () => {
    // Every binding written before module variables could be named is a bare
    // name, and each has to go on meaning exactly what it meant.
    assert.deepEqual(parseVariableRef("projectors_state"), { kind: "custom", name: "projectors_state" });
    assert.deepEqual(parseVariableRef("  rig.state "), { kind: "custom", name: "rig.state" });
  });

  test("`custom:` is the same thing said out loud", () => {
    assert.deepEqual(parseVariableRef("custom:projectors_state"), {
      kind: "custom",
      name: "projectors_state",
    });
    // Companion's own prefix is case-insensitive in an expression, so this is
    // too — and it wins over a connection somebody labelled "custom", because a
    // binding that changed meaning when a connection was renamed is worse than
    // one that cannot reach a connection nobody should have called that.
    assert.deepEqual(parseVariableRef("CUSTOM:projectors_state"), {
      kind: "custom",
      name: "projectors_state",
    });
  });

  test("`<label>:<name>` is a module variable", () => {
    assert.deepEqual(parseVariableRef("VCR-Overhead-Light:power_state"), {
      kind: "module",
      label: "VCR-Overhead-Light",
      name: "power_state",
    });
    assert.deepEqual(parseVariableRef("MA_Video_Mac_Mini_OBS:streaming"), {
      kind: "module",
      label: "MA_Video_Mac_Mini_OBS",
      name: "streaming",
    });
  });

  test("neither half may be something Companion could not have", () => {
    // Both land in a URL path.
    assert.equal(parseVariableRef("../../int:power_state"), null);
    assert.equal(parseVariableRef("VCR-Light:../../int/export/full"), null);
    // A dot is legal in a variable name and not in a connection label.
    assert.equal(parseVariableRef("VCR.Light:power_state"), null);
    assert.equal(parseVariableRef("a:b:c"), null);
    assert.equal(parseVariableRef(""), null);
    assert.equal(parseVariableRef("not a name"), null);
    assert.equal(isCompanionVariableRef("VCR-Overhead-Light:power_state"), true);
    assert.equal(isCompanionVariableRef("state:projectors"), true);
    assert.equal(isCompanionVariableRef("a/b"), false);
  });
});
