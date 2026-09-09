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
import { type PressEntry, reconcileCues } from "./companion-reconcile.js";

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

/** The one change a single-entry pass produced. */
function only(entries: PressEntry[], buttons: CompanionButton[]) {
  const r = reconcileCues(entries, buttons, NOW);
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
});

describe("a button that runs nothing", () => {
  // 59 of the 536 buttons on the install this was built against. They have no
  // identity but their coordinates, and pretending otherwise is worse than
  // saying so.
  const blank = (over: Record<string, string | number> = {}): PressEntry => ({
    ruleId: "rule-blank",
    label: "cam_1",
    params: {
      ...fingerprintParams(
        { page: 3, row: 0, col: 0, pageId: FIXTURE_PAGE_IDS[3]!, label: "Cam 1", actionIds: [] },
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
    const d = doc();
    delete d.pages["3"]!.controls["0"]!["0"];
    const r = only([blank()], parse(d));
    assert.equal(r.changes[0]!.status, "missing");
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
    const r = reconcileCues([entry(), { ...off, ruleId: "rule-2" }], buttons, NOW);
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
