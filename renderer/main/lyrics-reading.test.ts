// What a Lyrics object says, from the status alone: its four states, the rows it
// draws, and the strip. No React — see lyrics-render.test.tsx for what each of
// those looks like once drawn.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import type { LyricsConfig } from "./lyrics-config.js";
import { readLyrics, type LyricsReading } from "./lyrics-reading.js";
import { GROUPS, WORDS, atIntro, atOutro, lyricsStatus } from "../test-fixtures/lyrics-status.js";

const cfg = (over: Partial<LyricsConfig> = {}): LyricsConfig => ({ type: "lyrics", ...over });

function slide(r: LyricsReading) {
  assert.equal(r.kind, "slide", `expected a slide, got ${r.kind}`);
  return r as Extract<LyricsReading, { kind: "slide" }>;
}

describe("the four states", () => {
  test("not yet answered is loading, whatever the status holds", () => {
    assert.equal(readLyrics(cfg(), { pro: null, known: false }).kind, "loading");
    // A status that is there but not yet known to be current is still not a claim.
    assert.equal(readLyrics(cfg(), { pro: lyricsStatus(), known: false }).kind, "loading");
  });

  test("answered and not connected is none", () => {
    assert.equal(readLyrics(cfg(), { pro: null, known: true }).kind, "none");
    assert.equal(readLyrics(cfg(), { pro: lyricsStatus({ connected: false }), known: true }).kind, "none");
  });

  test("connected with no presentation is none, and a media slide is not that", () => {
    const empty = lyricsStatus({ currentItem: null, currentSlideText: null, currentSection: null });
    assert.equal(readLyrics(cfg(), { pro: empty, known: true }).kind, "none");
    // A media slide: no words and no group, but a presentation is open.
    const media = lyricsStatus({ currentSlideText: null, currentSection: null });
    assert.equal(readLyrics(cfg({ under: false }), { pro: media, known: true }).kind, "slide");
  });

  test("a status that has moved on holds nothing of the one before", () => {
    // Pure: the same config read over two statuses says two different things, and
    // the second carries no word of the first.
    const first = slide(readLyrics(cfg(), { pro: lyricsStatus(), known: true }));
    assert.equal(first.rows[0].words, WORDS.chorusFirst);
    const gone = readLyrics(cfg(), { pro: lyricsStatus({ connected: false }), known: true });
    assert.equal(gone.kind, "none");
    const next = slide(readLyrics(cfg(), { pro: lyricsStatus({ currentSlideText: null }), known: true }));
    assert.equal(JSON.stringify(next).includes(WORDS.chorusFirst), false);
  });
});

describe("the rows", () => {
  test("the default: the current slide with its tag, then the next group's tag with no words", () => {
    const r = slide(readLyrics(cfg(), { pro: lyricsStatus(), known: true }));
    assert.deepEqual(r.rows, [
      { under: false, tag: { name: "Chorus", text: "Chorus", colorHex: "#e5484d" }, words: WORDS.chorusFirst },
      { under: true, tag: { name: "Verse 2", text: "Verse 2", colorHex: "#3b82f6" }, words: null },
    ]);
    assert.equal(r.strip, null);
    assert.equal(r.title, null);
  });

  test("Shows the next slide: its group, and its words only when Its lyrics is on", () => {
    const pro = lyricsStatus();
    const slideOnly = slide(readLyrics(cfg({ underShows: "slide" }), { pro, known: true }));
    assert.equal(slideOnly.rows[1].tag?.name, "Chorus");
    assert.equal(slideOnly.rows[1].words, null);
    const withWords = slide(readLyrics(cfg({ underShows: "slide", underWords: true }), { pro, known: true }));
    assert.equal(withWords.rows[1].words, WORDS.chorusSecond);
    const group = slide(readLyrics(cfg({ underShows: "group", underWords: true }), { pro, known: true }));
    assert.equal(group.rows[1].words, WORDS.verse2);
  });

  test("Show what comes next off draws no row underneath", () => {
    assert.equal(slide(readLyrics(cfg({ under: false }), { pro: lyricsStatus(), known: true })).rows.length, 1);
  });

  test("the last slide has nothing underneath, for either Shows", () => {
    for (const underShows of ["slide", "group"] as const) {
      const r = slide(readLyrics(cfg({ underShows }), { pro: atOutro(), known: true }));
      assert.deepEqual(r.rows.map((x) => x.under), [false], underShows);
    }
  });

  test("a slide with no words: Tag only keeps its tag, Blank drops the row", () => {
    const tagOnly = slide(readLyrics(cfg({ noWords: "tag" }), { pro: atIntro(), known: true }));
    assert.deepEqual(tagOnly.rows[0], { under: false, tag: { name: "Intro", text: "Intro", colorHex: "#808080" }, words: null });
    const blank = slide(readLyrics(cfg({ noWords: "blank" }), { pro: atIntro(), known: true }));
    assert.equal(blank.rows.some((r) => !r.under), false);
    // The next group has words, so its row stays.
    assert.equal(blank.rows.filter((r) => r.under).length, 1);
  });

  test("Blank also drops an underneath row whose slide has no words", () => {
    // To the Outro: its group has no words.
    const toOutro = lyricsStatus({ nextArrangementSection: GROUPS.outro, nextGroupText: "" });
    assert.equal(slide(readLyrics(cfg({ noWords: "tag" }), { pro: toOutro, known: true })).rows.length, 2);
    assert.equal(slide(readLyrics(cfg({ noWords: "blank" }), { pro: toOutro, known: true })).rows.length, 1);
  });

  test("Text changes the words of the tag and never its name", () => {
    const tag = (tagText: "named" | "short" | "caps") =>
      slide(readLyrics(cfg({ tagText }), { pro: lyricsStatus({ currentSection: { name: "Verse 1", colorHex: "#3b82f6" } }), known: true })).rows[0].tag;
    assert.deepEqual([tag("named")?.text, tag("short")?.text, tag("caps")?.text], ["Verse 1", "V1", "VERSE 1"]);
    assert.equal(tag("short")?.name, "Verse 1");
  });

  test("Song title is the presentation's name, and only when on", () => {
    assert.equal(slide(readLyrics(cfg(), { pro: lyricsStatus(), known: true })).title, null);
    assert.equal(slide(readLyrics(cfg({ showTitle: true }), { pro: lyricsStatus(), known: true })).title, "Example Song");
  });
});

describe("the arrangement strip", () => {
  test("every group in play order, the current one lit and the earlier ones done", () => {
    const r = slide(readLyrics(cfg({ display: "strip" }), { pro: lyricsStatus(), known: true }));
    assert.deepEqual(r.strip?.map((c) => `${c.text}:${c.state}`), [
      "Intro:done",
      "V1:done",
      "C:now",
      "V2:next",
      "C:next",
      "B:next",
      "C:next",
      "Outro:next",
    ]);
  });

  test("lights the occurrence the slide is in, not every chorus", () => {
    const r = slide(readLyrics(cfg({ display: "strip" }), { pro: lyricsStatus({ playOrderGroupIndex: 4 }), known: true }));
    assert.deepEqual(r.strip?.map((c) => c.state), ["done", "done", "done", "done", "now", "next", "next", "next"]);
  });

  test("the current row has no tag of its own, and the row underneath still does", () => {
    const r = slide(readLyrics(cfg({ display: "strip" }), { pro: lyricsStatus(), known: true }));
    assert.equal(r.rows[0].tag, null);
    assert.equal(r.rows[1].tag?.name, "Verse 2");
  });

  test("an unknown position lights nothing, and no arrangement draws no strip", () => {
    const unknown = slide(readLyrics(cfg({ display: "strip" }), { pro: lyricsStatus({ playOrderGroupIndex: null }), known: true }));
    assert.equal(unknown.strip?.some((c) => c.state !== "next"), false);
    const none = slide(readLyrics(cfg({ display: "strip" }), { pro: lyricsStatus({ playOrderGroups: [], playOrderGroupIndex: null }), known: true }));
    assert.equal(none.strip, null);
  });

  test("the other layouts draw no strip", () => {
    for (const display of ["above", "beside"] as const) {
      assert.equal(slide(readLyrics(cfg({ display }), { pro: lyricsStatus(), known: true })).strip, null);
    }
  });
});
