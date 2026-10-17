// app-icon-fixture.ts — real PNGs of a given size, and a complete icon request, for
// the tests of the custom tab and home-screen icon.
//
// Real, not a one-pixel stand-in: the server reads each image's declared size, and
// a test that supplied a 1x1 for every field could not tell a 180 from a 512.

import * as zlib from "node:zlib";

import type { AppIconInput } from "./app-icon.js";

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A solid-colour square PNG `size` pixels across. `seed` changes the colour, so two
 *  images with different seeds are different files. */
export function pngDataUrl(size: number, seed = 0): string {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, seed & 0xff)]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

/** A complete, valid icon request: each image the size the server requires. */
export function iconInput(overrides: Partial<AppIconInput> = {}, seed = 1): AppIconInput {
  return {
    art: pngDataUrl(512, seed),
    original: pngDataUrl(64, seed + 10),
    crop: { scale: 1, x: 0, y: 0 },
    background: "#000000",
    apple: pngDataUrl(180, seed),
    any192: pngDataUrl(192, seed),
    any512: pngDataUrl(512, seed + 1),
    maskable: pngDataUrl(512, seed + 2),
    ...overrides,
  };
}
