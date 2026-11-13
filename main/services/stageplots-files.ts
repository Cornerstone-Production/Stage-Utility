// stageplots-files.ts — where a stage-plot background's files live.
//
// Two folders under the data directory, both content-addressed (the file name
// is the first 16 hex of the bytes' SHA-256, so an identical upload is one
// file):
//
//   stageplot-images/     the converted WebP every plot draws, and the PNG or
//                         JPEG source it was converted from. Served, cached
//                         forever, like the layout and branding images.
//   stageplot-originals/  an uploaded PDF, kept so nothing the operator gave
//                         is lost. Never served: no route names this folder.
//
// Config backups carry both (config-snapshot.ts).

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { STAGEPLOT_LIMITS, type Background, type BackgroundView, type StagePlotsDoc, type StagePlotsView } from "../types/stageplots.js";
import { getUserDataPath } from "./app-paths.js";
import { errorMessage, isNotFound } from "./errors.js";
import { scrub } from "./scrub.js";
import { contentName, imageDir, listImages, readImage, saveImageBytes, type ContentRule } from "./image-files.js";
import { isPdf } from "./stageplots-convert.js";
import { atomicWrite } from "./write-queue.js";

export const STAGEPLOT_IMAGE_DIR = "stageplot-images";
export const STAGEPLOT_ORIGINAL_DIR = "stageplot-originals";

/** Every stage-plot image is checked against its type when stored, and restored to the same rule. */
export const STAGEPLOT_IMAGE_RULE: ContentRule = { checkContent: true };

/** The largest PDF original kept. Above the 12 MB image cap: a plan set exported
 *  from a drawing program is often bigger than a photo of it. */
export const MAX_STAGEPLOT_PDF_BYTES = STAGEPLOT_LIMITS.pdfBytes;

/** PDFs kept while their page has not arrived (unreferenced and inside the grace
 *  window) at most. Each upload is two requests, so a few may overlap; more is a
 *  loop filling the disk. */
export const MAX_PENDING_ORIGINALS = 5;

/** A file younger than this is never removed as unreferenced: a PDF upload is
 *  two requests (the original, then the page raster), and another browser's
 *  delete between them must not take the original out from under it. */
export const STAGEPLOT_FILE_GRACE_MS = 60 * 60 * 1000;

export type StagePlotImageExt = "webp" | "png" | "jpg";

/** Store a converted image or a source raster. Returns its hash. */
export async function storeStagePlotImage(bytes: Buffer, ext: StagePlotImageExt): Promise<string> {
  const file = await saveImageBytes(STAGEPLOT_IMAGE_DIR, bytes, ext, STAGEPLOT_IMAGE_RULE);
  return file.slice(0, file.indexOf("."));
}

export function stagePlotImageUrl(hash: string, ext: StagePlotImageExt): string {
  return `/${STAGEPLOT_IMAGE_DIR}/${hash}.${ext}`;
}

/** A source raster's bytes, for a re-conversion, or null when it is missing. */
/** A background as the API serves it, with the URLs of its converted image and its source. */
export function backgroundView(b: Background): BackgroundView {
  return { ...b, url: stagePlotImageUrl(b.converted.hash, "webp"), sourceUrl: stagePlotImageUrl(b.source.hash, b.source.ext) };
}

/** The document as GET /api/stageplots and every stageplots:updated frame carry it. */
export function stagePlotsView(doc: StagePlotsDoc): StagePlotsView {
  return {
    venues: doc.venues,
    plots: doc.plots,
    backgrounds: doc.backgrounds.map(backgroundView),
    overrides: doc.overrides,
    // Never the secrets; and not a publish in flight, which is not yet anything to remove.
    pendingRemovals: doc.pendingRemovals.filter((e) => e.reason !== "publishing").map(({ origin, since, reason }) => ({ origin, since, reason })),
  };
}

/** A converted background's WebP bytes, or null when the file is not there. */
export async function readStagePlotImage(hash: string): Promise<Buffer | null> {
  return (await readImage(STAGEPLOT_IMAGE_DIR, `${hash}.webp`))?.data ?? null;
}

export async function readStagePlotSource(hash: string, ext: "png" | "jpg"): Promise<Buffer | null> {
  return (await readImage(STAGEPLOT_IMAGE_DIR, `${hash}.${ext}`))?.data ?? null;
}

const ORIGINAL_NAME = /^[0-9a-f]{16}\.pdf$/;

/**
 * Why `bytes` under `file` is not an original storeStagePlotOriginal could
 * have written, or null. What a restore holds every original to.
 */
export function storedOriginalProblem(file: string, bytes: Buffer): string | null {
  if (!ORIGINAL_NAME.test(file)) return "is not the name of a stored original";
  if (bytes.length === 0) return "is empty";
  if (bytes.length > MAX_STAGEPLOT_PDF_BYTES) return "is too large (max 25 MB)";
  if (!isPdf(bytes)) return "is not a PDF";
  if (contentName(bytes, "pdf") !== file) return "does not match its contents";
  return null;
}

function originalsDir(): string {
  return imageDir(STAGEPLOT_ORIGINAL_DIR);
}

/** Keep an uploaded PDF. Returns its hash. Throws a sentence when it is not one. */
export async function storeStagePlotOriginal(pdf: Buffer): Promise<string> {
  const file = contentName(pdf, "pdf");
  const problem = storedOriginalProblem(file, pdf);
  if (problem) throw new Error(`the PDF ${problem}`);
  await writeOriginal(file, pdf);
  return file.slice(0, 16);
}

async function writeOriginal(file: string, bytes: Buffer): Promise<void> {
  await fs.mkdir(originalsDir(), { recursive: true });
  await atomicWrite(path.join(originalsDir(), file), bytes);
}

/** `read`'s answer, or null when what it reads is not there. Any other failure throws. */
async function ifFound<T>(read: Promise<T>): Promise<T | null> {
  try {
    return await read;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** The size of the original a raster upload names, or null when it is not here. */
export async function stagePlotOriginalBytes(hash: string): Promise<number | null> {
  if (!/^[0-9a-f]{16}$/.test(hash)) return null;
  return (await ifFound(fs.stat(path.join(originalsDir(), `${hash}.pdf`))))?.size ?? null;
}

/** Every original kept, for a backup. */
export async function listStagePlotOriginals(): Promise<string[]> {
  return ((await ifFound(fs.readdir(originalsDir()))) ?? []).filter((f) => ORIGINAL_NAME.test(f));
}

/** An original's bytes, for a backup, or null when it is not there. */
export async function readStagePlotOriginal(file: string): Promise<Buffer | null> {
  return ORIGINAL_NAME.test(file) ? ifFound(fs.readFile(path.join(originalsDir(), file))) : null;
}

/** Write back an original a restore has already checked with storedOriginalProblem. */
export async function restoreStagePlotOriginal(file: string, bytes: Buffer): Promise<void> {
  const problem = storedOriginalProblem(file, bytes);
  if (problem) throw new Error(`${STAGEPLOT_ORIGINAL_DIR}/${file} ${problem}`);
  await writeOriginal(file, bytes);
}

/** Every file name the document's backgrounds point at, in either folder. */
function referencedFiles(doc: StagePlotsDoc): Set<string> {
  const refs = new Set<string>();
  for (const b of doc.backgrounds) {
    refs.add(`${STAGEPLOT_IMAGE_DIR}/${b.converted.hash}.webp`);
    refs.add(`${STAGEPLOT_IMAGE_DIR}/${b.source.hash}.${b.source.ext}`);
    if (b.original.mime === "application/pdf") refs.add(`${STAGEPLOT_ORIGINAL_DIR}/${b.original.hash}.pdf`);
  }
  return refs;
}

/**
 * Delete files no background names any more, once they are older than the
 * grace window. Returns how many went and which could not be removed or read;
 * a failure leaves the file where it is, which costs disk and nothing else.
 */
export async function removeUnreferenced(doc: StagePlotsDoc, now = Date.now()): Promise<{ removed: number; failed: string[] }> {
  const refs = referencedFiles(doc);
  let removed = 0;
  const failed: string[] = [];
  const listings: [string, Promise<string[]>][] = [
    [STAGEPLOT_IMAGE_DIR, listImages(STAGEPLOT_IMAGE_DIR)],
    [STAGEPLOT_ORIGINAL_DIR, listStagePlotOriginals()],
  ];
  for (const [dir, listing] of listings) {
    let files: string[];
    try {
      files = await listing;
    } catch (err) {
      failed.push(`${dir} (${errorMessage(err)})`);
      continue;
    }
    for (const file of files) {
      if (refs.has(`${dir}/${file}`)) continue;
      const full = path.join(imageDir(dir), file);
      try {
        if (now - (await fs.stat(full)).mtimeMs < STAGEPLOT_FILE_GRACE_MS) continue;
        await fs.rm(full, { force: true });
        removed++;
      } catch (err) {
        failed.push(`${dir}/${file} (${errorMessage(err)})`);
      }
    }
  }
  return { removed, failed };
}

/** Copies of a damaged stageplots.json the store moved aside (DataStore names
 *  them `stageplots.json.corrupt-<time>`). */
async function quarantinedStores(): Promise<string[]> {
  return ((await ifFound(fs.readdir(getUserDataPath()))) ?? []).filter((f) => f.startsWith("stageplots.json.corrupt-")).sort();
}

export type TidyResult = { skipped: string } | { removed: number; failed: string[] };

/** What the tidy reads: the document, and whether it stands in for a damaged
 *  file. stageplotsStore is one. */
export interface TidySource {
  get: () => Promise<StagePlotsDoc>;
  readonly loadedFromCorrupt: boolean;
}

/**
 * Remove the files no background names, as removeUnreferenced does, and say
 * what happened on [stageplots]. Run after a delete or a clean-up switch and
 * once a day (cache-maintenance.ts).
 *
 * Deletes nothing when the store has just found stageplots.json damaged, while
 * a damaged copy sits quarantined beside it, nor when the document cannot be
 * read. The store answers a damaged
 * file with an empty document, and after a restart a legitimately empty one;
 * either way every file would look unreferenced, and the quarantined copy that
 * still names them is what the operator recovers from. Each skipped run says
 * so, until that copy is moved away.
 */
export async function tidyStagePlotFiles(store: TidySource, now = Date.now()): Promise<TidyResult> {
  let result: TidyResult | null = null;
  let doc: StagePlotsDoc | null = null;
  // Read first: reading a damaged file is what moves it aside and empties the
  // document, so the checks below must come after it, not before.
  try {
    doc = await store.get();
  } catch (err) {
    result = { skipped: `the stage plots could not be read: ${errorMessage(err)}` };
  }
  if (!result && store.loadedFromCorrupt) {
    result = { skipped: "stageplots.json could not be parsed and the plots were started empty; restore from its .corrupt- copy, if one was made, then restart" };
  }
  if (!result) {
    const quarantined = await quarantinedStores().catch((err: unknown) => [`(the data folder could not be listed: ${errorMessage(err)})`]);
    if (quarantined.length > 0) {
      result = { skipped: `${quarantined.join(", ")} holds what a damaged stageplots.json was; restore from it, then move it out of the data folder` };
    }
  }
  result ??= await removeUnreferenced(doc!, now);
  if ("skipped" in result) console.warn(`[stageplots] tidy skipped, nothing deleted: ${scrub(result.skipped, 600)}`);
  else {
    if (result.removed > 0) console.log(`[stageplots] removed ${scrub(result.removed)} background file(s) nothing uses`);
    if (result.failed.length > 0) console.warn(`[stageplots] could not tidy ${scrub(result.failed.length)} background file(s): ${scrub(result.failed.join("; "), 600)}`);
  }
  return result;
}

/**
 * PDFs kept whose page has not arrived yet: originals no background names that
 * were written inside the grace window. An older unreferenced one is not
 * waiting on anything (after a damaged stageplots.json every original is
 * unreferenced, and the tidy is holding off), so it does not count.
 */
export async function pendingOriginals(doc: StagePlotsDoc, now = Date.now()): Promise<string[]> {
  const refs = referencedFiles(doc);
  const pending: string[] = [];
  for (const f of await listStagePlotOriginals()) {
    if (refs.has(`${STAGEPLOT_ORIGINAL_DIR}/${f}`)) continue;
    const stat = await ifFound(fs.stat(path.join(originalsDir(), f)));
    if (stat && now - stat.mtimeMs < STAGEPLOT_FILE_GRACE_MS) pending.push(f);
  }
  return pending;
}
