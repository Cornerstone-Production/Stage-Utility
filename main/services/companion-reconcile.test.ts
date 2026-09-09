// Following a Companion button that somebody moved.
//
// Every case runs the real pure pass over a document built from the real 5.0.3
// shapes (see fixtures/companion-export.ts), mutated the way Companion itself
// would mutate it — the CONTROL OBJECT is moved, so its action ids travel with
// it, which is the whole reason they are the identity.
//
// What is guarded, and why each one is a bug rather than a nicety:
//
//  - MISSING REFUSES. It does not fall back to the coordinates, and ambiguity is
//    missing too. Companion answers 204 for an empty coordinate and a cheerful
//    200 for the wrong button, so a cue that guesses is a cue that presses
//    somebody else's projector with nothing anywhere saying so.
//  - AN UNREADABLE COMPANION CHANGES NOTHING. A pass that downgraded every cue
//    to `missing` because a switch was rebooting would refuse every cue in the
//    building until somebody noticed.
//  - A LEGACY RULE IS ADOPTED, not refused. Every cue on an upgrading install has
//    no fingerprint, and refusing those would break a working box on update.
//  - A PAGE RENUMBER IS NOT A MOVE. Inserting a page ahead of another shifts
//    every number after it; treating that as a move would rewrite coordinates
//    that were right, and treating it as missing would refuse the lot.
//  - AN UNCHANGED PASS WRITES NOTHING. `lastSeenAt` refreshed every hour is a
//    rules-file save every hour and a permanent "updated just now" under an
//    amber pill that has not moved in a week.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parseButtons, type CompanionButton } from "./companion-export.js";
import {
  companionExportFixture,
  FIXTURE_PAGES,
  FIXTURE_PAGE_IDS,
  fixtureActionId,
} from "./fixtures/companion-export.js";
import { fingerprintParams, readFingerprint } from "./companion-fingerprint.js";
import { type CueIdentity, type PressEntry, reconcileCues } from "./companion-reconcile.js";

const NOW = "2026-09-09T14:00:00.000Z";
const EARLIER = "2026-09-01T09:00:00.000Z";

/** The export document, as a shape a test can move things around in. */
interface Doc {
  pages: Record<string, { id: string; name: string; controls: Record<string, Record<string, unknown>> }>;
}

const doc = (): Doc => companionExportFixture() as unknown as Doc;

/** The buttons of a document, parsed exactly as the server does. */
const parse = (d: Doc): CompanionButton[] => parseButtons(d);

/** Move a control to another key on the same page, carrying its action ids. */
function move(d: Doc, page: string, from: [number, number], to: [number, number]): void {
  const controls = d.pages[page]!.controls;
  const control = controls[String(from[0])]![String(from[1])];
  delete controls[String(from[0])]![String(from[1])];
  controls[String(to[0])] = { ...(controls[String(to[0])] ?? {}), [String(to[1])]: control };
}

/** A second control on the page with the SAME actions — a duplicated button. */
function duplicate(d: Doc, page: string, from: [number, number], to: [number, number]): void {
  const controls = d.pages[page]!.controls;
  const control = controls[String(from[0])]![String(from[1])];
  controls[String(to[0])] = { ...(controls[String(to[0])] ?? {}), [String(to[1])]: control };
}

/** One press action to reconcile, fingerprinted as the picker would have. */
function entry(over: Record<string, string | number> = {}, label = "projectors_on"): PressEntry {
  return {
    ruleId: "rule-1",
    label,
    params: {
      ...fingerprintParams(
        {
          page: 1,
          row: 0,
          col: 1,
          pageId: FIXTURE_PAGE_IDS[1]!,
          label: "Projectors ON",
          actionIds: [fixtureActionId(1, 0, 1, 0)],
        },
        "in-place",
        EARLIER,
      ),
      ...over,
    },
  };
}

/** The one change a single-entry pass produced.
 *
 *  NO cue identities: these cases are about following a button, and a press
 *  action whose rule is not a cue — or whose cue this pass was not told about —
 *  is never renamed. The rename cases pass their own, below. */
function only(entries: PressEntry[], buttons: CompanionButton[], cues: CueIdentity[] = []) {
  const r = reconcileCues(entries, buttons, NOW, cues);
  assert.equal(r.changes.length, entries.length);
  return r;
}

/** The merged params a change would persist. */
function merged(e: PressEntry, patch: Record<string, string | number> | null) {
  return readFingerprint({ ...e.params, ...(patch ?? {}) });
}

describe("a button that has not moved", () => {
  test("is in place, and nothing is written", () => {
    const e = entry();
    const r = only([e], parse(doc()));
    assert.equal(r.changes[0]!.status, "in-place");
    // The whole point of comparing fingerprints rather than params: an hourly
    // pass that rewrote `lastSeenAt` would save the rules file every hour.
    assert.equal(r.changes[0]!.patch, null);
    assert.equal(r.changes[0]!.log, null);
    assert.deepEqual(r.counts, { "in-place": 1, moved: 0, missing: 0 });
    assert.equal(r.checked, 1);
  });

  test("its label is refreshed when somebody renames it in Companion", () => {
    const d = doc();
    const layers = (d.pages["1"]!.controls["0"]!["1"] as { style: { layers: { type: string; text?: { value: string } }[] } })
      .style.layers;
    layers[layers.length - 1]!.text = { value: "Projectors POWER" };

    const e = entry();
    const r = only([e], parse(d));
    assert.equal(r.changes[0]!.status, "in-place");
    assert.equal(merged(e, r.changes[0]!.patch).label, "Projectors POWER");
    // A rename is not something to shout about — the pill still reads "in place".
    assert.equal(r.changes[0]!.log, null);
  });
});

describe("a button somebody moved", () => {
  test("is followed within its page, and the new coordinates are recorded", () => {
    const d = doc();
    move(d, "1", [0, 1], [3, 5]);

    const e = entry();
    const r = only([e], parse(d));
    const change = r.changes[0]!;
    assert.equal(change.status, "moved");
    const after = merged(e, change.patch);
    assert.equal(after.row, 3);
    assert.equal(after.col, 5);
    assert.equal(after.page, 1);
    // Where it WAS survives, because that is what the amber pill reads out.
    assert.deepEqual(after.movedFrom, { page: 1, row: 0, col: 1 });
    assert.equal(after.lastSeenAt, NOW);
    assert.equal(change.log, "[companion] cue projectors_on: button moved p1 r0c1 -> p1 r3c5");
    assert.deepEqual(r.counts, { "in-place": 0, moved: 1, missing: 0 });
  });

  test("stays amber on the next pass, and writes nothing more", () => {
    // The pass after a move finds the button exactly where it now says it is. A
    // plain "in-place" here would clear the amber pill within the hour, and
    // telling an operator that a button they did not think had moved HAS is the
    // only thing the pill is for.
    const d = doc();
    move(d, "1", [0, 1], [3, 5]);
    const buttons = parse(d);

    const first = only([entry()], buttons);
    const settled: PressEntry = {
      ruleId: "rule-1",
      label: "projectors_on",
      params: { ...entry().params, ...first.changes[0]!.patch! },
    };
    const second = only([settled], buttons);
    assert.equal(second.changes[0]!.status, "moved");
    assert.equal(second.changes[0]!.patch, null, "an unchanged pass saved the rules file again");
    assert.equal(second.changes[0]!.log, null);
    assert.deepEqual(readFingerprint(settled.params).movedFrom, { page: 1, row: 0, col: 1 });
  });

  test("re-picking the button in the editor is what clears the amber", () => {
    // The picker writes `in-place` with no `movedFrom`, which is the operator
    // saying they have seen it. Nothing else clears it, deliberately.
    const d = doc();
    move(d, "1", [0, 1], [3, 5]);
    const repicked: PressEntry = {
      ruleId: "rule-1",
      label: "projectors_on",
      params: fingerprintParams(
        {
          page: 1,
          row: 3,
          col: 5,
          pageId: FIXTURE_PAGE_IDS[1]!,
          label: "Projectors ON",
          actionIds: [fixtureActionId(1, 0, 1, 0)],
        },
        "in-place",
        NOW,
      ),
    };
    const r = only([repicked], parse(d));
    assert.equal(r.changes[0]!.status, "in-place");
    assert.equal(r.changes[0]!.patch, null);
  });

  test("moving it a second time reports the move from where it last was", () => {
    const d = doc();
    move(d, "1", [0, 1], [3, 5]);
    const first = only([entry()], parse(d));
    const settled: PressEntry = {
      ruleId: "rule-1",
      label: "projectors_on",
      params: { ...entry().params, ...first.changes[0]!.patch! },
    };
    move(d, "1", [3, 5], [4, 6]);
    const second = only([settled], parse(d));
    assert.equal(second.changes[0]!.log, "[companion] cue projectors_on: button moved p1 r3c5 -> p1 r4c6");
    assert.deepEqual(merged(settled, second.changes[0]!.patch).movedFrom, { page: 1, row: 3, col: 5 });
  });
});

describe("a button that cannot be identified", () => {
  test("two buttons on the page carrying its actions is MISSING, not a guess", () => {
    // A Companion somebody duplicated. Picking between them is a coin toss on
    // real gear, and the wrong one is a projector in another room.
    const d = doc();
    duplicate(d, "1", [0, 1], [3, 5]);
    move(d, "1", [0, 1], [4, 5]);

    const e = entry();
    const r = only([e], parse(d));
    assert.equal(r.changes[0]!.status, "missing");
    assert.equal(
      r.changes[0]!.log,
      "[companion] cue projectors_on: 2 buttons on page 1 (Room A: Screens) carry its actions — refusing to guess",
    );
  });

  test("deleted from the page is missing, named with the page it was on", () => {
    const d = doc();
    delete d.pages["1"]!.controls["0"]!["1"];

    const e = entry();
    const r = only([e], parse(d));
    assert.equal(r.changes[0]!.status, "missing");
    assert.equal(
      r.changes[0]!.log,
      "[companion] cue projectors_on: button not found on page 1 (Room A: Screens)",
    );
    // The identity is KEPT. It is what matches when somebody puts the button
    // back, and what an operator reads to go and find it.
    const after = merged(e, r.changes[0]!.patch);
    assert.deepEqual(after.actionIds, [fixtureActionId(1, 0, 1, 0)]);
    assert.equal(after.movedFrom, null, "a missing button has nowhere it moved to");
  });

  test("the whole page deleted is missing, and says the page is gone", () => {
    const d = doc();
    delete d.pages["1"];

    const r = only([entry()], parse(d));
    assert.equal(r.changes[0]!.status, "missing");
    assert.equal(
      r.changes[0]!.log,
      "[companion] cue projectors_on: button not found on page 1 (no such page)",
    );
  });

  test("moved to ANOTHER page is missing — the search is within a page, on purpose", () => {
    // "Conf TVs ON" exists on two auditoriums' pages driving different
    // televisions. A cross-page search would happily adopt the other room's.
    const d = doc();
    const control = d.pages["1"]!.controls["0"]!["1"];
    delete d.pages["1"]!.controls["0"]!["1"];
    d.pages["2"]!.controls["4"] = { "4": control };

    const r = only([entry()], parse(d));
    assert.equal(r.changes[0]!.status, "missing");
  });
});

describe("a page that was renumbered", () => {
  test("resolves by its id, updates the number, and stays in place", () => {
    // Inserting a page ahead of another shifts every number after it. Treating
    // that as a move would rewrite coordinates that were right; treating it as
    // missing would refuse every cue on every page after the new one.
    const d = doc();
    const one = d.pages["1"]!;
    delete d.pages["1"];
    d.pages["9"] = one;

    const e = entry();
    const r = only([e], parse(d));
    const change = r.changes[0]!;
    assert.equal(change.status, "in-place");
    const after = merged(e, change.patch);
    assert.equal(after.page, 9, "the press would still go to page 1");
    assert.equal(after.row, 0);
    assert.equal(after.col, 1);
    assert.equal(change.log, "[companion] cue projectors_on: page renumbered 1 -> 9");
  });

  test("and a button moved on a renumbered page is both", () => {
    const d = doc();
    const one = d.pages["1"]!;
    delete d.pages["1"];
    d.pages["9"] = one;
    move(d, "9", [0, 1], [3, 5]);

    const e = entry();
    const r = only([e], parse(d));
    assert.equal(r.changes[0]!.status, "moved");
    const after = merged(e, r.changes[0]!.patch);
    assert.deepEqual([after.page, after.row, after.col], [9, 3, 5]);
    assert.equal(r.changes[0]!.log, "[companion] cue projectors_on: button moved p1 r0c1 -> p9 r3c5");
  });
});

describe("a rule from before the fingerprint existed", () => {
  const legacy = (over: Record<string, string | number> = {}): PressEntry => ({
    ruleId: "rule-legacy",
    label: "projectors_on",
    // Exactly what the old import and the old picker wrote: three coordinates
    // and a label, and nothing else.
    params: { page: 1, row: 0, col: 1, label: "Projectors ON", ...over },
  });

  test("is adopted at its own coordinates, with the fingerprint recorded", () => {
    const e = legacy();
    assert.equal(readFingerprint(e.params).status, null, "the fixture is not actually a legacy rule");

    const r = only([e], parse(doc()));
    const change = r.changes[0]!;
    assert.equal(change.status, "in-place");
    const after = merged(e, change.patch);
    assert.equal(after.pageId, FIXTURE_PAGE_IDS[1]);
    assert.deepEqual(after.actionIds, [fixtureActionId(1, 0, 1, 0)]);
    assert.equal(after.lastSeenAt, NOW);
    assert.equal(
      change.log,
      '[companion] cue projectors_on: adopted the button at p1 r0c1 ("Projectors ON")',
    );
  });

  test("adopts whatever is at its coordinates NOW, which is the honest answer", () => {
    // There is nothing to compare against, so this cannot tell a button that
    // never moved from one that was replaced. Adoption is still right: the cue
    // has always pressed that coordinate, and refusing it on an upgrade would
    // break a working box.
    const e = legacy({ row: 0, col: 2 });
    const r = only([e], parse(doc()));
    assert.equal(merged(e, r.changes[0]!.patch).label, "Projectors OFF");
  });

  test("with nothing at its coordinates it is missing, not adopted", () => {
    const e = legacy({ row: 6, col: 6 });
    const r = only([e], parse(doc()));
    assert.equal(r.changes[0]!.status, "missing");
  });

  test("a MISSING cue rescued by hand-typed coordinates is adopted, not refused again", () => {
    // The other half of the escape hatch. Typing a coordinate in the editor
    // clears the identity that no longer describes anything — see
    // typedCoordinate in renderer/settings/sections/companion-cues.tsx — which
    // leaves exactly the shape a legacy rule has, and this is the pass that has
    // to adopt it. Without the clearing the stored `status: "missing"` survives
    // and companion.press goes on refusing with the right coordinates typed in.
    const e: PressEntry = {
      ruleId: "rule-rescued",
      label: "projectors_on",
      params: {
        ...entry().params,
        // What the Row field emits: the coordinate, and "" for the identity.
        row: 0,
        col: 2,
        pageId: "",
        actionIds: "",
        status: "",
        movedFrom: "",
        label: "",
      },
    };
    const r = only([e], parse(doc()));
    const change = r.changes[0]!;
    assert.equal(change.status, "in-place");
    const after = merged(e, change.patch);
    assert.equal(after.pageId, FIXTURE_PAGE_IDS[1]);
    assert.deepEqual(after.actionIds, [fixtureActionId(1, 0, 2, 0)]);
    // And the row now names the button that is actually there.
    assert.equal(after.label, "Projectors OFF");
  });
});

describe("a button that runs nothing", () => {
  // 59 of the 536 buttons on the install this was built against. They have no
  // identity but their coordinates, and pretending otherwise is worse than
  // saying so.
  const blank = (
    over: Record<string, string | number> = {},
    row = 0,
    col = 0,
  ): PressEntry => ({
    ruleId: `rule-blank-${row}-${col}`,
    label: `cam_${row + 1}`,
    params: {
      ...fingerprintParams(
        {
          page: 3,
          row,
          col,
          pageId: FIXTURE_PAGE_IDS[3]!,
          label: `Cam ${row + 1}`,
          actionIds: [],
        },
        "in-place",
        EARLIER,
      ),
      ...over,
    },
  });

  test("is in place while something is at its coordinates", () => {
    const r = only([blank()], parse(doc()));
    assert.equal(r.changes[0]!.status, "in-place");
    assert.equal(r.changes[0]!.patch, null);
  });

  test("is missing when its coordinates empty, and is never SEARCHED for", () => {
    // An empty fingerprint matches every other actionless button, so a search
    // would find several and could never find one. It must not be attempted.
    //
    // Page 3 carries TWO actionless buttons for this case. With one, deleting
    // the `wanted === ""` branch left the search finding nothing and answering
    // "missing" anyway — the guard was green on the bug. With two, removing the
    // branch finds Cam 2 and reports the cue MOVED onto a camera button it has
    // never been near.
    const d = doc();
    delete d.pages["3"]!.controls["0"]!["0"];
    const r = only([blank()], parse(d));
    assert.equal(r.changes[0]!.status, "missing");
    assert.equal(r.changes[0]!.patch?.status, "missing");
    // And nothing about where it is was rewritten to somebody else's key.
    assert.equal(merged(blank(), r.changes[0]!.patch).row, 0);
    assert.equal(merged(blank(), r.changes[0]!.patch).col, 0);
  });
});

describe("what is not looked at", () => {
  test("a press action with no button chosen is skipped entirely", () => {
    // The action's own three fields are blank. There is nothing to reconcile and
    // nothing to refuse, and a `missing` pill on it would be a lie.
    const r = reconcileCues(
      [{ ruleId: "r", label: "unset", params: { label: "" } }],
      parse(doc()),
      NOW,
      [],
    );
    assert.deepEqual(r.changes, []);
    assert.equal(r.checked, 0);
  });

  test("several entries are each decided on their own", () => {
    const d = doc();
    move(d, "1", [0, 1], [3, 5]);
    delete d.pages["1"]!.controls["0"]!["2"];
    const buttons = parse(d);

    const off = entry(
      fingerprintParams(
        {
          page: 1,
          row: 0,
          col: 2,
          pageId: FIXTURE_PAGE_IDS[1]!,
          label: "Projectors OFF",
          actionIds: [fixtureActionId(1, 0, 2, 0)],
        },
        "in-place",
        EARLIER,
      ),
      "projectors_off",
    );
    const r = reconcileCues([entry(), { ...off, ruleId: "rule-2" }], buttons, NOW, []);
    assert.deepEqual(
      r.changes.map((c) => `${c.label}=${c.status}`),
      ["projectors_on=moved", "projectors_off=missing"],
    );
    assert.deepEqual(r.counts, { "in-place": 0, moved: 1, missing: 1 });
  });

  test("the fixture's own page names are what the log lines say", () => {
    // Guards the two log lines above against a fixture rename making them
    // meaningless while still matching.
    assert.equal(FIXTURE_PAGES.screens, "Room A: Screens");
  });
});

// ── A button somebody RENAMED ────────────────────────────────────────────────
//
// The cue name is the URL Home Assistant calls (`rest_command.su_<name>`), and
// the HomeKit switch a household asks for was created from that command. So the
// rename has to be conservative in three directions at once, and each of these
// is a bug rather than a nicety:
//
//  - A CUE SOMEBODY NAMED BY HAND IS NEVER RENAMED. A Companion label is not
//    authority over a name an operator typed.
//  - A COLLISION KEEPS THE NAME. Renaming onto a name — or a FORMER name — that
//    another cue holds would silently move somebody else's switch onto this
//    button. Including a name claimed by another rename in the same pass.
//  - A PAIR RENAMES TOGETHER OR NOT AT ALL. Renaming one half leaves a Home
//    Assistant switch with no off, which is worse than one under the old name.
//
// And the old name keeps answering, as an alias, or the switch breaks the moment
// the button is relabelled rather than when somebody re-pastes the config.

describe("a button somebody renamed", () => {
  /** Replace the text of the control at these coordinates. */
  function relabel(d: Doc, page: string, at: [number, number], text: string): void {
    const control = d.pages[page]!.controls[String(at[0])]![String(at[1])] as {
      style: { layers: { type: string; text?: { value: string } }[] };
    };
    const layers = control.style.layers;
    layers[layers.length - 1]!.text = { value: text };
  }

  /** The parsed button at these coordinates. */
  const at = (buttons: CompanionButton[], page: number, row: number, col: number): CompanionButton =>
    buttons.find((b) => b.page === page && b.row === row && b.col === col)!;

  /** A press action fingerprinted against a button as the import found it. */
  const press = (button: CompanionButton, ruleId: string, cueName: string): PressEntry => ({
    ruleId,
    label: cueName,
    params: fingerprintParams(button, "in-place", EARLIER),
  });

  const cue = (ruleId: string, name: string, aliases: string[] = [], says = ""): CueIdentity => ({
    ruleId,
    name,
    aliases,
    says,
  });

  /** The pristine export, and the same export with one button relabelled. */
  function relabelled(page: string, spot: [number, number], text: string) {
    const before = parse(doc());
    const d = doc();
    relabel(d, page, spot, text);
    return { before, after: parse(d), doc: d };
  }

  test("renames the cue, keeps the old name answering, and follows `says`", () => {
    const { before, after } = relabelled("1", [2, 3], "Take Stage");
    const e = press(at(before, 1, 2, 3), "rule-1", "take_screens");
    const r = only([e], after, [cue("rule-1", "take_screens", [], "Take Screens")]);

    const change = r.changes[0]!;
    assert.equal(change.status, "in-place");
    assert.deepEqual(change.triggerPatch, {
      name: "take_stage",
      aliases: "take_screens",
      says: "Take Stage",
    });
    assert.equal(
      change.renameLog,
      "[companion] cue take_screens renamed to take_stage after its button's label changed; " +
        "take_screens still answers",
    );
    // And the label is refreshed on the action, as it always was.
    assert.equal(merged(e, change.patch).label, "Take Stage");
  });

  test("leaves `says` alone when it is not the label — somebody typed that", () => {
    const { before, after } = relabelled("1", [2, 3], "Take Stage");
    const e = press(at(before, 1, 2, 3), "rule-1", "take_screens");
    const r = only([e], after, [cue("rule-1", "take_screens", [], "the big screens")]);
    assert.deepEqual(r.changes[0]!.triggerPatch, { name: "take_stage", aliases: "take_screens" });
  });

  test("A HAND-NAMED CUE IS NOT RENAMED, and its label is still refreshed", () => {
    const { before, after } = relabelled("1", [2, 3], "Take Stage");
    const e = press(at(before, 1, 2, 3), "rule-1", "screens_please");
    const r = only([e], after, [cue("rule-1", "screens_please", [], "Take Screens")]);

    assert.equal(r.changes[0]!.triggerPatch, null, "a name the operator typed was overwritten");
    assert.equal(r.changes[0]!.renameLog, null);
    assert.equal(merged(e, r.changes[0]!.patch).label, "Take Stage");
  });

  test("the page-qualified name counts as named after the button", () => {
    // The import prefixes the page name when a label appears on two pages, so
    // `room_a_screens_projectors_on` is auto-named and must rename like any
    // other. Reading only the plain slug would treat every disambiguated cue as
    // hand-named — which is every cue on a real install with two auditoriums.
    const before = parse(doc());
    const d = doc();
    relabel(d, "1", [0, 1], "Screens ON");
    relabel(d, "1", [0, 2], "Screens OFF");
    const after = parse(d);

    const on = press(at(before, 1, 0, 1), "rule-on", "room_a_screens_projectors_on");
    const off = press(at(before, 1, 0, 2), "rule-off", "room_a_screens_projectors_off");
    const r = reconcileCues([on, off], after, NOW, [
      cue("rule-on", "room_a_screens_projectors_on"),
      cue("rule-off", "room_a_screens_projectors_off"),
    ]);

    assert.deepEqual(
      r.changes.map((c) => String(c.triggerPatch?.name ?? "")),
      ["screens_on", "screens_off"],
      "a pair did not rename together",
    );
    assert.deepEqual(
      r.changes.map((c) => String(c.triggerPatch?.aliases ?? "")),
      ["room_a_screens_projectors_on", "room_a_screens_projectors_off"],
    );
  });

  test("ONE HALF of a pair relabelled renames NEITHER, and says so once", () => {
    // The switch in Home Assistant is the two names together. Renaming the ON
    // half alone leaves a switch with no off.
    const before = parse(doc());
    const d = doc();
    relabel(d, "1", [0, 1], "Screens ON");
    const after = parse(d);

    const on = press(at(before, 1, 0, 1), "rule-on", "room_a_screens_projectors_on");
    const off = press(at(before, 1, 0, 2), "rule-off", "room_a_screens_projectors_off");
    const r = reconcileCues([on, off], after, NOW, [
      cue("rule-on", "room_a_screens_projectors_on"),
      cue("rule-off", "room_a_screens_projectors_off"),
    ]);

    assert.deepEqual(r.changes.map((c) => c.triggerPatch), [null, null]);
    assert.deepEqual(
      r.changes.map((c) => c.renameLog).filter((l) => l !== null),
      [
        '[companion] cue room_a_screens_projectors_on: label changed to "Screens ON" but its ' +
          "OFF half room_a_screens_projectors_off was not relabelled; both names kept",
      ],
      "a pair refusal must be one line, not two",
    );
  });

  test("a pair whose halves stop being a pair renames neither", () => {
    // Relabelled to words with no ON/OFF between them: the two buttons are two
    // single cues now, and renaming them would dissolve the switch silently.
    const before = parse(doc());
    const d = doc();
    relabel(d, "1", [0, 1], "Screens Up");
    relabel(d, "1", [0, 2], "Screens Down");
    const after = parse(d);

    const on = press(at(before, 1, 0, 1), "rule-on", "room_a_screens_projectors_on");
    const off = press(at(before, 1, 0, 2), "rule-off", "room_a_screens_projectors_off");
    const r = reconcileCues([on, off], after, NOW, [
      cue("rule-on", "room_a_screens_projectors_on"),
      cue("rule-off", "room_a_screens_projectors_off"),
    ]);

    assert.deepEqual(r.changes.map((c) => c.triggerPatch), [null, null]);
    assert.deepEqual(
      r.changes.map((c) => c.renameLog).filter((l) => l !== null),
      [
        '[companion] cue room_a_screens_projectors_on: label changed to "Screens Up" but ' +
          "screens_up and screens_down are no longer an ON/OFF pair; both names kept",
      ],
    );
  });

  test("A NAME ANOTHER CUE HOLDS keeps this one's name, and logs why", () => {
    const { before, after } = relabelled("1", [2, 3], "Lobby TVs");
    const e = press(at(before, 1, 2, 3), "rule-1", "take_screens");
    const r = only([e], after, [
      cue("rule-1", "take_screens"),
      // Any other cue, press action or not. This one is the reason the whole
      // engine's namespace is passed in rather than just the press rules.
      cue("rule-other", "lobby_tvs"),
    ]);

    assert.equal(r.changes[0]!.triggerPatch, null);
    assert.equal(
      r.changes[0]!.renameLog,
      '[companion] cue take_screens: label changed to "Lobby TVs" but lobby_tvs is taken; name kept',
    );
  });

  test("A FORMER name another cue holds blocks it too", () => {
    // A former name is a live URL. Taking it would move an already pasted
    // switch onto this button.
    const { before, after } = relabelled("1", [2, 3], "Lobby TVs");
    const e = press(at(before, 1, 2, 3), "rule-1", "take_screens");
    const r = only([e], after, [
      cue("rule-1", "take_screens"),
      cue("rule-other", "atrium_tvs", ["lobby_tvs"]),
    ]);
    assert.equal(r.changes[0]!.triggerPatch, null);
    assert.match(r.changes[0]!.renameLog ?? "", /lobby_tvs is taken/);
  });

  test("two buttons relabelled to the SAME words rename only the first", () => {
    // Both land on one name. The second rename would be refused by the engine
    // anyway; deciding it here means it is refused with a sentence instead of an
    // exception.
    const before = parse(doc());
    const d = doc();
    relabel(d, "1", [2, 3], "Record Cam");
    relabel(d, "1", [2, 1], "Record Cam");
    const after = parse(d);

    const first = press(at(before, 1, 2, 3), "rule-1", "take_screens");
    const second = press(at(before, 1, 2, 1), "rule-2", "house_lights_on");
    const r = reconcileCues([first, second], after, NOW, [
      cue("rule-1", "take_screens"),
      cue("rule-2", "house_lights_on"),
    ]);

    const names = r.changes.map((c) => String(c.triggerPatch?.name ?? ""));
    assert.deepEqual(names, ["room_a_screens_record_cam", ""]);
    assert.match(r.changes[1]!.renameLog ?? "", /room_a_screens_record_cam is taken; name kept/);
  });

  test("a MISSING button never renames anything", () => {
    // Its label is whatever it said the last time anybody could see it, and a
    // rename off a stale label is a name from nowhere.
    const d = doc();
    delete d.pages["1"]!.controls["2"]!["3"];
    const before = parse(doc());
    const e = press(at(before, 1, 2, 3), "rule-1", "take_screens");
    const r = only([e], parse(d), [cue("rule-1", "take_screens")]);

    assert.equal(r.changes[0]!.status, "missing");
    assert.equal(r.changes[0]!.triggerPatch, null);
    assert.equal(r.changes[0]!.renameLog, null);
  });

  test("a rule the pass has never reconciled is adopted, not renamed", () => {
    // `status: null` is every cue on an upgrading install. A differing label
    // there means "this may be a different button", not "somebody renamed it" —
    // the pass adopts whatever is at the coordinates, so renaming off that would
    // name the cue after a button it may never have pressed.
    //
    // The old label is "Take Stage" and the button at those coordinates now says
    // "Take Screens", so a pass that read this as a relabel WOULD rename it:
    // `take_stage` is exactly the name the import would have given the old
    // label, and `take_screens` is a free name. Only the never-reconciled check
    // stops it.
    const legacy: PressEntry = {
      ruleId: "rule-1",
      label: "take_stage",
      params: { page: 1, row: 2, col: 3, label: "Take Stage" },
    };
    const r = only([legacy], parse(doc()), [cue("rule-1", "take_stage")]);
    assert.equal(r.changes[0]!.status, "in-place");
    assert.equal(r.changes[0]!.triggerPatch, null);
  });

  test("a second rename keeps BOTH former names, and five is the cap", () => {
    const { before, after } = relabelled("1", [2, 3], "Take Stage");
    const once = only([press(at(before, 1, 2, 3), "rule-1", "take_screens")], after, [
      cue("rule-1", "take_screens"),
    ]);
    assert.equal(once.changes[0]!.triggerPatch!.aliases, "take_screens");

    // Renamed again, now carrying the first former name.
    const second = relabelled("1", [2, 3], "Take Lobby");
    const settled: PressEntry = {
      ruleId: "rule-1",
      label: "take_stage",
      params: { ...press(at(second.before, 1, 2, 3), "rule-1", "take_stage").params, label: "Take Stage" },
    };
    const twice = only([settled], second.after, [cue("rule-1", "take_stage", ["take_screens"])]);
    assert.equal(twice.changes[0]!.triggerPatch!.aliases, "take_screens,take_stage");

    // Six deep, the oldest falls off: every former name is a live URL, and one
    // per relabel forever is unbounded growth.
    const capped = only([settled], second.after, [
      cue("rule-1", "take_stage", ["a1", "a2", "a3", "a4", "a5"]),
    ]);
    assert.equal(capped.changes[0]!.triggerPatch!.aliases, "a2,a3,a4,a5,take_stage");
  });

  test("a relabel with nothing else changed still writes the rename", () => {
    // The fingerprint compare is what decides whether anything is saved, and a
    // label is part of it — but the rename must not depend on that: it is a
    // change to the TRIGGER, and nothing about the button's coordinates moved.
    const { before, after } = relabelled("1", [2, 3], "Take Stage");
    const e = press(at(before, 1, 2, 3), "rule-1", "take_screens");
    const r = only([e], after, [cue("rule-1", "take_screens")]);
    assert.equal(r.changes[0]!.status, "in-place");
    assert.notEqual(r.changes[0]!.patch, null, "the label refresh is what makes this saveable");
    assert.equal(String(r.changes[0]!.triggerPatch?.name), "take_stage");
  });
});
