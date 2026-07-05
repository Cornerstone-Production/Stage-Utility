// layout-image-store.ts — Stores images uploaded for custom-layout "image" objects
// as files in the data dir, referenced by a short URL. Keeping the bytes out of the
// layout JSON matters: layouts ride inside stage:state, which is broadcast to every
// display — a base64 image there would bloat every push. The layout only holds
// "/layout-images/<hash>.<ext>"; the file is served + cached like any static asset.

import * as crypto from "node:crypto";
import * as fs from "fs/promises";
import * as path from "path";

import type { LayoutObject } from "../types/stage.js";
import { getUserDataPath } from "./app-paths.js";
import { viewsStore } from "./views-store.js";
import { layoutTemplatesStore } from "./layout-templates-store.js";
import { layoutGroupsStore } from "./layout-groups-store.js";

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

// Don't reap a file newer than this — an image can be uploaded and referenced only
// in the editor draft before the layout is saved, so recent files may not yet appear
// in any store.
const PRUNE_GRACE_MS = 6 * 60 * 60 * 1000;

/** Collect referenced "/layout-images/<file>" names from a layout's objects (recursive). */
function collectRefs(objs: LayoutObject[] | undefined, into: Set<string>): void {
  for (const o of objs ?? []) {
    const cfg = o.config as { type?: string; src?: string };
    if (cfg?.type === "image" && typeof cfg.src === "string") {
      const m = /\/layout-images\/([^/?#]+)/.exec(cfg.src);
      if (m) into.add(m[1]);
    }
    if (o.children?.length) collectRefs(o.children, into);
  }
}

/** Delete stored images no longer referenced by any View / layout template / group
 *  (and older than the grace window). Returns how many were removed. */
export async function pruneLayoutImages(): Promise<number> {
  const refs = new Set<string>();
  try {
    for (const v of await viewsStore.load()) collectRefs(v.layout?.objects, refs);
    for (const t of await layoutTemplatesStore.load()) collectRefs(t.layout?.objects, refs);
    for (const g of await layoutGroupsStore.load()) collectRefs(g.object ? [g.object] : [], refs);
  } catch {
    return 0; // couldn't read a store — never risk deleting a referenced image
  }
  let files: string[];
  try {
    files = await fs.readdir(dir());
  } catch {
    return 0; // no dir yet
  }
  const now = Date.now();
  let removed = 0;
  for (const f of files) {
    if (refs.has(f)) continue;
    try {
      const st = await fs.stat(path.join(dir(), f));
      if (now - st.mtimeMs < PRUNE_GRACE_MS) continue; // recent (maybe unsaved) — keep
      await fs.rm(path.join(dir(), f), { force: true });
      removed++;
    } catch {
      /* ignore */
    }
  }
  if (removed) console.log(`[layout-images] pruned ${removed} orphaned image(s)`);
  return removed;
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
