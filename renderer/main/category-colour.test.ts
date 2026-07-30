// Category colours are stored once, app-wide, because note categories are fetched per
// service type — "Audio" exists separately under Weekend, Youth and Salt Company. Keys
// therefore normalise, so setting Audio once colours all of them.

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { categoryColour, normaliseCategory, DEFAULT_CATEGORY_COLOUR } from "./category-colour.js";

describe("normalisation", () => {
  test("case and surrounding space collapse to one key", () => {
    assert.equal(normaliseCategory("Audio"), "audio");
    assert.equal(normaliseCategory("  audio "), "audio");
    assert.equal(normaliseCategory("AUDIO"), "audio");
  });
});

describe("categoryColour", () => {
  test("uses the configured colour", () => {
    assert.equal(categoryColour("Audio", { audio: "#0091ff" }), "#0091ff");
  });

  test("finds it regardless of how the category is cased", () => {
    assert.equal(categoryColour("  AUDIO ", { audio: "#0091ff" }), "#0091ff");
  });

  test("falls back to the keyword suggestion when unset", () => {
    // departmentColor()'s guess survives ONLY as a fallback, so an existing board
    // looks identical until someone chooses a colour.
    assert.equal(categoryColour("Lighting", {}), "#ffb224");
    assert.equal(categoryColour("Audio", undefined), "#0091ff");
  });

  test("an unrecognised category gets the neutral default", () => {
    assert.equal(categoryColour("Hospitality", {}), DEFAULT_CATEGORY_COLOUR);
  });

  test("a configured colour beats the keyword guess", () => {
    // The whole point: "Lighting" is no longer forced to amber.
    assert.equal(categoryColour("Lighting", { lighting: "#12a594" }), "#12a594");
  });

  test("deleting an entry reverts to the fallback rather than blanking", () => {
    const map: Record<string, string> = { lighting: "#12a594" };
    delete map.lighting;
    assert.equal(categoryColour("Lighting", map), "#ffb224");
  });
});
