// What the Lyrics widget reads off the ProPresenter status that is not on a slide:
// the words on the first slide of the NEXT group, and the arrangement as a strip.
//
// Driven through buildStatus with a fixture in the shape ProPresenter answers
// `/v1/presentation/active` with — groups carrying slides, one arrangement listing
// group uuids with repeats, `current_arrangement` blank (it often is). No
// ProPresenter is dialled: buildStatus is the pure half of a refresh, and it is
// where `nextArrangementSection` is decided, so it is where `nextGroupText` must
// be decided too, from the same play order.
//
// The song: Intro (no words), Verse 1 (2 slides), Chorus (2), Verse 2 (1), then the
// chorus again, Bridge (1), the chorus a third time, and an Outro with no words.
// Play-order slide index: Intro 0 | V1 1-2 | C 3-4 | V2 5 | C 6-7 | B 8 | C 9-10 | Outro 11.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { propresenterService } from "./propresenter-service.js";
import type { ProPresenterStatusDTO } from "../types/live.js";

const colour = (red: number, green: number, blue: number) => ({ red, green, blue, alpha: 1 });
const group = (uuid: string, name: string, color: ReturnType<typeof colour>, texts: string[]) => ({
  uuid,
  name,
  color,
  slides: texts.map((text) => ({ text, notes: "" })),
});

const GROUPS = [
  group("g-intro", "Intro", colour(0.5, 0.5, 0.5), [""]),
  group("g-v1", "Verse 1", colour(0, 0, 1), ["v1 line a", "v1 line b"]),
  group("g-c", "Chorus", colour(1, 0, 0), ["chorus first", "chorus second"]),
  group("g-v2", "Verse 2", colour(0, 0, 1), ["v2 line a"]),
  group("g-b", "Bridge", colour(1, 0.5, 0), ["bridge line"]),
  group("g-outro", "Outro", colour(0.5, 0.5, 0.5), [""]),
];

const ARRANGEMENT = ["g-intro", "g-v1", "g-c", "g-v2", "g-c", "g-b", "g-c", "g-outro"];

const presentation = (arrangement: string[], extra: Record<string, unknown> = {}) => ({
  presentation: {
    id: { uuid: "p-1", name: "Example Song" },
    // Blank, as ProPresenter leaves it: the sole arrangement is the fallback.
    current_arrangement: "",
    arrangements: [{ id: { uuid: "a-1", name: "Default" }, groups: arrangement }],
    groups: GROUPS,
    ...extra,
  },
});

/** buildStatus is private; it is the refresh's whole decision and has no other door. */
function status(active: unknown, index: number | null): ProPresenterStatusDTO {
  const build = (propresenterService as unknown as {
    buildStatus: (...a: unknown[]) => ProPresenterStatusDTO;
  }).buildStatus.bind(propresenterService);
  const slideIndex = index == null ? null : { presentation_index: { index } };
  return build(active, { current: { text: "" }, next: { text: "" } }, slideIndex, { current: null, next: null }, null);
}

describe("nextGroupText", () => {
  const active = presentation(ARRANGEMENT);

  it("is the first slide of the next group, from an empty Intro", () => {
    const s = status(active, 0);
    assert.equal(s.currentSection?.name, "Intro");
    assert.equal(s.nextArrangementSection?.name, "Verse 1");
    assert.equal(s.nextGroupText, "v1 line a");
  });

  it("is the group's FIRST slide, even from the middle of the current group", () => {
    // The FIRST slide of Verse 1: the next slide is its second, not the next group.
    const s = status(active, 1);
    assert.equal(s.nextArrangementSection?.name, "Chorus");
    assert.equal(s.nextGroupText, "chorus first");
    assert.equal(status(active, 2).nextGroupText, "chorus first");
    // Likewise the first slide of the chorus: its next slide says "chorus second".
    assert.equal(status(active, 3).nextGroupText, "v2 line a");
  });

  it("follows the arrangement into a repeated chorus, and out of it", () => {
    // Verse 2 -> the chorus again.
    assert.equal(status(active, 5).nextGroupText, "chorus first");
    // The second slide of the second chorus -> the Bridge, not Verse 2 or the chorus.
    const s = status(active, 7);
    assert.equal(s.nextArrangementSection?.name, "Bridge");
    assert.equal(s.nextGroupText, "bridge line");
  });

  it("is an empty string for a group with no words, and null only when there is no next group", () => {
    const toOutro = status(active, 10);
    assert.equal(toOutro.nextArrangementSection?.name, "Outro");
    assert.equal(toOutro.nextGroupText, "");

    const last = status(active, 11);
    assert.equal(last.nextArrangementSection, null);
    assert.equal(last.nextGroupText, null);
  });

  it("is null when the slide position is not known", () => {
    const s = status(active, null);
    assert.equal(s.nextArrangementSection, null);
    assert.equal(s.nextGroupText, null);
  });
});

describe("the arrangement as a strip", () => {
  const active = presentation(ARRANGEMENT);

  it("lists each group where the arrangement plays it, repeats included, with its colour", () => {
    const { playOrderGroups } = status(active, 0);
    assert.deepEqual(
      playOrderGroups.map((g) => g.name),
      ["Intro", "Verse 1", "Chorus", "Verse 2", "Chorus", "Bridge", "Chorus", "Outro"],
    );
    assert.equal(playOrderGroups[2].colorHex, "#ff0000");
    assert.equal(playOrderGroups[0].colorHex, "#808080");
  });

  it("puts the current slide on ITS occurrence of a repeated group", () => {
    assert.equal(status(active, 0).playOrderGroupIndex, 0);
    assert.equal(status(active, 2).playOrderGroupIndex, 1, "the second slide of Verse 1 is still entry 1");
    assert.equal(status(active, 3).playOrderGroupIndex, 2, "the first chorus");
    assert.equal(status(active, 7).playOrderGroupIndex, 4, "the second chorus, not the first");
    assert.equal(status(active, 10).playOrderGroupIndex, 6, "the third chorus");
    assert.equal(status(active, 11).playOrderGroupIndex, 7);
  });

  it("keeps two choruses played back to back as two entries", () => {
    const twice = presentation(["g-v1", "g-c", "g-c", "g-v2"]);
    const s = status(twice, 4); // v1 0-1, chorus 2-3, chorus 4-5, v2 6
    assert.deepEqual(
      s.playOrderGroups.map((g) => g.name),
      ["Verse 1", "Chorus", "Chorus", "Verse 2"],
    );
    assert.equal(s.playOrderGroupIndex, 2);
    // The words are the next DIFFERENT group's, as nextArrangementSection is.
    assert.equal(s.nextArrangementSection?.name, "Verse 2");
    assert.equal(s.nextGroupText, "v2 line a");
  });

  it("is still listed, with no position, when the slide index is not known", () => {
    const s = status(active, null);
    assert.equal(s.playOrderGroups.length, 8);
    assert.equal(s.playOrderGroupIndex, null);
  });

  it("falls back to the library order when there is no arrangement", () => {
    const s = status(presentation([], { arrangements: [] }), 3); // Intro 0, V1 1-2, C 3-4
    assert.deepEqual(
      s.playOrderGroups.map((g) => g.name),
      ["Intro", "Verse 1", "Chorus", "Verse 2", "Bridge", "Outro"],
    );
    assert.equal(s.playOrderGroupIndex, 2);
    assert.equal(s.nextGroupText, "v2 line a");
  });

  it("is empty with nothing loaded", () => {
    const s = status(null, null);
    assert.deepEqual(s.playOrderGroups, []);
    assert.equal(s.playOrderGroupIndex, null);
    assert.equal(s.nextGroupText, null);
  });
});
