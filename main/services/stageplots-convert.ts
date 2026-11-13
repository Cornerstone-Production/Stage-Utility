// stageplots-convert.ts — what an uploaded stage-plot background is, and the one
// conversion it goes through.
//
// A background is converted once, when it is uploaded or its clean-up setting
// changes, never per request: rotated per its EXIF, its long edge brought down
// to 2400 px, and encoded as WebP under 1 MB. Clean-up turns a colour scan or a
// photo into a quiet drawing (greyscale, contrast evened, then 40% of the way
// to white) so items drawn over it read first.
//
// Only PNG and JPEG reach sharp, and only after their magic bytes say so: SVG,
// HEIF, GIF and WebP are refused before any decoder sees them, which keeps the
// librsvg and libheif inside sharp out of reach of an upload. A PDF is never
// decoded here; the browser renders its page to a PNG and that is converted.

import type { Metadata, OutputInfo, Sharp, SharpOptions } from "sharp";

import { errorMessage } from "./errors.js";

/** The largest source a conversion decodes. 4000 × 3000 is 12 MP; 50 MP is ample. */
export const MAX_SOURCE_PIXELS = 50_000_000;
/** The long edge of a converted background, in pixels. */
export const CONVERTED_LONG_EDGE = 2400;
/** A converted background is encoded under this many bytes. */
export const CONVERTED_MAX_BYTES = 1_000_000;
/** WebP qualities tried in turn until one comes in under the cap. */
const QUALITIES = [80, 70, 60, 50, 40] as const;

type SharpFn = (input?: Buffer, options?: SharpOptions) => Sharp;
let sharpLoad: Promise<SharpFn> | null = null;

/**
 * sharp, loaded the first time a background needs it rather than when the
 * server starts: a platform whose native build is missing or will not load
 * then fails its stage-plot uploads, with the reason, and nothing else. A
 * failed load is tried again on the next upload.
 */
function loadSharp(): Promise<SharpFn> {
  sharpLoad ??= import("sharp").then(
    (m) => {
      // A Raspberry Pi has little memory to spare, and a background is converted once.
      m.default.cache({ memory: 20, files: 0 });
      return m.default as unknown as SharpFn;
    },
    (err: unknown) => {
      sharpLoad = null;
      // The reason stays on `cause` for the log: it names paths on this machine.
      throw new Error("image processing is not available on this server: sharp did not load", { cause: err });
    },
  );
  return sharpLoad;
}

const INPUT = { failOn: "error", limitInputPixels: MAX_SOURCE_PIXELS } as const;

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

function startsWith(bytes: Buffer, magic: readonly number[]): boolean {
  return bytes.length >= magic.length && magic.every((b, i) => bytes[i] === b);
}

/** Whether `bytes` start with a PDF's `%PDF-` magic. */
export function isPdf(bytes: Buffer): boolean {
  return bytes.subarray(0, 5).toString("latin1") === "%PDF-";
}

export type Sniffed = { kind: "png" | "jpeg" } | { kind: "pdf" } | { problem: string };

/**
 * What an upload is, by its content, or why it is refused. A PNG or JPEG is
 * also read far enough to know its size, and one over 50 megapixels is refused
 * here, before anything decodes it. Throws, rather than refusing the upload,
 * when sharp itself cannot be loaded.
 */
export async function sniffUpload(bytes: Buffer): Promise<Sniffed> {
  if (isPdf(bytes)) return { kind: "pdf" };
  if (!startsWith(bytes, PNG_MAGIC) && !startsWith(bytes, JPEG_MAGIC)) return { problem: "is not a PNG, JPEG or PDF" };
  const sharp = await loadSharp();
  let meta: Metadata;
  try {
    // metadata() reads the header and decodes no pixels, so the pixel limit is
    // lifted here to learn the size and say it; the check below applies it.
    meta = await sharp(bytes, { failOn: "error", limitInputPixels: false }).metadata();
  } catch (err) {
    return { problem: `could not be read as an image (${errorMessage(err)})` };
  }
  if (meta.format !== "png" && meta.format !== "jpeg") return { problem: "is not a PNG, JPEG or PDF" };
  const { width, height } = meta;
  if (!width || !height) return { problem: "has no width or height" };
  if (width * height > MAX_SOURCE_PIXELS) {
    return { problem: `is ${width} × ${height}, more than ${MAX_SOURCE_PIXELS / 1_000_000} megapixels` };
  }
  return { kind: meta.format };
}

export interface Converted {
  webp: Buffer;
  width: number;
  height: number;
}

async function convert(source: Buffer, cleanup: boolean): Promise<Converted> {
  const sharp = await loadSharp();
  let pipe = sharp(source, INPUT)
    .rotate()
    .resize({ width: CONVERTED_LONG_EDGE, height: CONVERTED_LONG_EDGE, fit: "inside", withoutEnlargement: true });
  if (cleanup) {
    // Two passes: sharp runs normalise after linear within one pipeline, which
    // would stretch the faded image straight back to full contrast.
    const { data, info } = await pipe.greyscale().normalise().raw().toBuffer({ resolveWithObject: true });
    pipe = sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } }).linear(0.6, 102);
  }
  let last: { data: Buffer; info: OutputInfo } | null = null;
  for (const quality of QUALITIES) {
    last = await pipe.clone().webp({ quality }).toBuffer({ resolveWithObject: true });
    if (last.data.length < CONVERTED_MAX_BYTES) break;
  }
  if (!last) throw new Error("no quality was tried");
  // Over the cap even at the lowest quality, which only noise does: kept, since
  // refusing would leave the operator no way to use the image. The route logs it.
  return { webp: last.data, width: last.info.width, height: last.info.height };
}

/** The JPEG quality a stored source is re-encoded at. */
const SOURCE_JPEG_QUALITY = 90;

/**
 * The source a background keeps: the upload turned upright and brought down to
 * 2400 px on its long edge (never enlarged), in its own format, with every
 * metadata block dropped (EXIF with its GPS and device, XMP, and any ICC
 * profile, the pixels converted to sRGB). What clean-up re-converts from.
 */
async function storableSource(input: Buffer, kind: "png" | "jpeg"): Promise<Buffer> {
  const sharp = await loadSharp();
  const pipe = sharp(input, INPUT)
    .rotate()
    .resize({ width: CONVERTED_LONG_EDGE, height: CONVERTED_LONG_EDGE, fit: "inside", withoutEnlargement: true })
    .toColourspace("srgb");
  // sharp writes no metadata unless told to keep it.
  return kind === "png" ? pipe.png({ compressionLevel: 9 }).toBuffer() : pipe.jpeg({ quality: SOURCE_JPEG_QUALITY }).toBuffer();
}

/** Conversions run one at a time: each holds a decoded image in memory. */
let queue: Promise<unknown> = Promise.resolve();

/** Conversions running now, and the most there have been at once: the seam
 *  that shows the queue holds. */
const inFlight = { now: 0, peak: 0 };

/** How many conversions have run at once since the last reset. For tests. */
export function conversionPeak(reset = false): number {
  const peak = inFlight.peak;
  if (reset) inFlight.peak = inFlight.now;
  return peak;
}

async function counted<T>(run: () => Promise<T>): Promise<T> {
  inFlight.now++;
  inFlight.peak = Math.max(inFlight.peak, inFlight.now);
  try {
    return await run();
  } finally {
    inFlight.now--;
  }
}

export interface Prepared {
  /** What is stored as the background's source (see storableSource). */
  source: Buffer;
  converted: Converted;
}

/**
 * An upload made into what a background stores: its source at 2400 px without
 * metadata, and the WebP converted from that source, so a later clean-up
 * switch gives exactly what the upload did. One job on the conversion queue.
 */
export function prepareBackground(input: Buffer, opts: { kind: "png" | "jpeg"; cleanup: boolean }): Promise<Prepared> {
  return enqueue(async () => {
    const source = await storableSource(input, opts.kind);
    return { source, converted: await convert(source, opts.cleanup) };
  });
}

/** Run `job` on the conversion queue, counted, its failure a sentence. */
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(() =>
    counted(job).catch((err: unknown) => {
      throw new Error(`could not convert the background: ${errorMessage(err)}`, { cause: err });
    }),
  );
  queue = run.catch(() => undefined);
  return run;
}

/**
 * Convert a PNG or JPEG source into the WebP a plot draws. Same input and
 * setting, same bytes. Throws with a sentence when it cannot.
 */
export function convertBackground(source: Buffer, opts: { cleanup: boolean }): Promise<Converted> {
  return enqueue(() => convert(source, opts.cleanup));
}
