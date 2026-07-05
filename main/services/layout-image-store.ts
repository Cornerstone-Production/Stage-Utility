// layout-image-store.ts — Stores images uploaded for custom-layout "image" objects
// as files in the data dir, referenced by a short URL. Keeping the bytes out of the
// layout JSON matters: layouts ride inside stage:state, which is broadcast to every
// display — a base64 image there would bloat every push. The layout only holds
// "/layout-images/<hash>.<ext>"; the file is served + cached like any static asset.

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
const MAX_BYTES = 12 * 1024 * 1024; // 12 MB

function dir(): string {
  return path.join(getUserDataPath(), "layout-images");
}

/** Persist a `data:image/…;base64,…` URL as a content-hashed file. Identical images
 *  dedup to the same name. Returns the "/layout-images/<hash>.<ext>" reference. */
export async function saveLayoutImage(dataUrl: string): Promise<string> {
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec((dataUrl ?? "").trim());
  if (!m) throw new Error("expected a base64 data:image/… URL");
  const ext = EXT_BY_MIME[m[1].toLowerCase()];
  if (!ext) throw new Error(`unsupported image type: ${m[1]}`);
  const bytes = Buffer.from(m[2], "base64");
  if (bytes.length === 0) throw new Error("empty image");
  if (bytes.length > MAX_BYTES) throw new Error("image too large (max 12 MB)");
  const hash = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const file = `${hash}.${ext}`;
  const d = dir();
  await fs.mkdir(d, { recursive: true });
  await fs.writeFile(path.join(d, file), bytes);
  return `/layout-images/${file}`;
}

/** Read a stored layout image for serving. Only our hashed names are accepted (no
 *  path traversal). Returns null when missing/invalid. */
export async function readLayoutImage(file: string): Promise<{ data: Buffer; mime: string } | null> {
  if (!/^[a-f0-9]{16}\.[a-z]+$/.test(file)) return null;
  const mime = MIME_BY_EXT[file.split(".").pop() as string];
  if (!mime) return null;
  try {
    const data = await fs.readFile(path.join(dir(), file));
    return { data, mime };
  } catch {
    return null;
  }
}
