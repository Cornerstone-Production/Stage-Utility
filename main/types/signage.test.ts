// The two facts about signage media that are easy to get wrong later.
//
// The mime allowlist is deliberately NOT the same as layout-image-store's: SVG
// is excluded there and here for different reasons of degree. A layout image is
// placed by whoever edits a layout; a signage library is uploaded by more people
// and every file in it is served from a URL anyone on the LAN can request. An
// SVG can carry script, so it stays out.
//
// The caps and the default transition are pinned because they are quoted in the
// docs and in the UI, and a silent drift between the three is how an operator
// gets a 413 the interface said would be fine.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import {
  DEFAULT_TRANSITION,
  MAX_TRANSITION_MS,
  SIGNAGE_MIME_CAPS,
  isSignageMime,
  isSignageVideo,
} from "./signage.js";

describe("signage constants", () => {
  test("the default transition is crossfade at 600ms", () => {
    assert.deepEqual(DEFAULT_TRANSITION, { kind: "crossfade", ms: 600 });
  });

  test("transitions are capped at 3000ms", () => {
    assert.equal(MAX_TRANSITION_MS, 3000);
  });

  test("images cap at 12MB and video at 200MB", () => {
    assert.equal(SIGNAGE_MIME_CAPS["image/png"], 12 * 1024 * 1024);
    assert.equal(SIGNAGE_MIME_CAPS["video/mp4"], 200 * 1024 * 1024);
  });

  test("SVG is not an accepted signage mime", () => {
    assert.equal(isSignageMime("image/svg+xml"), false);
    assert.equal(isSignageMime("image/png"), true);
    assert.equal(isSignageMime("video/webm"), true);
  });

  test("a mime nobody listed is rejected, however plausible", () => {
    // Object.hasOwn rather than a truthiness check: "constructor" and
    // "toString" are inherited on a plain object and would both read as
    // accepted, which is a real upload of an unhandled type.
    assert.equal(isSignageMime("constructor"), false);
    assert.equal(isSignageMime("toString"), false);
    assert.equal(isSignageMime("image/tiff"), false);
  });

  test("video is told apart from images", () => {
    assert.equal(isSignageVideo("video/mp4"), true);
    assert.equal(isSignageVideo("image/png"), false);
  });
});
