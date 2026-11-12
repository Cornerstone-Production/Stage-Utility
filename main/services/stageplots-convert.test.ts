import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { crc32, deflateSync } from "node:zlib";

import sharp from "sharp";

import { conversionPeak, convertBackground, isPdf, sniffUpload } from "./stageplots-convert.js";

/** A noisy image, generated here: nothing real goes in a fixture. */
function noise(width: number, height: number) {
  return sharp({ create: { width, height, channels: 3, background: { r: 128, g: 128, b: 128 }, noise: { type: "gaussian", mean: 128, sigma: 60 } } });
}

/** Noise softened by a 1 px blur, which compresses about as a busy phone photo
 *  does. Raw Gaussian noise at 4.3 MP does not fit 1 MB at any quality tried. */
async function photoLike(width: number, height: number): Promise<Buffer> {
  return sharp(await noise(width, height).png({ compressionLevel: 1 }).toBuffer()).blur(1).jpeg({ quality: 92 }).toBuffer();
}

/** A drawing-like image: light paper with dark lines, as a scanned plan is. */
async function drawing(width: number, height: number): Promise<Buffer> {
  const lines = Array.from({ length: 12 }, (_, i) => `<rect x="${(i + 1) * (width / 13)}" y="0" width="6" height="${height}" fill="#404040"/>`).join("");
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#c8b48c"/>${lines}</svg>`);
  return sharp(svg).png().toBuffer();
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A PNG that claims to be width × height and carries one byte of pixel data. */
function pngHeaderOnly(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.alloc(1))), chunk("IEND", Buffer.alloc(0))]);
}

describe("sniffUpload", () => {
  test("names a PNG and a JPEG by their content", async () => {
    assert.deepEqual(await sniffUpload(await noise(64, 48).png().toBuffer()), { kind: "png" });
    assert.deepEqual(await sniffUpload(await noise(64, 48).jpeg().toBuffer()), { kind: "jpeg" });
  });

  test("isPdf reads the magic and nothing else", () => {
    assert.equal(isPdf(Buffer.from("%PDF-1.4")), true);
    assert.equal(isPdf(Buffer.from("%PDF")), false);
    assert.equal(isPdf(Buffer.from(" %PDF-1.4")), false);
  });

  test("names %PDF- bytes pdf", async () => {
    assert.deepEqual(await sniffUpload(Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj\n", "latin1")), { kind: "pdf" });
  });

  test("refuses a GIF, an SVG text, a WebP and random bytes", async () => {
    const gif = await noise(16, 16).gif().toBuffer();
    const webp = await noise(16, 16).webp().toBuffer();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    const random = Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 73 + 41) % 256));
    for (const [what, bytes] of [["gif", gif], ["webp", webp], ["svg", svg], ["random", random]] as const) {
      const r = await sniffUpload(bytes);
      assert.ok("problem" in r, `${what} was accepted as ${JSON.stringify(r)}`);
      assert.match(r.problem, /PNG, JPEG or PDF/);
    }
  });

  test("refuses a zip renamed .png", async () => {
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(200)]);
    assert.ok("problem" in (await sniffUpload(zip)));
  });

  test("refuses a PNG whose header is not followed by an image", async () => {
    const r = await sniffUpload(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]));
    assert.ok("problem" in r, JSON.stringify(r));
  });

  test("a 30000x30000 PNG header is refused by its size without decoding", async () => {
    const started = performance.now();
    const r = await sniffUpload(pngHeaderOnly(30000, 30000));
    assert.ok("problem" in r, JSON.stringify(r));
    assert.match(r.problem, /30000 × 30000/);
    assert.match(r.problem, /50 megapixels/);
    assert.ok(performance.now() - started < 2000, "took long enough to have decoded");
  });
});

describe("convertBackground", () => {
  test("a 4000x3000 photo-like JPEG becomes a WebP under 1 MB with long edge 2400", async () => {
    const jpeg = await photoLike(4000, 3000);
    assert.ok(jpeg.length > 4_000_000, `the fixture is only ${jpeg.length} bytes`);
    const out = await convertBackground(jpeg, { cleanup: false });
    assert.ok(out.webp.length < 1_000_000, `${out.webp.length} bytes`);
    assert.equal(out.width, 2400);
    assert.equal(out.height, 1800);
    const meta = await sharp(out.webp).metadata();
    assert.equal(meta.format, "webp");
    assert.equal(meta.width, 2400);
  });

  test("an image no quality brings under 1 MB is still converted, at the lowest quality", async () => {
    const jpeg = await noise(4000, 3000).jpeg({ quality: 92 }).toBuffer();
    const out = await convertBackground(jpeg, { cleanup: false });
    assert.ok(out.webp.length >= 1_000_000, `pure noise came in at ${out.webp.length} bytes; pick a harder fixture`);
    assert.equal(out.width, 2400);
  });

  test("a 1200x800 PNG is not enlarged", async () => {
    const out = await convertBackground(await drawing(1200, 800), { cleanup: false });
    assert.deepEqual([out.width, out.height], [1200, 800]);
  });

  test("EXIF orientation 6 is applied (output is portrait)", async () => {
    const jpeg = await noise(300, 200).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    assert.equal((await sharp(jpeg).metadata()).orientation, 6);
    const out = await convertBackground(jpeg, { cleanup: false });
    assert.deepEqual([out.width, out.height], [200, 300]);
    assert.equal((await sharp(out.webp).metadata()).orientation, undefined);
  });

  test("clean-up output is greyscale and lighter on average than without", async () => {
    const png = await drawing(900, 600);
    const plain = await convertBackground(png, { cleanup: false });
    const clean = await convertBackground(png, { cleanup: true });
    const raw = await sharp(clean.webp).removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
    assert.equal(raw.info.channels, 3);
    for (let px = 0; px < raw.data.length; px += 3 * 997) {
      const [r, g, b] = [raw.data[px], raw.data[px + 1], raw.data[px + 2]];
      assert.ok(Math.abs(r - g) <= 1 && Math.abs(g - b) <= 1, `pixel ${px / 3} is ${r},${g},${b}`);
    }
    const mean = async (b: Buffer) => (await sharp(b).stats()).channels.slice(0, 3).reduce((s, c) => s + c.mean, 0) / 3;
    assert.ok((await mean(clean.webp)) > (await mean(plain.webp)), "clean-up did not lighten the drawing");
    // 40% toward white leaves nothing darker than 102 of 255, give or take the
    // ringing lossy WebP adds beside a hard edge. Without the fade the lines are 58.
    const min = (await sharp(clean.webp).stats()).channels[0].min;
    assert.ok(min >= 90, `the darkest pixel is ${min}`);
  });

  test("the same input and setting give identical bytes", async () => {
    const png = await drawing(1600, 900);
    const a = await convertBackground(png, { cleanup: true });
    const b = await convertBackground(png, { cleanup: true });
    assert.ok(a.webp.equals(b.webp));
  });

  test("conversions run one at a time and each still answers", async () => {
    const png = await drawing(1600, 1200);
    conversionPeak(true);
    const results = await Promise.all([
      convertBackground(png, { cleanup: false }),
      convertBackground(png, { cleanup: true }),
      convertBackground(png, { cleanup: false }),
    ]);
    assert.deepEqual(results.map((r) => r.width), [1600, 1600, 1600]);
    assert.equal(conversionPeak(), 1, "more than one conversion ran at once");
  });

  test("a 30000x30000 PNG header is refused by limitInputPixels, with a sentence", async () => {
    await assert.rejects(() => convertBackground(pngHeaderOnly(30000, 30000), { cleanup: false }), /could not convert the background: .*pixel/i);
  });

  test("a failed conversion does not stop the next one", async () => {
    await assert.rejects(() => convertBackground(Buffer.from("not an image"), { cleanup: false }), /could not convert the background/);
    assert.equal((await convertBackground(await drawing(400, 300), { cleanup: false })).width, 400);
  });
});
