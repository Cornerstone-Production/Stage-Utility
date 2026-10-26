// The Lyrics settings: the approved defaults, the short tag text, and that the
// inspector's choices and the renderer's settings are one list.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { LAYOUT_OBJECTS } from "./layout-objects.js";
import { LYRICS_DEFAULTS, LYRICS_OPTIONS, lyricsSettings, shortGroupName, tagLabel } from "./lyrics-config.js";

describe("the short tag text", () => {
  const cases: [string, string][] = [
    ["Verse 1", "V1"],
    ["Verse 2", "V2"],
    ["Verse 12", "V12"],
    ["Verse", "V"],
    ["Chorus", "C"],
    ["Chorus 2", "C2"],
    ["Pre-Chorus", "PC"],
    ["Pre Chorus 2", "PC2"],
    ["Bridge", "B"],
    ["Bridge 2", "B2"],
    ["Tag", "T"],
    // Intro and Outro stay whole.
    ["Intro", "Intro"],
    ["Outro", "Outro"],
    ["intro", "intro"],
    // Anything else: the initials of several words, else the first letters; capped at 3.
    ["Instrumental", "INS"],
    ["Post Chorus", "PC"],
    ["Turn Around Section", "TAS"],
    ["Turn Around Section Again", "TAS"],
    ["Ending", "END"],
    // A trailing number is kept inside the cap, so numbered sections stay apart.
    ["Interlude 2", "IN2"],
    ["Interlude 12", "I12"],
    ["Instrumental 1", "IN1"],
    // Code points, not UTF-16 halves.
    ["Éclat", "ÉCL"],
    ["  Chorus  ", "C"],
    ["", ""],
  ];
  for (const [name, short] of cases) {
    test(`${JSON.stringify(name)} is ${JSON.stringify(short)}`, () => {
      assert.equal(shortGroupName(name), short);
    });
  }

  test("never rewrites the name: As named and CAPS use it as ProPresenter has it", () => {
    assert.equal(tagLabel("Verse 1", "named"), "Verse 1");
    assert.equal(tagLabel("Verse 1", "caps"), "VERSE 1");
    assert.equal(tagLabel("Verse 1", "short"), "V1");
  });
});

describe("the approved defaults", () => {
  // Spelled out here, not read from LYRICS_DEFAULTS, so changing a default is a
  // deliberate edit to two places. These are the mockup's constructor state.
  const APPROVED = {
    display: "above",
    tagStyle: "filled",
    tagColor: "propresenter",
    tagText: "named",
    tagWidth: "column",
    size: "l",
    weight: "bold",
    align: "left",
    noWords: "tag",
    under: true,
    underShows: "group",
    underWords: false,
    underDim: "light",
    showTitle: false,
  };

  test("a bare object reads as the approved default", () => {
    assert.deepEqual(lyricsSettings({ type: "lyrics" }), APPROVED);
  });

  test("a new object is created with all of them stated", () => {
    assert.deepEqual(LAYOUT_OBJECTS.lyrics.config(), { type: "lyrics", ...APPROVED });
    assert.deepEqual(LYRICS_DEFAULTS, APPROVED);
  });

  test("a stored value wins, and an unset or null one reads as the default", () => {
    const s = lyricsSettings({ type: "lyrics", display: "strip", under: false, size: undefined, weight: null as never });
    assert.equal(s.display, "strip");
    assert.equal(s.under, false);
    assert.equal(s.size, "l");
    assert.equal(s.weight, "bold");
  });

  test("every choice setting offers its default among its options", () => {
    for (const [key, options] of Object.entries(LYRICS_OPTIONS)) {
      const values = options.map((o) => o.value as string);
      assert.ok(values.includes((APPROVED as Record<string, unknown>)[key] as string), `${key} does not offer its default`);
    }
  });
});
