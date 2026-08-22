// What the browser tells the server about a file it is uploading.
//
// The server cannot measure a graphic without decoding it, and decoding a 200 MB
// video server-side would mean shipping ffmpeg. The browser already knows —
// Image.naturalWidth and HTMLVideoElement.duration — so it measures and sends
// the numbers alongside the bytes, and the server range-checks them.
//
// That makes the filename and the measurements untrusted header values, which is
// what these pin: a name cannot forge a header, and a measurement that failed is
// never quietly turned into a plausible default.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { uploadHeadersFor } from "./upload-headers.js";

describe("what an upload tells the server", () => {
  test("sends the measured size", () => {
    assert.deepEqual(uploadHeadersFor({ name: "welcome.png", mime: "image/png", w: 1920, h: 1080 }), {
      "Content-Type": "image/png",
      "X-Signage-Name": "welcome.png",
      "X-Signage-W": "1920",
      "X-Signage-H": "1080",
    });
  });

  test("sends a duration only for video", () => {
    const v = uploadHeadersFor({ name: "c.mp4", mime: "video/mp4", w: 1920, h: 1080, durationMs: 42000 });
    assert.equal(v["X-Signage-Duration-Ms"], "42000");
    const i = uploadHeadersFor({ name: "a.png", mime: "image/png", w: 8, h: 8, durationMs: 42000 });
    assert.equal("X-Signage-Duration-Ms" in i, false, "an image was given a duration");
  });

  test("a name with a newline cannot forge a header", () => {
    // fetch() would throw on a header value containing CRLF, so this is the
    // difference between an upload that works and one that dies on a filename
    // somebody pasted from a spreadsheet.
    const h = uploadHeadersFor({ name: "ok.png\r\nX-Evil: 1", mime: "image/png", w: 8, h: 8 });
    assert.ok(!/[\r\n]/.test(h["X-Signage-Name"]), "a newline survived into a header value");
  });

  test("a non-ASCII name survives as something the server can read back", () => {
    // Header values are latin-1 on the wire; a raw multi-byte character throws
    // in fetch. Encoding keeps the operator's name rather than mangling it.
    const h = uploadHeadersFor({ name: "Bienvenido á casa.png", mime: "image/png", w: 8, h: 8 });
    assert.ok(!/[^\x20-\x7e]/.test(h["X-Signage-Name"]), "a non-ASCII byte was left in a header value");
    assert.equal(decodeURIComponent(h["X-Signage-Name"]), "Bienvenido á casa.png");
  });

  test("a measurement that never arrived is not invented", () => {
    // The whole point of measuring client-side is defeated if a failure becomes
    // a plausible-looking default. It throws, and the caller reports it.
    assert.throws(
      () => uploadHeadersFor({ name: "x.mp4", mime: "video/mp4", w: 1920, h: 1080 }),
      /duration/i,
    );
    assert.throws(
      () => uploadHeadersFor({ name: "x.png", mime: "image/png", w: 0, h: 1080 }),
      /size/i,
    );
  });
});
