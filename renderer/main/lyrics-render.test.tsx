// What a Lyrics object DRAWS: each layout, each setting that changes the output,
// and the states. The real ObjectContent, so the registry arm, the reading and
// the component are all on the path.
//
// NOT covered, and why: sizes and wrapping. jsdom loads no stylesheet and reports
// every box as one fixed size, so the S, M, L and Fit sizes, the way two lines of
// lyric wrap, and the Fit measurement were driven in a real browser instead (see
// the commit that added this). The size is asserted only as a relation — L is
// larger than M, larger than S — which a measurement from the wrong place would
// still satisfy; the screenshots are the check on the numbers.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import type { LyricsConfig } from "./lyrics-config.js";
import type { LayoutRenderCtx } from "./layout-renderer.js";
import { installRenderDom } from "../test-dom.js";
import { GROUPS, WORDS, atIntro, atOutro, lyricsStatus } from "../test-fixtures/lyrics-status.js";
import { NoStream } from "../test-fixtures/no-stream.js";

const teardown = installRenderDom({ clientHeight: 240 });
(globalThis as { EventSource?: unknown }).EventSource = NoStream;

const { render, cleanup } = await import("@testing-library/react");
const React = (await import("react")).default;
const { ObjectContent } = await import("./layout-renderer.js");
const { makeRenderCtx } = await import("./test-render-ctx.js");
const { lyricsFitKey } = await import("./lyrics-object.js");
const { readLyrics } = await import("./lyrics-reading.js");
const { lyricsSettings } = await import("./lyrics-config.js");

after(() => {
  cleanup();
  teardown();
});
afterEach(() => cleanup());

const object = (config: Partial<LyricsConfig>, style: Record<string, unknown> = { color: "#ffffff" }) =>
  ({ id: "l1", x: 0, y: 0, w: 0.5, h: 0.5, z: 1, config: { type: "lyrics", ...config }, style }) as never;

function mount(config: Partial<LyricsConfig>, ctx: Partial<LayoutRenderCtx> = {}, style?: Record<string, unknown>) {
  cleanup();
  const result = render(
    React.createElement(ObjectContent as never, { o: object(config, style), ctx: makeRenderCtx({ propresenter: lyricsStatus(), ...ctx }) }),
  );
  return { ...result, root: result.container.firstElementChild as HTMLElement };
}

const q = (root: ParentNode, sel: string) => root.querySelector(sel) as HTMLElement | null;
const all = (root: ParentNode, sel: string) => [...root.querySelectorAll(sel)] as HTMLElement[];
const row = (root: ParentNode, which: "current" | "under") => q(root, `[data-lyrics-row="${which}"]`);
const tagOf = (root: ParentNode, which: "current" | "under") => q(row(root, which) as HTMLElement, "[data-lyrics-tag]");
const wordsOf = (root: ParentNode, which: "current" | "under") => q(row(root, which) as HTMLElement, "[data-lyrics-words]");
/** The lyric's font size: set on the block the fit measures, the parent of the rows. */
const px = (root: HTMLElement) => parseFloat((q(root, "[data-lyrics-row]")!.parentElement as HTMLElement).style.fontSize);
/** A filled tag's fill: its own child, so the tag can be dimmed without its ink. */
const fillOf = (tag: HTMLElement) => q(tag, "[data-lyrics-fill]")!;
// A failed assert.equal over a DOM node makes Node diff the whole jsdom graph and
// takes tens of seconds to say so; every "nothing is drawn" claim below is a
// boolean for that reason.
// A failed assert.equal over a DOM node makes Node diff the whole jsdom graph and
// takes tens of seconds to say so; every "nothing is drawn" claim below is a
// boolean for that reason.

describe("the default: the tag above the words", () => {
  test("the current slide's tag then its words, and the next group's tag with no words", () => {
    const { root } = mount({});
    assert.equal(root.dataset.lyrics, "slide");
    assert.equal(root.dataset.lyricsDisplay, "above");
    const current = row(root, "current")!;
    assert.equal(current.style.flexDirection, "column", "above stacks the tag over the words");
    assert.deepEqual([...current.children].map((c) => (c as HTMLElement).hasAttribute("data-lyrics-words")), [false, true]);
    assert.equal(tagOf(root, "current")?.textContent, "Chorus");
    assert.equal(wordsOf(root, "current")?.textContent, WORDS.chorusFirst);
    assert.equal(wordsOf(root, "current")?.style.whiteSpace, "pre-line", "a line break in the lyric is kept");
    assert.equal(tagOf(root, "under")?.textContent, "Verse 2");
    assert.ok(wordsOf(root, "under") === null, "expected nothing to be drawn");
  });

  test("filled, in ProPresenter's colour, with the lyric left-aligned and bold", () => {
    const { root } = mount({});
    const tag = tagOf(root, "current")!;
    assert.equal(fillOf(tag).style.background, "rgb(229, 72, 77)");
    assert.equal(wordsOf(root, "current")!.style.textAlign, "left");
    assert.equal(wordsOf(root, "current")!.style.fontWeight, "600");
    assert.equal(row(root, "current")!.style.alignItems, "flex-start");
  });

  test("the underneath tag is dimmed by its fill, a little: 75%, and its ink keeps its strength", () => {
    const { root } = mount({});
    const under = tagOf(root, "under")!;
    assert.equal(fillOf(under).style.opacity, "0.75");
    assert.equal(fillOf(tagOf(root, "current")!).style.opacity, "1");
    // Not the whole element: dimming the ink too is what read as washed-out grey
    // on a dark wall, where the ground the dimmed ink fades toward is black.
    assert.equal(under.style.opacity, "", "the tag's own opacity would dim its ink");
    assert.equal(under.style.color, "rgb(255, 255, 255)");
  });
});

describe("Beside", () => {
  test("the tag sits in a column to the left of the words", () => {
    const { root } = mount({ display: "beside" });
    const current = row(root, "current")!;
    assert.equal(current.style.flexDirection, "", "a row, not a column");
    const [cell, words] = [...current.children] as HTMLElement[];
    assert.equal(cell.style.width, "3.7em", "the column width");
    assert.equal(cell.style.justifyContent, "flex-end", "tags right-align in the column");
    assert.ok(words.hasAttribute("data-lyrics-words"));
  });

  test("Width: Fit gives the tag its own width instead of the column", () => {
    const { root } = mount({ display: "beside", tagWidth: "fit" });
    const cell = row(root, "current")!.firstElementChild as HTMLElement;
    assert.equal(cell.style.width, "");
  });

  test("Align does not apply: the words stay left even when Centre is chosen", () => {
    const { root } = mount({ display: "beside", align: "center" });
    assert.equal(wordsOf(root, "current")!.style.textAlign, "left");
  });
});

describe("Arrangement", () => {
  test("a chip per group in play order, short, with the current one lit", () => {
    const { root } = mount({ display: "strip" });
    const chips = all(root, "[data-lyrics-chip]");
    assert.deepEqual(chips.map((c) => c.textContent), ["Intro", "V1", "C", "V2", "C", "B", "C", "Outro"]);
    assert.deepEqual(chips.map((c) => c.dataset.lyricsChip), ["done", "done", "now", "next", "next", "next", "next", "next"]);
  });

  test("the lit chip is filled with its colour and ringed; the rest carry the colour on their edge", () => {
    const { root } = mount({ display: "strip" });
    const [, , now, next] = all(root, "[data-lyrics-chip]");
    assert.equal(now.style.background, "rgb(229, 72, 77)");
    assert.match(now.style.boxShadow, /0\.1em/);
    // The unlit chips wear the theme's own neutral fill and text (tokens), never a
    // fixed grey: a fixed dark chip is a black blob on a light Home card.
    assert.equal(next.style.background, "var(--color-fill-active)");
    assert.equal(next.style.color, "var(--color-fg)");
    assert.equal(all(root, "[data-lyrics-chip='done']")[0].style.background, "var(--color-fill)");
    assert.equal(all(root, "[data-lyrics-chip='done']")[0].style.color, "var(--color-fg-faint)");
    assert.match(next.style.borderLeft, /0\.2em solid/);
  });

  test("Align: Centre centres the chip strip as well as the words, Left leaves it at the start", () => {
    const strip = (align: LyricsConfig["align"]) => q(mount({ display: "strip", align }).root, "[data-lyrics-strip]")!;
    assert.equal(strip("center").style.justifyContent, "center");
    assert.equal(strip("left").style.justifyContent, "flex-start");
    const centred = mount({ display: "strip", align: "center" }).root;
    assert.equal(row(centred, "current")!.style.alignItems, "center");
    assert.equal(wordsOf(centred, "current")!.style.textAlign, "center");
  });

  test("the current row carries the words but no tag, and the next group keeps its tag", () => {
    const { root } = mount({ display: "strip" });
    assert.ok(tagOf(root, "current") === null, "expected nothing to be drawn");
    assert.equal(wordsOf(root, "current")?.textContent, WORDS.chorusFirst);
    assert.equal(tagOf(root, "under")?.textContent, "Verse 2");
  });

  test("is the same strip in the same order for the second chorus, lit on its own place", () => {
    const { root } = mount({ display: "strip" }, { propresenter: lyricsStatus({ playOrderGroupIndex: 4 }) });
    assert.deepEqual(all(root, "[data-lyrics-chip]").map((c) => c.dataset.lyricsChip), ["done", "done", "done", "done", "now", "next", "next", "next"]);
  });
});

describe("each setting changes what is drawn", () => {
  test("an outline or text tag underneath is dimmed whole, its colour being its ink", () => {
    for (const tagStyle of ["outline", "text"] as const) {
      assert.equal(tagOf(mount({ tagStyle }).root, "under")!.style.opacity, "0.75", tagStyle);
    }
  });

  test("Style", () => {
    const outline = tagOf(mount({ tagStyle: "outline" }).root, "current")!;
    assert.match(outline.style.border, /0\.065em solid/);
    assert.equal(outline.style.background, "");
    assert.equal(outline.style.color, "rgb(229, 72, 77)");
    const text = tagOf(mount({ tagStyle: "text" }).root, "current")!;
    assert.equal(text.style.border, "");
    assert.equal(text.style.background, "");
    assert.equal(text.style.color, "rgb(229, 72, 77)");
  });

  test("Colour: one colour is the app accent for every group", () => {
    const { root } = mount({ tagColor: "one" });
    assert.equal(fillOf(tagOf(root, "current")!).style.background, "var(--color-accent)");
    assert.equal(fillOf(tagOf(root, "under")!).style.background, "var(--color-accent)");
    const strip = mount({ tagColor: "one", display: "strip" }).root;
    assert.equal(all(strip, "[data-lyrics-chip='now']")[0].style.background, "var(--color-accent)");
  });

  test("a filled tag is white on every colour the mockup draws, and dark only on one too light for white", () => {
    const ink = (colorHex: string) =>
      tagOf(mount({}, { propresenter: lyricsStatus({ currentSection: { name: "Chorus", colorHex } }) }).root, "current")!.style.color;
    // The mockup's red, blue and amber: white.
    for (const hex of ["#e5484d", "#3b82f6", "#f59e0b"]) assert.equal(ink(hex), "rgb(255, 255, 255)", hex);
    // A yellow and a cream would be white on nearly white.
    for (const hex of ["#ffd60a", "#f4f0ec"]) assert.equal(ink(hex), "rgb(10, 10, 10)", hex);
    // The lit chip follows the same rule.
    const chip = (colorHex: string) =>
      all(
        mount({ display: "strip" }, { propresenter: lyricsStatus({ playOrderGroups: [{ name: "Chorus", colorHex }], playOrderGroupIndex: 0 }) }).root,
        "[data-lyrics-chip='now']",
      )[0].style.color;
    assert.equal(chip("#ffd60a"), "rgb(10, 10, 10)");
    assert.equal(chip("#e5484d"), "rgb(255, 255, 255)");
  });

  test("Text", () => {
    const named = { name: "Verse 1", colorHex: "#3b82f6" };
    const pro = lyricsStatus({ currentSection: named });
    const text = (tagText: LyricsConfig["tagText"]) => tagOf(mount({ tagText }, { propresenter: pro }).root, "current")!.textContent;
    assert.deepEqual([text("named"), text("short"), text("caps")], ["Verse 1", "V1", "VERSE 1"]);
  });

  test("Size: L is larger than M, larger than S, and Fit is a size of its own", () => {
    const size = (s: LyricsConfig["size"]) => px(mount({ size: s }).root);
    const [s, m, l, fit] = [size("s"), size("m"), size("l"), size("fit")];
    assert.ok(s < m && m < l, `sizes ${s} ${m} ${l} are not in order`);
    assert.ok(fit > 0);
  });

  test("Weight", () => {
    assert.equal(wordsOf(mount({ weight: "regular" }).root, "current")!.style.fontWeight, "400");
    assert.equal(wordsOf(mount({ weight: "bold" }).root, "current")!.style.fontWeight, "600");
  });

  test("Align: Centre centres the tag and the words above", () => {
    const { root } = mount({ align: "center" });
    assert.equal(row(root, "current")!.style.alignItems, "center");
    assert.equal(wordsOf(root, "current")!.style.textAlign, "center");
  });

  test("No words", () => {
    const intro = { propresenter: atIntro() };
    const tagOnly = mount({ noWords: "tag" }, intro).root;
    assert.equal(tagOf(tagOnly, "current")?.textContent, "Intro");
    assert.ok(wordsOf(tagOnly, "current") === null, "expected nothing to be drawn");
    assert.ok(row(mount({ noWords: "blank" }, intro).root, "current") === null, "expected nothing to be drawn");
  });

  test("Show what comes next", () => {
    assert.ok(row(mount({ under: true }).root, "under"));
    assert.ok(row(mount({ under: false }).root, "under") === null, "expected nothing to be drawn");
  });

  test("Shows, and Its lyrics", () => {
    const group = mount({ underShows: "group" }).root;
    assert.equal(tagOf(group, "under")?.textContent, "Verse 2");
    const slide = mount({ underShows: "slide" }).root;
    assert.equal(tagOf(slide, "under")?.textContent, "Chorus");
    assert.equal(wordsOf(mount({ underShows: "group", underWords: true }).root, "under")?.textContent, WORDS.verse2);
    assert.equal(wordsOf(mount({ underShows: "slide", underWords: true }).root, "under")?.textContent, WORDS.chorusSecond);
  });

  test("Dimmed: more dims the tag and the words further", () => {
    const light = mount({ underWords: true, underDim: "light" }).root;
    const strong = mount({ underWords: true, underDim: "strong" }).root;
    assert.equal(fillOf(tagOf(light, "under")!).style.opacity, "0.75");
    assert.equal(fillOf(tagOf(strong, "under")!).style.opacity, "0.45");
    assert.ok(Number(wordsOf(strong, "under")!.style.opacity) < Number(wordsOf(light, "under")!.style.opacity));
    assert.equal(wordsOf(light, "current")!.style.opacity, "1", "the current words are never dimmed");
  });

  test("Song title", () => {
    assert.ok(q(mount({ showTitle: false }).root, "[data-lyrics-title]") === null, "expected nothing to be drawn");
    assert.equal(q(mount({ showTitle: true }).root, "[data-lyrics-title]")?.textContent, "Example Song");
  });

  test("the object's own text colour is the lyric's; with none it follows the surface", () => {
    assert.equal(mount({}, {}, { color: "#ffcc00" }).root.style.color, "rgb(255, 204, 0)");
    assert.equal(mount({}, {}, {}).root.style.color, "", "no colour is stated, so Home's card decides");
  });
});

describe("the states", () => {
  test("the last slide has nothing underneath", () => {
    const { root } = mount({}, { propresenter: atOutro() });
    assert.ok(row(root, "under") === null, "expected nothing to be drawn");
    assert.equal(tagOf(root, "current")?.textContent, "Outro");
  });

  test("not answered yet: nothing at all, and no dash", () => {
    const { root } = mount({}, { propresenter: null, propresenterKnown: false });
    assert.equal(root.dataset.lyrics, "loading");
    assert.equal(root.textContent, "");
  });

  test("not connected: a dim dash, never a lyric", () => {
    const { root } = mount({}, { propresenter: lyricsStatus({ connected: false }), propresenterKnown: true });
    assert.equal(root.dataset.lyrics, "none");
    assert.equal(root.textContent, "—");
    assert.equal(root.textContent?.includes("Sing"), false);
  });

  test("no presentation open: a dim dash", () => {
    const pro = lyricsStatus({ currentItem: null, currentSlideText: null, currentSection: null });
    assert.equal(mount({}, { propresenter: pro }).root.dataset.lyrics, "none");
  });

  test("never a stale lyric: the same object redrawn over a status that has moved on keeps nothing", () => {
    const first = mount({});
    assert.ok(first.container.textContent?.includes("Sing it out"));
    // The server sends a whole status each time, so moving on is a new prop; the
    // old words must not survive the redraw in any of its three ways.
    for (const next of [lyricsStatus({ connected: false }), atIntro(), lyricsStatus({ currentSlideText: null })]) {
      first.rerender(React.createElement(ObjectContent as never, { o: object({}), ctx: makeRenderCtx({ propresenter: next }) }));
      assert.equal(first.container.textContent?.includes("Sing it out"), false, "the old words are still on screen");
    }
  });

  test("a named instance reads that instance, and one that has not loaded has not answered", () => {
    const other = lyricsStatus({ currentSlideText: "Words from the second room" });
    const ctx = {
      propInstances: { list: [{ id: "room2", name: "Room 2" }], conn: {}, status: { room2: other } } as never,
    };
    const named = mount({ propresenterInstanceId: "room2" }, ctx).root;
    assert.ok(named.textContent?.includes("Words from the second room"));
    assert.equal(mount({ propresenterInstanceId: "room2" }, { propInstances: null }).root.dataset.lyrics, "loading");
    // The default instance is not the second room.
    assert.equal(mount({}, ctx).root.textContent?.includes("second room"), false);
  });
});

test("the colours of the fixture are the ones the mockup draws", () => {
  assert.equal(GROUPS.chorus.colorHex, "#e5484d");
});

describe("what makes the fit measure again", () => {
  const key = (pro: ReturnType<typeof lyricsStatus>, over: Partial<LyricsConfig> = {}) => {
    const config = { type: "lyrics", display: "strip", ...over } as LyricsConfig;
    return lyricsFitKey(readLyrics(config, { pro, known: true }), lyricsSettings(config));
  };

  test("the chips' own text, not only how many there are", () => {
    // A new song with as many groups: same count, other names.
    const other = lyricsStatus({ playOrderGroups: lyricsStatus().playOrderGroups.map((g, i) => (i === 3 ? { ...g, name: "Interlude" } : g)) });
    assert.notEqual(key(lyricsStatus()), key(other));
  });

  test("the words, and the settings that change the block's size, but not a colour", () => {
    assert.notEqual(key(lyricsStatus()), key(lyricsStatus({ currentSlideText: "Other words" })));
    assert.notEqual(key(lyricsStatus(), { weight: "regular" }), key(lyricsStatus(), { weight: "bold" }));
    assert.equal(key(lyricsStatus(), { tagColor: "one" }), key(lyricsStatus(), { tagColor: "propresenter" }));
  });
});
