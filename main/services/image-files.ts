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

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

/** The largest image the store will accept. Exported so the route body limits
 *  can be checked against it rather than against a copy of the number. */
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

/**
 * Do the bytes actually look like the format the data URL claimed?
 *
 * Base64 decoding does not fail on rubbish — Node drops invalid characters, so a
 * mangled string still yields bytes and would be stored and later served as an
 * image. Checking the magic number is what turns that into a rejection.
 */
function looksLike(mime: string, bytes: Buffer): boolean {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  switch (mime) {
    case "image/png":
      return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case "image/jpeg":
      return starts(0xff, 0xd8, 0xff);
    case "image/gif":
      return starts(0x47, 0x49, 0x46, 0x38);
    case "image/webp":
      return starts(0x52, 0x49, 0x46, 0x46) && bytes.subarray(8, 12).toString("ascii") === "WEBP";
    case "image/svg+xml":
      // Text, not binary — an XML declaration or the root element, comments aside.
      return /^\s*(<\?xml|<!--|<svg)/i.test(bytes.subarray(0, 256).toString("utf8"));
    default:
      return false;
  }
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
export async function saveImage(dirName: string, dataUrl: string): Promise<string> {
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec((dataUrl ?? "").trim());
  if (!m) throw new Error("expected a base64 data:image/… URL");
  const ext = EXT_BY_MIME[m[1].toLowerCase()];
  if (!ext) throw new Error(`unsupported image type: ${m[1]}`);
  const bytes = Buffer.from(m[2], "base64");
  if (bytes.length === 0) throw new Error("empty image");
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error("image too large (max 12 MB)");
  if (!looksLike(m[1].toLowerCase(), bytes)) throw new Error(`not a valid ${m[1]} image`);

  const hash = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const file = `${hash}.${ext}`;
  const d = imageDir(dirName);
  await fs.mkdir(d, { recursive: true });
  await fs.writeFile(path.join(d, file), bytes);
  return `/${dirName}/${file}`;
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
  } catch {
    return null;
  }
}

/** Every stored file in a directory, for backup or pruning. */
export async function listImages(dirName: string): Promise<string[]> {
  try {
    return await fs.readdir(imageDir(dirName));
  } catch {
    return []; // nothing stored yet
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
  await fs.writeFile(path.join(d, file), data);
  return true;
}
