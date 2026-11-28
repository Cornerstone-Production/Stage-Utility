// image-files.ts — content-addressed image storage, shared by the layout-image and
// branding stores.
//
// The name is a hash of the bytes, which buys three things: identical uploads dedupe
// to one file, a changed image gets a new URL so caches invalidate themselves, and
// the served response can be marked immutable and cached forever.
//
// The point of keeping bytes out of JSON is what they cost when they travel. A
// base64 logo inside stage:state is re-sent to every display on every state change;
// a URL is forty bytes and is fetched once.

import * as crypto from "node:crypto";
import * as fs from "fs/promises";
import * as path from "path";

import { getUserDataPath } from "./app-paths.js";
import { externKeyed } from "../types/extern-keyed.js";
import { MAX_IMAGE_BYTES, megabytes } from "../types/limits.js";
import { atomicWrite } from "./write-queue.js";
import { isNotFound } from "./errors.js";

// NOT externKeyed(), unlike MIME_BY_EXT below: the only lookup into this table
// is `EXT_BY_MIME[m[1].toLowerCase()]`, and `m[1]` is a capture of
// `image/[a-zA-Z0-9.+-]+` — every possible key starts "image/", so none of them
// can be an inherited member name. If that regex ever loosens, wrap this too.
// See main/types/extern-keyed.ts.
const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

const MIME_BY_EXT: Record<string, string> = externKeyed({
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
});

/** The largest image the store will accept. Exported so the route body limits
 *  can be checked against it rather than against a copy of the number. */
export { MAX_IMAGE_BYTES };

/**
 * The Content-Security-Policy a stored image is served with.
 *
 * An SVG is a document as well as a picture. Drawn by an `<img>` or a CSS
 * background it is inert, but opened directly (a link, a new tab, an image URL
 * pasted into the address bar) its `<script>` runs as this app: same origin,
 * same-origin writes, the cue routes' browser exemption. Layout and branding
 * images are uploaded by anyone on the LAN. This policy makes such a document a
 * sandboxed one that runs nothing; a policy on an image that an `<img>` loads
 * is ignored, so nothing that draws the image changes. Inline styles and
 * embedded raster images stay, because exported logos lean on both.
 */
const STORED_IMAGE_POLICY = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; sandbox";

/**
 * The headers for serving a stored image. Every route that answers with one
 * goes through here, so none can serve an upload without the policy above.
 * Sent whatever the type: the rule should not rest on the extension a file was
 * saved under, and on a PNG it costs nothing.
 */
export function storedImageHeaders(mime: string, cacheControl: string): Record<string, string> {
  return { "Content-Type": mime, "Cache-Control": cacheControl, "Content-Security-Policy": STORED_IMAGE_POLICY };
}

export type RasterKind = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/** The raster format `bytes` are, by their magic number, or null for none of the four. */
export function imageKind(bytes: Uint8Array): RasterKind | null {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

/**
 * Do the bytes actually look like the format the data URL claimed?
 *
 * Base64 decoding does not fail on rubbish — Node drops invalid characters, so a
 * mangled string still yields bytes and would be stored and later served as an
 * image. Checking the magic number is what turns that into a rejection.
 */
function looksLike(mime: string, bytes: Buffer): boolean {
  // Text, not binary — an XML declaration or the root element, comments aside.
  if (mime === "image/svg+xml") return /^\s*(<\?xml|<!--|<svg)/i.test(bytes.subarray(0, 256).toString("utf8"));
  return imageKind(bytes) === mime;
}

/** The first 16 hex digits of the SHA-256 of `data`: a short, stable name or
 *  fingerprint for content (a stored file, a published document). */
export function hash16(data: string | Uint8Array): string {
  return crypto.createHash("sha256").update(data).digest("hex").slice(0, 16);
}

/** The name saveImage gives `bytes`: their hash16 and the extension. Exported
 *  for a folder of content-addressed files that are not images (stage-plot PDF
 *  originals), so the naming rule lives in one place. */
export function contentName(bytes: Buffer, ext: string): string {
  return `${hash16(bytes)}.${ext}`;
}

/** The extensions saveImage writes. */
const SAVED_EXTS = new Set(Object.values(EXT_BY_MIME));

/** Whether saving an image checks its bytes look like its type. Branding
 *  images do; layout images never have, so files already stored there may not
 *  pass, and nothing may hold them to it after the fact. */
export interface ContentRule {
  checkContent: boolean;
}

/**
 * Why `bytes` under `file` is not an image saveImage could have written with
 * `rule`, or null: a name it would give (the content hash and one of its
 * extensions), a size within the cap, and — where the rule checks content —
 * bytes that look like the type the name says. What a config restore and a view
 * import hold every image in a bundle to before writing any.
 */
export function storedImageProblem(file: string, bytes: Buffer, rule: ContentRule): string | null {
  const ext = /^[0-9a-f]{16}\.([a-z]+)$/.exec(file)?.[1];
  if (!ext || !SAVED_EXTS.has(ext)) return "is not the name of a stored image";
  if (bytes.length === 0) return "is empty";
  if (bytes.length > MAX_IMAGE_BYTES) return `is too large (max ${megabytes(MAX_IMAGE_BYTES)})`;
  if (rule.checkContent && !looksLike(MIME_BY_EXT[ext]!, bytes)) return `is not a valid ${ext} image`;
  if (contentName(bytes, ext) !== file) return "does not match its contents";
  return null;
}

/** The type a stored image name says, or undefined for a name that is not one. */
export function mimeOfStoredName(file: string): string | undefined {
  return /^[0-9a-f]{16}\.[a-z]+$/.test(file) ? MIME_BY_EXT[file.split(".").pop()!] : undefined;
}

export function imageDir(name: string): string {
  return path.join(getUserDataPath(), name);
}

/** True for a `data:image/…;base64,…` URL — i.e. bytes that still need storing. */
export function isDataUrl(v: unknown): v is string {
  return typeof v === "string" && v.startsWith("data:image/");
}

/**
 * Persist a base64 data URL into `<data>/<dirName>/` under a content hash.
 * Returns the `/<dirName>/<hash>.<ext>` reference to store in place of the bytes.
 */
export async function saveImage(dirName: string, dataUrl: string, rule: ContentRule = { checkContent: true }): Promise<string> {
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec((dataUrl ?? "").trim());
  if (!m) throw new Error("expected a base64 data:image/… URL");
  const ext = EXT_BY_MIME[m[1].toLowerCase()];
  if (!ext) throw new Error(`unsupported image type: ${m[1]}`);
  return `/${dirName}/${await saveImageBytes(dirName, Buffer.from(m[2], "base64"), ext, rule)}`;
}

/**
 * Persist image bytes into `<data>/<dirName>/` under a content hash, for an
 * upload that arrives as bytes rather than a data URL. `ext` is one saveImage
 * writes. Returns the file name, `<hash>.<ext>`.
 */
export async function saveImageBytes(dirName: string, bytes: Buffer, ext: string, rule: ContentRule = { checkContent: true }): Promise<string> {
  const mime = SAVED_EXTS.has(ext) ? MIME_BY_EXT[ext] : undefined;
  if (!mime) throw new Error(`unsupported image type: ${ext}`);
  if (bytes.length === 0) throw new Error("empty image");
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`image too large (max ${megabytes(MAX_IMAGE_BYTES)})`);
  if (rule.checkContent && !looksLike(mime, bytes)) throw new Error(`not a valid ${mime} image`);

  const file = contentName(bytes, ext);
  const d = imageDir(dirName);
  await fs.mkdir(d, { recursive: true });
  await atomicWrite(path.join(d, file), bytes);
  return file;
}

/** Read a stored image for serving. `file` is untrusted — anything with a path
 *  separator or an unknown extension is refused rather than read. */
export async function readImage(
  dirName: string,
  file: string,
): Promise<{ data: Buffer; mime: string } | null> {
  if (!/^[A-Za-z0-9._-]+$/.test(file) || file.includes("..")) return null;
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  const mime = MIME_BY_EXT[ext];
  if (!mime) return null;
  try {
    return { data: await fs.readFile(path.join(imageDir(dirName), file)), mime };
  } catch (err) {
    // Only a missing file is "no such image". One that is there and cannot be
    // read throws: a backup that took it for absent left it out and said it
    // had succeeded.
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** Every stored file in a directory, for backup or pruning. Throws when the
 *  directory is there and cannot be read, for the reason readImage does. */
export async function listImages(dirName: string): Promise<string[]> {
  try {
    // Not a write in flight: atomicWrite's scratch file is a dotfile beside the image.
    return (await fs.readdir(imageDir(dirName))).filter((f) => !f.startsWith("."));
  } catch (err) {
    if (isNotFound(err)) return []; // nothing stored yet
    throw err;
  }
}

/** Write bytes back under a known name — used when restoring a backup. Refuses a
 *  name that is not content-addressed-looking, so a bundle cannot write anywhere. */
export async function restoreImage(dirName: string, file: string, data: Buffer): Promise<boolean> {
  if (!/^[A-Za-z0-9._-]+$/.test(file) || file.includes("..")) return false;
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  if (!MIME_BY_EXT[ext]) return false;
  const d = imageDir(dirName);
  await fs.mkdir(d, { recursive: true });
  await atomicWrite(path.join(d, file), data);
  return true;
}
