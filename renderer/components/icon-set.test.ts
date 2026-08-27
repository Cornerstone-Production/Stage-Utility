// The icon set is an API, because the NAMES are what get stored.
//
// A glyph is saved in settings.json as a name from this set. Rename an entry and
// every icon an operator chose under the old name silently reverts; ship a name
// this build cannot resolve and, without a fallback, the icon becomes a hole.
// Both are quiet failures on somebody's wall, so both are pinned here.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { ICON_SET, resolveIcon, searchIcons } from "./icon-set.js";

describe("the icon set", () => {
  test("has no duplicate names — a name is the stored key", () => {
    const names = ICON_SET.map((c) => c.name);
    assert.equal(new Set(names).size, names.length, "two entries share a name");
  });

  test("every name is storable, so nothing here can be rejected on save", () => {
    // The same shape the server validates in setIconGlyph. An entry that cannot
    // round-trip is an entry the picker offers and the save refuses.
    for (const { name } of ICON_SET) {
      assert.match(name, /^[A-Za-z][A-Za-z0-9]{0,63}$/, `"${name}" would be refused`);
    }
  });

  test("every entry actually resolves to a component", () => {
    for (const { name } of ICON_SET) {
      assert.ok(resolveIcon(name), `"${name}" is listed but does not resolve`);
    }
  });

  test("an unknown name resolves to null, so the caller can fall back", () => {
    // Not a placeholder icon: null means "draw the item's own built-in icon".
    // A set trimmed in a later release must not blank somebody's chosen icon.
    assert.equal(resolveIcon("AnIconFromAFutureRelease"), null);
    assert.equal(resolveIcon(""), null);
    assert.equal(resolveIcon(null), null);
    assert.equal(resolveIcon(undefined), null);
  });
});

describe("searching it", () => {
  test("an empty query is the whole set, not nothing", () => {
    assert.equal(searchIcons("").length, ICON_SET.length);
    assert.equal(searchIcons("   ").length, ICON_SET.length);
  });

  test("finds by name, case-insensitively", () => {
    assert.ok(searchIcons("monitor").some((c) => c.name === "Monitor"));
    assert.ok(searchIcons("MONITOR").some((c) => c.name === "Monitor"));
  });

  test("finds by the word an operator would actually type", () => {
    // The whole point of keywords: nobody searches "Presentation" for a
    // projector, or "SlidersHorizontal" for a console.
    const has = (q: string, name: string) => searchIcons(q).some((c) => c.name === name);
    assert.ok(has("projector", "Projector"));
    assert.ok(has("console", "SlidersHorizontal"));
    assert.ok(has("baptism", "Droplet"));
    assert.ok(has("countdown", "Timer"));
    assert.ok(has("wireless", "Mic"));
    assert.ok(has("script", "BookOpen"));
  });

  test("a query matching nothing returns nothing rather than everything", () => {
    assert.deepEqual(searchIcons("zzzzzzz"), []);
  });
});
