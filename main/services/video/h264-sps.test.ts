// h264-sps.test.ts — a picture's size out of an SPS, including the cases that
// trip a hand-rolled decoder: frame cropping, interlaced coding, and the High
// profile block with its scaling lists.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { spropResolution, spsResolution } from "./h264-sps.js";

/** The real camera's `sprop-parameter-sets`, as it came back from a DESCRIBE. */
const REAL_CAMERA_SPROP = "Z2TAKKwbGqB4AiflkSAAAH0gADqYEeEQjUA=";

class BitWriter {
  private bits: number[] = [];
  u(value: number, n: number): this {
    for (let i = n - 1; i >= 0; i--) this.bits.push(Math.floor(value / 2 ** i) % 2);
    return this;
  }
  ue(value: number): this {
    const code = value + 1;
    const len = Math.floor(Math.log2(code));
    this.u(0, len);
    return this.u(code, len + 1);
  }
  se(value: number): this {
    return this.ue(value > 0 ? 2 * value - 1 : -2 * value);
  }
  bytes(): Uint8Array {
    const padded = [...this.bits, 1];
    while (padded.length % 8 !== 0) padded.push(0);
    const out: number[] = [];
    for (let i = 0; i < padded.length; i += 8) out.push(parseInt(padded.slice(i, i + 8).join(""), 2));
    return Uint8Array.from(out);
  }
}

interface SpsOptions {
  profile?: number;
  chromaFormat?: number;
  widthMbs: number;
  heightMapUnits: number;
  frameMbsOnly?: boolean;
  crop?: [left: number, right: number, top: number, bottom: number];
  scalingList?: boolean;
  pocType?: 0 | 1;
  level?: number;
}

function buildSps(o: SpsOptions): Uint8Array {
  const w = new BitWriter();
  const profile = o.profile ?? 66;
  w.u(0x67, 8); // nal_ref_idc 3, type 7
  w.u(profile, 8).u(0, 8).u(o.level ?? 40, 8).ue(0);
  if ([100, 110, 122, 244].includes(profile)) {
    const chroma = o.chromaFormat ?? 1;
    w.ue(chroma);
    if (chroma === 3) w.u(0, 1);
    w.ue(0).ue(0).u(0, 1);
    if (o.scalingList) {
      w.u(1, 1);
      for (let i = 0; i < (chroma !== 3 ? 8 : 12); i++) {
        if (i === 0 || i === 6) {
          // A 16-entry list (i < 6) and a 64-entry one (i >= 6), each with
          // deltas, so the decoder has to walk both lengths.
          w.u(1, 1);
          const size = i < 6 ? 16 : 64;
          for (let j = 0; j < size; j++) w.se(j % 2 === 0 ? 1 : -1);
        } else w.u(0, 1);
      }
    } else w.u(0, 1);
  }
  w.ue(0); // log2_max_frame_num_minus4
  const pocType = o.pocType ?? 0;
  w.ue(pocType);
  if (pocType === 0) w.ue(0);
  else w.u(0, 1).se(0).se(0).ue(2).se(1).se(2);
  w.ue(1).u(0, 1);
  w.ue(o.widthMbs - 1).ue(o.heightMapUnits - 1);
  const frameMbsOnly = o.frameMbsOnly ?? true;
  w.u(frameMbsOnly ? 1 : 0, 1);
  if (!frameMbsOnly) w.u(0, 1);
  w.u(1, 1); // direct_8x8_inference_flag
  if (o.crop) {
    w.u(1, 1);
    for (const c of o.crop) w.ue(c);
  } else w.u(0, 1);
  w.u(0, 1); // vui_parameters_present_flag
  return w.bytes();
}

test("a real camera's sprop-parameter-sets decodes to 1920 x 1080", () => {
  assert.deepEqual(spropResolution(REAL_CAMERA_SPROP), { width: 1920, height: 1080 });
});

test("the sprop value is the first parameter set; a trailing PPS is ignored", () => {
  assert.deepEqual(spropResolution(`${REAL_CAMERA_SPROP},aO48gA==`), { width: 1920, height: 1080 });
});

test("an uncropped picture is its macroblock size", () => {
  assert.deepEqual(spsResolution(buildSps({ widthMbs: 80, heightMapUnits: 45 })), { width: 1280, height: 720 });
});

test("frame cropping takes the cropped lines off: 1088 coded rows, 8 cropped, is 1080", () => {
  // CropUnitY is 2 for 4:2:0 progressive, so crop_bottom 4 is 8 rows.
  const sps = buildSps({ widthMbs: 120, heightMapUnits: 68, crop: [0, 0, 0, 4] });
  assert.deepEqual(spsResolution(sps), { width: 1920, height: 1080 });
});

test("cropping on every side counts each in its own unit", () => {
  const sps = buildSps({ widthMbs: 41, heightMapUnits: 23, crop: [3, 5, 2, 6] });
  // 656 - 2 * (3 + 5) wide; 368 - 2 * (2 + 6) high.
  assert.deepEqual(spsResolution(sps), { width: 640, height: 352 });
});

test("interlaced coding doubles the map-unit height, and its crop unit", () => {
  // 34 map units of two macroblock rows each is 1088 rows; CropUnitY is 4.
  const sps = buildSps({ widthMbs: 120, heightMapUnits: 34, frameMbsOnly: false, crop: [0, 0, 0, 2] });
  assert.deepEqual(spsResolution(sps), { width: 1920, height: 1080 });
});

test("a High profile SPS with a scaling list is walked past to the size", () => {
  const sps = buildSps({ profile: 100, widthMbs: 80, heightMapUnits: 45, scalingList: true });
  assert.deepEqual(spsResolution(sps), { width: 1280, height: 720 });
});

test("4:4:4 crops in single samples", () => {
  const sps = buildSps({ profile: 244, chromaFormat: 3, widthMbs: 120, heightMapUnits: 68, crop: [0, 0, 0, 8] });
  assert.deepEqual(spsResolution(sps), { width: 1920, height: 1080 });
});

test("picture order count type 1 is walked past too", () => {
  const sps = buildSps({ widthMbs: 40, heightMapUnits: 30, pocType: 1 });
  assert.deepEqual(spsResolution(sps), { width: 640, height: 480 });
});

test("emulation-prevention bytes are removed before decoding", () => {
  // profile_idc 0, constraint flags 0 and level_idc 1 put 00 00 01 in the
  // RBSP, which an encoder must escape as 00 00 03 01.
  const raw = buildSps({ profile: 0, level: 1, widthMbs: 1, heightMapUnits: 1 });
  const escaped: number[] = [];
  let zeros = 0;
  for (const b of raw) {
    if (zeros >= 2 && b <= 3) {
      escaped.push(3);
      zeros = 0;
    }
    escaped.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  assert.ok(escaped.length > raw.length, "the fixture must actually contain an escape, or this proves nothing");
  assert.deepEqual(spsResolution(Uint8Array.from(escaped)), { width: 16, height: 16 });
});

test("anything unreadable is null, never a throw", () => {
  assert.equal(spsResolution(Uint8Array.from([0x68, 0xee, 0x3c, 0x80])), null, "a PPS is not an SPS");
  assert.equal(spsResolution(Uint8Array.from([0x67, 0x64, 0xc0, 0x28])), null, "truncated mid-header");
  assert.equal(spropResolution("not base64 at all !!"), null);
  assert.equal(spropResolution(""), null);
});

test("a size no real picture has is null: over 16384, under 16, or cropped away", () => {
  assert.equal(spsResolution(buildSps({ widthMbs: 2000, heightMapUnits: 45 })), null, "32000 wide");
  assert.equal(spsResolution(buildSps({ widthMbs: 80, heightMapUnits: 1100 })), null, "17600 high");
  assert.equal(spsResolution(buildSps({ widthMbs: 1, heightMapUnits: 45, crop: [4, 0, 0, 0] })), null, "8 wide after cropping");
  assert.equal(spsResolution(buildSps({ widthMbs: 80, heightMapUnits: 1, crop: [0, 0, 0, 4] })), null, "8 high after cropping");
  assert.deepEqual(spsResolution(buildSps({ widthMbs: 1, heightMapUnits: 1 })), { width: 16, height: 16 }, "the smallest allowed");
  assert.deepEqual(spsResolution(buildSps({ widthMbs: 1024, heightMapUnits: 1024 })), { width: 16384, height: 16384 }, "the largest allowed");
});
