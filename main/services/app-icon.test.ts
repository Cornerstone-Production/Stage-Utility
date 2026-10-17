// What POST /api/branding accepts as the tab and home-screen icon.
//
// The set is checked as a whole because it is served as a whole: a 180 icon that is
// really 192 pixels, or a manifest-listed 512 that is 64, is wrong on a phone and
// invisible everywhere else. These run the real parser over real PNGs.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { iconInput, pngDataUrl } from "./app-icon-fixture.js";
import { parseAppIcon, pngSize } from "./app-icon.js";

function rejected(body: unknown): string {
  const r = parseAppIcon(body);
  assert.equal(r.ok, false, "expected the icon to be refused");
  return r.ok ? "" : r.error;
}

describe("pngSize", () => {
  test("reads the size a PNG declares", () => {
    assert.deepEqual(pngSize(pngDataUrl(180)), { width: 180, height: 180 });
    assert.deepEqual(pngSize(pngDataUrl(512)), { width: 512, height: 512 });
  });

  test("is null for anything that is not a PNG", () => {
    assert.equal(pngSize("data:image/png;base64,AAAA"), null);
    assert.equal(pngSize("data:image/jpeg;base64,/9j/4AAQ"), null);
    assert.equal(pngSize("not a data url"), null);
  });
});

describe("parseAppIcon", () => {
  test("null removes the icon", () => {
    assert.deepEqual(parseAppIcon(null), { ok: true, value: null });
  });

  test("a complete set is accepted, and the background is lowercased", () => {
    const r = parseAppIcon({ ...iconInput({ background: "#15425C" }) });
    assert.ok(r.ok && r.value);
    assert.equal(r.value.background, "#15425c");
    assert.deepEqual(r.value.crop, { scale: 1, x: 0, y: 0 });
  });

  test("the original and the crop are optional", () => {
    const r = parseAppIcon({ ...iconInput({ original: null, crop: null }) });
    assert.ok(r.ok && r.value);
    assert.equal(r.value.original, null);
    assert.equal(r.value.crop, null);
  });

  test("anything but an object or null is refused", () => {
    for (const v of ["x", 3, true, [], undefined]) assert.match(rejected(v), /body\.icon must be an object or null/);
  });

  test("every image is required, and the error names it", () => {
    for (const key of ["art", "apple", "any192", "any512", "maskable"] as const) {
      const body: Record<string, unknown> = { ...iconInput() };
      delete body[key];
      assert.match(rejected(body), new RegExp(`body\\.icon\\.${key} must be a PNG data URL`));
    }
  });

  test("each size must be exactly the size it is served as", () => {
    const wrong = [
      ["apple", pngDataUrl(192), /body\.icon\.apple must be 180 x 180, got 192 x 192/],
      ["any192", pngDataUrl(180), /body\.icon\.any192 must be 192 x 192, got 180 x 180/],
      ["any512", pngDataUrl(192), /body\.icon\.any512 must be 512 x 512, got 192 x 192/],
      ["maskable", pngDataUrl(256), /body\.icon\.maskable must be 512 x 512, got 256 x 256/],
    ] as const;
    for (const [key, value, message] of wrong) assert.match(rejected({ ...iconInput({ [key]: value }) }), message);
  });

  test("the art may be any square size, but not a rectangle", () => {
    assert.equal(parseAppIcon({ ...iconInput({ art: pngDataUrl(256) }) }).ok, true);
    const bytes = Buffer.from(pngDataUrl(256).split(",")[1]!, "base64");
    bytes.writeUInt32BE(128, 20); // height 128, width 256
    const body = { ...iconInput({ art: `data:image/png;base64,${bytes.toString("base64")}` }) };
    assert.match(rejected(body), /body\.icon\.art must be square/);
  });

  test("a non-PNG image is refused even when it is an image data URL", () => {
    assert.match(
      rejected({ ...iconInput({ apple: "data:image/jpeg;base64,/9j/4AAQSkZJRg==" }) }),
      /body\.icon\.apple must be a PNG data URL/,
    );
  });

  test("a PNG data URL with no PNG in it is refused", () => {
    assert.match(
      rejected({ ...iconInput({ any192: "data:image/png;base64,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }) }),
      /body\.icon\.any192 is not a valid PNG/,
    );
  });

  test("an image over the 2,000,000 character cap is refused", () => {
    const huge = `data:image/png;base64,${"A".repeat(2_000_001)}`;
    assert.match(rejected({ ...iconInput({ art: huge }) }), /body\.icon\.art too large/);
    assert.match(rejected({ ...iconInput({ original: huge }) }), /body\.icon\.original too large/);
  });

  test("the background must be #rrggbb", () => {
    for (const bg of ["black", "#000", "#00000g", "000000", "#0000000", null, 0]) {
      assert.match(rejected({ ...iconInput({ background: bg as never }) }), /body\.icon\.background must be a #rrggbb hex/, String(bg));
    }
  });

  test("the original must be an image data URL when given", () => {
    assert.match(rejected({ ...iconInput({ original: "/branding-images/abc.png" }) }), /body\.icon\.original must be an image data URL, a stored image or null/);
  });
});
