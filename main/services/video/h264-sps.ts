// h264-sps.ts — a picture's width and height out of an H.264 sequence parameter
// set, the way an RTSP camera's SDP carries one (`sprop-parameter-sets`).
//
// Pure: bytes in, numbers out. Returns null for anything it cannot read rather
// than throwing — a camera's SDP is outside data, and a probe that cannot tell
// the resolution still knows the camera answered.

/** Reads bits MSB-first from a byte array; throws past the end. */
class BitReader {
  private pos = 0;
  constructor(private readonly bytes: Uint8Array) {}

  bit(): number {
    const byte = this.bytes[this.pos >> 3];
    if (byte === undefined) throw new RangeError("ran past the end of the SPS");
    const b = (byte >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return b;
  }

  bits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 2 + this.bit();
    return v;
  }

  /** Unsigned exp-Golomb. */
  ue(): number {
    let zeros = 0;
    while (this.bit() === 0) {
      zeros++;
      // 32 leading zeros is not a number any real SPS holds.
      if (zeros > 32) throw new RangeError("exp-Golomb value too long");
    }
    return 2 ** zeros - 1 + this.bits(zeros);
  }

  /** Signed exp-Golomb. */
  se(): number {
    const k = this.ue();
    return k % 2 === 1 ? (k + 1) / 2 : -(k / 2);
  }
}

const MIN_SIDE = 16;
const MAX_SIDE = 16384;

/** Profiles whose SPS carries the chroma/bit-depth/scaling-list block. */
const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

/** Drops the 0x03 emulation-prevention byte from every 00 00 03 run. */
function unescapeRbsp(nal: Uint8Array): Uint8Array {
  const out: number[] = [];
  let zeros = 0;
  for (const byte of nal) {
    if (zeros >= 2 && byte === 3) {
      zeros = 0;
      continue;
    }
    out.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return Uint8Array.from(out);
}

function skipScalingList(r: BitReader, size: number): void {
  let last = 8;
  let next = 8;
  for (let j = 0; j < size; j++) {
    if (next !== 0) {
      next = (last + r.se() + 256) % 256;
    }
    if (next !== 0) last = next;
  }
}

/** Width and height from one SPS NAL unit (its header byte included), or null. */
export function spsResolution(nal: Uint8Array): { width: number; height: number } | null {
  if (nal.length < 4 || (nal[0]! & 0x1f) !== 7) return null;
  try {
    const r = new BitReader(unescapeRbsp(nal.subarray(1)));
    const profile = r.bits(8);
    r.bits(8); // constraint flags and reserved bits
    r.bits(8); // level_idc
    r.ue(); // seq_parameter_set_id
    let chromaFormat = 1;
    let separatePlanes = false;
    if (HIGH_PROFILES.has(profile)) {
      chromaFormat = r.ue();
      if (chromaFormat === 3) separatePlanes = r.bit() === 1;
      r.ue(); // bit_depth_luma_minus8
      r.ue(); // bit_depth_chroma_minus8
      r.bit(); // qpprime_y_zero_transform_bypass_flag
      if (r.bit() === 1) {
        const lists = chromaFormat !== 3 ? 8 : 12;
        for (let i = 0; i < lists; i++) {
          if (r.bit() === 1) skipScalingList(r, i < 6 ? 16 : 64);
        }
      }
    }
    r.ue(); // log2_max_frame_num_minus4
    const pocType = r.ue();
    if (pocType === 0) {
      r.ue(); // log2_max_pic_order_cnt_lsb_minus4
    } else if (pocType === 1) {
      r.bit(); // delta_pic_order_always_zero_flag
      r.se(); // offset_for_non_ref_pic
      r.se(); // offset_for_top_to_bottom_field
      const cycle = r.ue();
      if (cycle > 255) return null;
      for (let i = 0; i < cycle; i++) r.se();
    }
    r.ue(); // max_num_ref_frames
    r.bit(); // gaps_in_frame_num_value_allowed_flag
    const widthMbs = r.ue() + 1;
    const heightMapUnits = r.ue() + 1;
    const frameMbsOnly = r.bit() === 1;
    if (!frameMbsOnly) r.bit(); // mb_adaptive_frame_field_flag
    r.bit(); // direct_8x8_inference_flag
    let cropLeft = 0;
    let cropRight = 0;
    let cropTop = 0;
    let cropBottom = 0;
    if (r.bit() === 1) {
      cropLeft = r.ue();
      cropRight = r.ue();
      cropTop = r.ue();
      cropBottom = r.ue();
    }
    const chromaArrayType = separatePlanes ? 0 : chromaFormat;
    // SubWidthC / SubHeightC: 2/2 for 4:2:0, 2/1 for 4:2:2, 1/1 for 4:4:4;
    // monochrome and separate planes crop in single samples.
    const unitX = chromaArrayType === 0 || chromaArrayType === 3 ? 1 : 2;
    const unitY = (chromaArrayType === 0 || chromaArrayType === 3 || chromaArrayType === 2 ? 1 : 2) * (frameMbsOnly ? 1 : 2);
    const width = widthMbs * 16 - unitX * (cropLeft + cropRight);
    const height = (frameMbsOnly ? 1 : 2) * heightMapUnits * 16 - unitY * (cropTop + cropBottom);
    // Garbage that happened to parse: no real picture is under one macroblock
    // or over 16384 either way (the H.264 level limits stop well short).
    if (width < MIN_SIDE || height < MIN_SIDE || width > MAX_SIDE || height > MAX_SIDE) return null;
    return { width, height };
  } catch {
    // Truncated or malformed: unknown resolution, not a failed probe.
    return null;
  }
}

/** Width and height from an SDP `sprop-parameter-sets` value (comma-separated
 *  base64 NAL units), taking the first sequence parameter set in it. */
export function spropResolution(sprop: string): { width: number; height: number } | null {
  for (const part of sprop.split(",")) {
    const nal = Buffer.from(part.trim(), "base64");
    const found = spsResolution(nal);
    if (found) return found;
  }
  return null;
}
