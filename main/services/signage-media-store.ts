// signage-media-store.ts — the signage media library: a manifest of records
// beside content-addressed files on disk.
//
// Same shape as layout-image-store: the bytes stay out of the JSON, because a
// playlist rides inside the resolved horizon that is broadcast to every display,
// and a base64 video there would be absurd. The manifest holds
// "<sha256-16>.<ext>"; the file is served like any other static asset, with
// immutable caching — safe precisely because the name IS the hash, so the bytes
// at a name can never change.
//
// Where it differs from layout images: files here can be 200 MB, so nothing in
// this module ever reads a whole upload into memory. Writing is
// signage-upload.ts's job and it streams.

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  MAX_ITEM_MS,
  MAX_MEDIA_DIMENSION,
  MIN_ITEM_MS,
  SIGNAGE_EXTS,
  type SignageMedia,
  isSignageVideo,
  SIGNAGE_HASH_HEX_LEN,
  SIGNAGE_MIME_BY_EXT,
} from "../types/signage.js";
import { getUserDataPath } from "./app-paths.js";
import { DataStore } from "./data-store.js";

/** Directory under the data dir. Exported because config-snapshot allowlists it
 *  and signage-upload writes into it. */
export const SIGNAGE_MEDIA_DIR = "signage-media";

export const signageMediaStore = new DataStore<SignageMedia[]>(
  "signage-media.json",
  [],
  "config",
);

function dir(): string {
  return path.join(getUserDataPath(), SIGNAGE_MEDIA_DIR);
}

/**
 * Only names this app wrote.
 *
 * Built from the mime allowlist rather than a second hand-written list: the two
 * drifting is how an upload succeeds and the file it just wrote can never be
 * served back. Lower-case hex only, so a name is either exactly what the hasher
 * produces or it is refused.
 */
const MEDIA_NAME = new RegExp(`^[0-9a-f]{${SIGNAGE_HASH_HEX_LEN}}\\.(${SIGNAGE_EXTS.join("|")})$`);

export function isMediaFileName(file: string): boolean {
  return MEDIA_NAME.test(file);
}

/**
 * Range-check what the browser measured and hand back the stored form.
 *
 * THROWS rather than defaulting. These arrive as request headers from a page, so
 * they are untrusted, but the reason for rejecting is not security — it is that
 * a wrong value is silently wrong on a wall. A zero or absent duration makes a
 * playlist's cycle length unusable, and Infinity (which a live stream or a
 * malformed container reports, and which survives Math.round) would become an
 * item that never ends.
 */
export function clampMeasured(o: {
  w: unknown;
  h: unknown;
  durationMs?: unknown;
  mime: string;
}): { w: number; h: number; durationMs?: number } {
  const finite = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) ? Math.round(v) : NaN;

  const w = finite(o.w);
  const h = finite(o.h);
  if (!(w >= 1 && w <= MAX_MEDIA_DIMENSION) || !(h >= 1 && h <= MAX_MEDIA_DIMENSION)) {
    throw new Error(`dimension out of range: ${String(o.w)} x ${String(o.h)}`);
  }
  if (!isSignageVideo(o.mime)) return { w, h };

  const d = finite(o.durationMs);
  if (!(d >= MIN_ITEM_MS && d <= MAX_ITEM_MS)) {
    throw new Error(`duration out of range for a video: ${String(o.durationMs)}`);
  }
  return { w, h, durationMs: d };
}

export async function listMedia(): Promise<SignageMedia[]> {
  return signageMediaStore.load();
}

/**
 * Record an already-written file in the manifest.
 *
 * Deduplicates on `file`. The name is the hash of the content, so the same file
 * twice is the same content and a second record would be a lie — it would let
 * deleting either copy look like it freed the bytes, and would show a library
 * full of phantom duplicates. The FIRST name the operator gave it wins, because
 * the second upload is the accident.
 */
export async function addMedia(o: {
  file: string;
  name: string;
  mime: string;
  bytes: number;
  w: number;
  h: number;
  durationMs?: number;
}): Promise<{ media: SignageMedia; deduped: boolean }> {
  if (!isMediaFileName(o.file)) throw new Error(`not a signage media name: ${o.file}`);

  let result: { media: SignageMedia; deduped: boolean } | null = null;
  await signageMediaStore.update((all) => {
    const existing = all.find((m) => m.file === o.file);
    if (existing) {
      result = { media: existing, deduped: true };
      return all;
    }
    const media: SignageMedia = {
      // Not crypto.randomUUID: prod is served over plain HTTP and this module is
      // shared with code paths that also run in the renderer's origin.
      id: `sm-${crypto.randomBytes(8).toString("hex")}`,
      file: o.file,
      name: o.name,
      mime: o.mime,
      bytes: o.bytes,
      w: o.w,
      h: o.h,
      ...(o.durationMs === undefined ? {} : { durationMs: o.durationMs }),
      createdAt: new Date().toISOString(),
    };
    result = { media, deduped: false };
    return [...all, media];
  });

  if (!result) throw new Error("media store update did not produce a record");
  return result;
}

export async function renameMedia(id: string, name: string): Promise<SignageMedia | null> {
  let found: SignageMedia | null = null;
  await signageMediaStore.update((all) =>
    all.map((m) => {
      if (m.id !== id) return m;
      found = { ...m, name };
      return found;
    }),
  );
  return found;
}

/**
 * Remove a record.
 *
 * The FILE is deliberately left behind for pruneSignageMedia to reap later. Two
 * records can never share a file (addMedia dedupes), but a delete immediately
 * followed by a re-upload of the same image is common, and unlinking here would
 * throw away bytes that are about to be wanted again.
 */
export async function deleteMedia(id: string): Promise<SignageMedia | null> {
  let removed: SignageMedia | null = null;
  await signageMediaStore.update((all) =>
    all.filter((m) => {
      if (m.id !== id) return true;
      removed = m;
      return false;
    }),
  );
  return removed;
}

/**
 * Locate a stored file, WITHOUT reading it.
 *
 * What the serving route uses, so a video is piped off disk instead of being
 * held in memory. Buffering it meant a 200 MB clip became 200 MB of heap per
 * request, and a wall of seven displays coming up together after a power cut
 * asks for it seven times at once — a gigabyte on a Pi with two, over a file the
 * kernel would happily have streamed.
 *
 * The NAME is the whole check and it runs before any lookup, so traversal is
 * refused without consulting the manifest at all. Returns null rather than
 * throwing: every caller is answering an HTTP request and wants a 404.
 */
export async function statMediaFile(
  file: string,
): Promise<{ path: string; mime: string; bytes: number } | null> {
  if (!isMediaFileName(file)) return null;
  const full = path.join(dir(), file);
  let bytes: number;
  try {
    const st = await fs.stat(full);
    if (!st.isFile()) return null;
    bytes = st.size;
  } catch {
    return null;
  }
  const all = await listMedia().catch(() => [] as SignageMedia[]);
  const rec = all.find((m) => m.file === file);
  // Trust the manifest's mime over the extension where we have a record: it is
  // what the uploader declared and what the allowlist was checked against.
  return { path: full, mime: rec?.mime ?? mimeForExt(file), bytes };
}

/**
 * Read a stored file whole.
 *
 * For the config snapshot, which needs the bytes to base64 them and only ever
 * asks for files under its own size cap. Serving goes through statMediaFile.
 *
 * The NAME is the whole check and it runs before any lookup, so traversal is
 * refused without consulting the manifest at all. Returns null rather than
 * throwing: every caller is answering an HTTP request and wants a 404.
 */
export async function readMediaFile(
  file: string,
): Promise<{ data: Buffer; mime: string } | null> {
  if (!isMediaFileName(file)) return null;
  const all = await listMedia().catch(() => [] as SignageMedia[]);
  const rec = all.find((m) => m.file === file);
  try {
    const data = await fs.readFile(path.join(dir(), file));
    // Trust the manifest's mime over the extension where we have a record: it is
    // what the uploader declared and what the allowlist was checked against.
    return { data, mime: rec?.mime ?? mimeForExt(file) };
  } catch {
    return null;
  }
}

function mimeForExt(file: string): string {
  const ext = file.slice(file.lastIndexOf(".") + 1);
  // From the DERIVED map. This was a six-arm switch that was
  // SIGNAGE_EXT_BY_MIME written backwards, which is the exact drift the comment
  // above SIGNAGE_EXTS warns about: the two disagreeing is how an upload
  // succeeds and the file it wrote can never be served back.
  const mime = SIGNAGE_MIME_BY_EXT[ext];
  // Unreachable while MEDIA_NAME is derived from the allowlist. If that ever
  // stops being true, refuse rather than guess a type for bytes we serve.
  if (!mime) throw new Error(`no mime for signage media extension: ${ext}`);
  return mime;
}

/**
 * Write media bytes that arrived in a config snapshot.
 *
 * The name is VERIFIED against the bytes rather than trusted: a bundle is a file
 * off somebody's laptop, and a name disagreeing with its contents would either
 * overwrite an unrelated file or plant one under a name a playlist already
 * points at.
 *
 * Returns true when a new file was written, false when those exact bytes were
 * already here — which is how a shared graphic collapses to one file.
 */
export async function restoreMediaFile(file: string, bytes: Buffer): Promise<boolean> {
  // isMediaFileName, not a SECOND pattern: this file had two answers to "is
  // this a media filename", one of which also re-listed the extensions.
  if (!isMediaFileName(file)) throw new Error(`not a signage media name: ${file}`);
  if (bytes.length === 0) throw new Error("empty media file");

  const hash = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, SIGNAGE_HASH_HEX_LEN);
  if (hash !== file.slice(0, SIGNAGE_HASH_HEX_LEN)) {
    throw new Error(`${file} does not match its contents`);
  }

  const d = dir();
  await fs.mkdir(d, { recursive: true });
  try {
    // wx: same hash means same bytes, so there is nothing to write and nothing
    // to overwrite.
    await fs.writeFile(path.join(d, file), bytes, { flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

/**
 * Don't reap a file newer than this.
 *
 * An upload can exist on disk and be referenced only by an unsaved playlist
 * draft in somebody's browser, so a recent file may legitimately appear in no
 * store yet.
 */
const PRUNE_GRACE_MS = 6 * 60 * 60 * 1000;

/**
 * Delete files no store references any more.
 *
 * Returns 0 WITHOUT deleting anything if a store read fails: a manifest we could
 * not read is not evidence that nothing is referenced, and the cost of guessing
 * wrong is an operator's media library.
 *
 * BOTH sources count. A file is referenced if the manifest still lists it (the
 * operator has not deleted the record) or if any playlist points at a record
 * holding it. Reading only one of the two is how a file still on screen gets
 * reaped.
 */
export async function pruneSignageMedia(): Promise<number> {
  let referenced: Set<string>;
  try {
    const [all, playlists] = await Promise.all([
      signageMediaStore.load(),
      // Imported lazily: the playlists store does not otherwise need to be in
      // this module's import graph, and a cycle here would be silent.
      import("./signage-playlists-store.js").then((m) => m.listPlaylists()),
    ]);
    const byId = new Map(all.map((m) => [m.id, m.file]));
    referenced = new Set(all.map((m) => m.file));
    for (const p of playlists) {
      for (const item of p.items) {
        const file = byId.get(item.mediaId);
        if (file) referenced.add(file);
      }
    }
  } catch (err) {
    console.error("[signage-media] could not read a store; pruning nothing:", err);
    return 0;
  }

  let files: string[];
  try {
    files = await fs.readdir(dir());
  } catch {
    return 0; // no directory yet
  }

  const now = Date.now();
  let removed = 0;
  for (const f of files) {
    if (referenced.has(f)) continue;
    if (!isMediaFileName(f)) continue; // never touch anything we did not write
    try {
      const st = await fs.stat(path.join(dir(), f));
      if (now - st.mtimeMs < PRUNE_GRACE_MS) continue;
      await fs.rm(path.join(dir(), f), { force: true });
      removed++;
    } catch (err) {
      console.error(`[signage-media] could not prune ${f}:`, err);
    }
  }
  if (removed) console.log(`[signage-media] pruned ${removed} unreferenced file(s)`);
  return removed;
}
