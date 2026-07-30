// Matching PCO's item row colours. Two rules that are easy to get backwards: custom
// types match text CONTAINED in the title (not the whole title, not the item type),
// and #ffffff means "no colour" rather than "white" — PCO ships it as the default on
// Media, so rendering it would paint a meaningless stripe on every video row.

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { resolveItemColour, washFor } from "./item-colour.js";

const STANDARD = [
  { name: "Header", color: "#eaebeb", custom: false },
  { name: "Media", color: "#ffffff", custom: false },
  { name: "Song", color: "#e8f6df", custom: false },
];

describe("standard types match the item type", () => {
  test("a song gets the Song colour", () => {
    assert.equal(resolveItemColour({ itemType: "song", title: "He Will Be" }, STANDARD), "#e8f6df");
  });

  test("a header gets the Header colour", () => {
    assert.equal(resolveItemColour({ itemType: "header", title: "SERVICE START" }, STANDARD), "#eaebeb");
  });

  test("matching is case-insensitive on the type name", () => {
    const c = [{ name: "SONG", color: "#e8f6df", custom: false }];
    assert.equal(resolveItemColour({ itemType: "song", title: "x" }, c), "#e8f6df");
  });

  test("a plain item matches nothing", () => {
    assert.equal(resolveItemColour({ itemType: "item", title: "Welcome" }, STANDARD), null);
  });
});

describe("#ffffff means unset", () => {
  test("Media's default white does not colour the row", () => {
    assert.equal(resolveItemColour({ itemType: "media", title: "VIDEO: Pre-roll" }, STANDARD), null);
  });

  test("but a near-white is a real choice and is kept", () => {
    const c = [{ name: "Media", color: "#fffffe", custom: false }];
    assert.equal(resolveItemColour({ itemType: "media", title: "x" }, c), "#fffffe");
  });
});

describe("custom types match text inside the title", () => {
  const CUSTOM = [...STANDARD, { name: "VIDEO", color: "#ffd9b0", custom: true }];

  test("a title containing the text matches", () => {
    assert.equal(resolveItemColour({ itemType: "item", title: "VIDEO: Need To Know" }, CUSTOM), "#ffd9b0");
  });

  test("matching is case-insensitive and substring, not exact", () => {
    assert.equal(resolveItemColour({ itemType: "item", title: "Roll the video now" }, CUSTOM), "#ffd9b0");
  });

  test("a custom match beats a standard one", () => {
    // A song whose title contains the custom text takes the custom colour — the
    // operator typed that text deliberately.
    assert.equal(resolveItemColour({ itemType: "song", title: "VIDEO: Song Intro" }, CUSTOM), "#ffd9b0");
  });

  test("a custom entry set to white is still unset", () => {
    const c = [{ name: "VIDEO", color: "#ffffff", custom: true }];
    assert.equal(resolveItemColour({ itemType: "item", title: "VIDEO: x" }, c), null);
  });

  test("an empty custom name never matches everything", () => {
    // "" is contained in every string; guard against a blank entry painting the plan.
    const c = [{ name: "", color: "#ff0000", custom: true }];
    assert.equal(resolveItemColour({ itemType: "item", title: "Welcome" }, c), null);
  });
});

describe("absent config", () => {
  test("no colours configured means no colour", () => {
    assert.equal(resolveItemColour({ itemType: "song", title: "x" }, undefined), null);
    assert.equal(resolveItemColour({ itemType: "song", title: "x" }, []), null);
  });
});

describe("washFor", () => {
  test("keeps the hue of a pale PCO colour instead of washing it to grey", () => {
    // The bug this exists for: #e8f6df mixed into near-black at 10% measured
    // rgb(33,34,32) on screen — neutral grey. A row has to look GREEN, not lighter.
    const wash = washFor("#e8f6df");
    assert.match(wash, /^hsl\(\d+ \d+% \d+%\)$/);
    const hue = Number(wash.match(/\d+/)![0]);
    assert.ok(hue > 70 && hue < 160, `expected a green hue, got ${hue}`);
  });

  test("a blue PCO colour stays blue", () => {
    const hue = Number(washFor("#e0f7ff").match(/\d+/)![0]);
    assert.ok(hue > 160 && hue < 240, `expected a cyan/blue hue, got ${hue}`);
  });

  test("a near-grey has no hue to keep, so it stays neutral", () => {
    // PCO's Header is #eaebeb — forcing a hue onto it would invent a colour.
    assert.equal(washFor("#eaebeb"), "rgba(255, 255, 255, 0.05)");
  });

  test("garbage does not produce a broken colour value", () => {
    assert.equal(washFor("not-a-colour"), "rgba(255, 255, 255, 0.05)");
  });
});
