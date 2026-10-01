// Which size of a Planning Center photo gets asked for.
//
// A Screens preview draws a slot photo about 100px tall and was downloading the
// ~1000px original to do it: 13 faces, 3.2 MB, on every browser that opened the
// page. The fix asks PCO's own resizer for a smaller copy. These pin the two
// halves of choosing it: which rung of the ladder a drawn size lands on, and how
// the URL's geometry is scaled to that rung without changing its shape.
//
// The URLs are the shapes production serves, for a person who does not exist.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PHOTO_SIZES, downscaleAvatarUrl, photoSizeFor } from "./avatar-geometry.js";

const AVATAR = "https://avatars.planningcenteronline.com/uploads/person/100000001-1600000000/avatar.2.png";

describe("photoSizeFor", () => {
  it("lands every drawn size on the smallest rung that covers it", () => {
    const cases: Array<[number, number | null]> = [
      [1, 128],
      [100, 128],
      [128, 128],
      [129, 192],
      [250, 256],
      [280, 384],
      [512, 512],
      [600, 768],
      [768, 768],
    ];
    for (const [px, want] of cases) assert.equal(photoSizeFor(px), want, `${px}px`);
  });

  it("asks for the server's own geometry past the top rung", () => {
    assert.equal(photoSizeFor(769), null);
    assert.equal(photoSizeFor(4000), null);
  });

  it("treats a missing or junk size as no size at all", () => {
    // What the route passes for an absent `?s=` (Number(null) is 0) or `?s=abc`.
    for (const px of [0, -5, Number.NaN, Number(null), Number("abc"), Number.POSITIVE_INFINITY]) {
      assert.equal(photoSizeFor(px), null, String(px));
    }
  });

  it("only ever answers a rung of the ladder", () => {
    for (let px = 1; px <= 800; px++) {
      const s = photoSizeFor(px);
      assert.ok(s === null || (PHOTO_SIZES as readonly number[]).includes(s), `${px}px -> ${s}`);
    }
  });
});

describe("downscaleAvatarUrl", () => {
  it("shrinks a whole-image geometry and keeps it a fit-inside", () => {
    // An inline slots-grid's photo: the whole image, because the server cannot
    // see the box. No `%23`, so PCO fits rather than crops.
    assert.equal(downscaleAvatarUrl(`${AVATAR}?g=1000x1000`, 256), `${AVATAR}?g=256x256`);
  });

  it("shrinks a column crop and keeps both its shape and its crop flag", () => {
    // A display's stacked slot. The crop is the shape the column is drawn at, so
    // a smaller copy must be the same crop at fewer pixels.
    assert.equal(downscaleAvatarUrl(`${AVATAR}?g=245x432%23`, 256), `${AVATAR}?g=145x256%23`);
    assert.equal(downscaleAvatarUrl(`${AVATAR}?g=440x432%23`, 256), `${AVATAR}?g=256x251%23`);
  });

  it("never enlarges past the geometry the server chose", () => {
    // Same URL, so the same disk entry and the same bytes as before sizes existed.
    const url = `${AVATAR}?g=245x432%23`;
    assert.equal(downscaleAvatarUrl(url, 512), url);
    assert.equal(downscaleAvatarUrl(url, 432), url);
  });

  it("gives an original upload with no geometry a fit-inside box", () => {
    assert.equal(downscaleAvatarUrl(AVATAR, 128), `${AVATAR}?g=128x128`);
    assert.equal(downscaleAvatarUrl(`${AVATAR}?v=2`, 128), `${AVATAR}?v=2&g=128x128`);
  });

  it("never asks for a zero side, which PCO answers with a 1x1 pixel", () => {
    assert.equal(downscaleAvatarUrl(`${AVATAR}?g=2000x1%23`, 128), `${AVATAR}?g=128x1%23`);
  });
});
