#!/usr/bin/env node
// build-icons.mjs — every app icon file, drawn from one geometry.
//
// The mark is a 5x7 dot-matrix S (the lettering of under-monitor displays and
// stage message boards) with a red tally dot hanging off its bottom-right like a
// decimal point. A seven-segment S was rejected because it is the same glyph as a
// 5; the 5x7 S has the top-right and bottom-left spurs a 5 does not.
//
// Everything here is generated, so the files cannot drift from each other or from
// this geometry: `npm run icons` rewrites them, and app-icons.test.ts fails if a
// committed file differs from what this script produces.
//
// No dependency: the shapes are circles on a grid inside a square, so a small
// supersampled rasterizer and a hand-written PNG encoder cover it.

import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 5x7, row by row. `#` lit, `.` unlit. */
const S = [".###.", "#...#", "#....", ".###.", "....#", "#...#", ".###."];

/** Solid colours. The dots of an unlit cell are pre-blended over the tile so the
 *  SVG and the PNG are the same pixels. Lit blue is the app's default accent
 *  (`--brand-accent` in renderer/styles.css), per theme; the tally is `--red-9`. */
export const THEMES = {
  dark: { tile: "#121212", lit: "#6aa6df", unlit: "#242424", tally: "#e5484d" },
  light: { tile: "#f5f5f5", lit: "#2e6691", unlit: "#e5e5e5", tally: "#e5484d" },
};

/** On a 1024 tile: pitch 96, dot 76, so a 20 gap. The S alone is centred; the
 *  tally takes the cell to the right of the bottom row. */
const P = 96;
const D = 76;
const X0 = (1024 - (5 * P - (P - D))) / 2;
const Y0 = (1024 - (7 * P - (P - D))) / 2;

/** Every dot, as { cx, cy, r, role } in 1024 space. */
function dots({ unlit }) {
  const out = [];
  S.forEach((row, r) =>
    [...row].forEach((ch, c) => {
      const lit = ch === "#";
      if (!lit && !unlit) return;
      out.push({ cx: X0 + c * P + D / 2, cy: Y0 + r * P + D / 2, r: D / 2, role: lit ? "lit" : "unlit" });
    }),
  );
  out.push({ cx: X0 + 5 * P + D / 2, cy: Y0 + 6 * P + D / 2, r: D / 2, role: "tally" });
  return out;
}

/** A maskable icon is cropped to as little as a circle of 40% radius: shrink the
 *  mark so the tally clears it. */
const MASKABLE_SCALE = 0.8;
/** A tab icon is 16px: the home screen's margin would leave the S seven pixels
 *  wide, so it is drawn larger, the tally still inside the rounded corner. */
const FAVICON_SCALE = 1.25;

function place(d, scale) {
  return { ...d, cx: 512 + (d.cx - 512) * scale, cy: 512 + (d.cy - 512) * scale, r: d.r * scale };
}

const fmt = (n) => String(Math.round(n * 100) / 100);

/**
 * The browser tab icon: a rounded tile with the lit dots only (unlit dots are noise
 * at 16px), dark by default and light under a light colour scheme. Safari reads
 * the SVG but not its media query, so it keeps the dark default.
 */
export function faviconSvg() {
  const k = 32 / 1024;
  const circles = dots({ unlit: false })
    .map((d) => place(d, FAVICON_SCALE))
    .map((d) => `<circle class="${d.role}" cx="${fmt(d.cx * k)}" cy="${fmt(d.cy * k)}" r="${fmt(d.r * k)}"/>`)
    .join("");
  const { dark, light } = THEMES;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><style>` +
    `.tile{fill:${dark.tile}}.lit{fill:${dark.lit}}.tally{fill:${dark.tally}}` +
    `@media (prefers-color-scheme: light){.tile{fill:${light.tile}}.lit{fill:${light.lit}}}` +
    `</style><rect class="tile" width="32" height="32" rx="7"/>${circles}</svg>\n`
  );
}

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

/** Rasterize the square icon at `size`, 4x4 supersampled. Returns RGB rows. */
function rasterize(theme, size, { maskable = false } = {}) {
  const t = THEMES[theme];
  const scale = maskable ? MASKABLE_SCALE : 1;
  const tile = hex(t.tile);
  const circles = dots({ unlit: true }).map((d) => ({ ...place(d, scale), rgb: hex(t[d.role]) }));
  const SS = 4;
  const k = 1024 / size;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(size * 3);
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = (x + (sx + 0.5) / SS) * k;
          const py = (y + (sy + 0.5) / SS) * k;
          let rgb = tile;
          for (const c of circles) {
            const dx = px - c.cx, dy = py - c.cy;
            if (dx * dx + dy * dy <= c.r * c.r) { rgb = c.rgb; break; }
          }
          r += rgb[0]; g += rgb[1]; b += rgb[2];
        }
      }
      const n = SS * SS;
      row[x * 3] = Math.round(r / n);
      row[x * 3 + 1] = Math.round(g / n);
      row[x * 3 + 2] = Math.round(b / n);
    }
    rows.push(row);
  }
  return rows;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** An opaque 8-bit RGB PNG. Opaque on purpose: iOS fills transparency with black. */
function encodePng(rows) {
  const size = rows.length;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const raw = Buffer.concat(rows.map((row) => Buffer.concat([Buffer.from([0]), row])));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Every generated file, keyed by its path under public/. The home screen icon is
 * the dark one: iOS and Android capture one image at install and never switch it
 * with the system theme. The light artwork lives in the favicon, which can.
 */
export function buildIcons() {
  return {
    "favicon.svg": faviconSvg(),
    "apple-touch-icon.png": encodePng(rasterize("dark", 180)),
    "icon-192.png": encodePng(rasterize("dark", 192)),
    "icon-512.png": encodePng(rasterize("dark", 512)),
    "icon-maskable-512.png": encodePng(rasterize("dark", 512, { maskable: true })),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
  for (const [name, data] of Object.entries(buildIcons())) {
    writeFileSync(path.join(publicDir, name), data);
    console.log(`wrote public/${name}`);
  }
}
