// layout-image-store.ts — Stores images uploaded for custom-layout "image" objects
// as files in the data dir, referenced by a short URL. Keeping the bytes out of the
// layout JSON matters: layouts ride inside stage:state, which is broadcast to every
// display — a base64 image there would bloat every push. The layout only holds
// "/layout-images/<hash>.<ext>"; the file is served + cached like any static asset.

import * as fs from "fs/promises";
import * as path from "path";

import type { LayoutObject } from "../types/stage.js";
import { viewsStore } from "./views-store.js";
import { layoutTemplatesStore } from "./layout-templates-store.js";
import { layoutGroupsStore } from "./layout-groups-store.js";
import { MAX_IMAGE_BYTES, imageDir, mimeOfStoredName, saveImage, storedImageProblem, type ContentRule } from "./image-files.js";
import { atomicWrite } from "./write-queue.js";
import { errorMessage, isNotFound } from "./errors.js";

/** The folder under the data directory the images live in. */
export const LAYOUT_IMAGE_DIR = "layout-images";

/** See image-files.ts — exported for the same reason. One cap for both folders. */
export const MAX_LAYOUT_IMAGE_BYTES = MAX_IMAGE_BYTES;

/** Layout uploads have never had their bytes checked against their type (see
 *  ContentRule); serving is what keeps one inert (nosniff, the sandbox CSP). */
export const LAYOUT_IMAGE_RULE: ContentRule = { checkContent: false };

function dir(): string {
  return imageDir(LAYOUT_IMAGE_DIR);
}

/** Persist a `data:image/…;base64,…` URL as a content-hashed file. Identical images
 *  dedup to the same name. Returns the "/layout-images/<hash>.<ext>" reference. */
export async function saveLayoutImage(dataUrl: string): Promise<string> {
  return saveImage(LAYOUT_IMAGE_DIR, dataUrl, LAYOUT_IMAGE_RULE);
}

/**
 * Persist image bytes that arrived in an import bundle.
 *
 * The filename is content-addressed, so it is VERIFIED rather than trusted: a
 * bundle is a file off somebody's laptop, and a name that disagrees with its
 * bytes would either overwrite an unrelated image or plant one under a name a
 * layout already points at. Returns true when a new file was written, false
 * when that hash was already here — which is how a shared logo collapses to one
 * file instead of duplicating.
 */
export async function saveLayoutImageBytes(file: string, bytes: Buffer): Promise<boolean> {
  const problem = storedImageProblem(file, bytes, LAYOUT_IMAGE_RULE);
  if (problem) throw new Error(`layout image ${file} ${problem}`);

  const d = dir();
  await fs.mkdir(d, { recursive: true });
  const full = path.join(d, file);
  // Same hash means same bytes, so a file that is already here is left alone. It is
  // only ever there whole: it is written aside and renamed into place, because a
  // truncated one under the final name would be taken for the image by this check
  // and served as it was.
  try {
    await fs.access(full);
    return false;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  await atomicWrite(full, bytes);
  return true;
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
    // Strict: a store that cannot be read is served as its defaults, which
    // reference nothing, and every image would be pruned as an orphan.
    for (const v of await viewsStore.loadStrict()) collectRefs(v.layout?.objects, refs);
    for (const t of await layoutTemplatesStore.loadStrict()) collectRefs(t.layout?.objects, refs);
    for (const g of await layoutGroupsStore.loadStrict()) collectRefs(g.object ? [g.object] : [], refs);
  } catch (err) {
    // Never risk deleting a referenced image. Said, because a prune that never
    // runs is otherwise invisible.
    console.warn("[layout-images] prune skipped, a layout store could not be read:", errorMessage(err));
    return 0;
  }
  let files: string[];
  try {
    files = await fs.readdir(dir());
  } catch (err) {
    // No directory yet is nothing to prune; one that cannot be listed is said.
    if (!isNotFound(err)) {
      console.warn("[layout-images] prune skipped, the image directory could not be read:", errorMessage(err));
    }
    return 0;
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
  const mime = mimeOfStoredName(file);
  if (!mime) return null;
  try {
    const data = await fs.readFile(path.join(dir(), file));
    return { data, mime };
  } catch {
    return null;
  }
}
