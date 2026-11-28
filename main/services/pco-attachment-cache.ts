// Caches PCO plan attachments to disk under userData/cache/attachments/, keyed by
// the attachment id AND the file's version (see attachmentVersion). PCO only hands
// out short-lived S3 links, so we download once on first request and reuse the
// file for every kiosk display — and for every week the same plan is loaded.
//
// The version is there because it is not known that Planning Center gives a
// re-uploaded file a new id. Keyed by id alone, a stage plot replaced on the same
// plan would be served from the old bytes for as long as the file stayed on disk.
// With the version in the name a replaced file is a different file, downloaded
// fresh, and the older versions of that id are removed once it is written.
//
// Two things a cache miss has to survive, both measured on a live server:
//   * The signed link dies before we expect it to. Measured 2026-09-03 against a
//     live plan, a link worked at +1, +2 and +3 minutes and answered HTTP 403 at
//     +4 — so a download can fail on a link we still believe is good. A 401/403
//     re-opens the attachment once and retries.
//   * Two surfaces miss at the same instant. The layout editor and an open stage
//     display both request a fresh stage plot; without dedupe both download and
//     both write the same path, and a third reader can read a half-written file.
//     Work is deduped per cache path and written to a temp file + renamed, so the
//     final path only ever exists complete.

import * as fs from "fs/promises";
import * as path from "path";

import { getUserDataPath } from "./app-paths.js";
import { pruneCacheDir } from "./cache-prune.js";
import { commitPart, downloadWatchdog, streamToPart } from "./capped-download.js";
import { errorMessage } from "./errors.js";
import { plural } from "./plural.js";
import { OutageLog } from "./repeat-log.js";
import { scrub } from "./scrub.js";

// Attachments (PDFs/images) are larger but rarely change; keep ~90 days, 500 MB.
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_BYTES = 500 * 1024 * 1024;

/** The largest attachment kept. Stage plots and charts are a few MB; this is the
 *  ceiling against a link that serves something else, counted from the bytes that
 *  arrive, never from a declared length. */
export const ATTACHMENT_MAX_BYTES = 100 * 1024 * 1024;

/** How long a download may go quiet, and how long it may take at all. A signed
 *  link that stalls would otherwise hold its request, and every later request for
 *  the same file (they share the in-flight promise), until a restart. */
export interface AttachmentLimits {
  maxBytes: number;
  idleMs: number;
  totalMs: number;
}
const DEFAULT_LIMITS: AttachmentLimits = { maxBytes: ATTACHMENT_MAX_BYTES, idleMs: 30_000, totalMs: 10 * 60_000 };

let cacheDir: string | null = null;

async function getCacheDir(): Promise<string> {
  if (!cacheDir) {
    cacheDir = path.join(getUserDataPath(), "cache", "attachments");
    await fs.mkdir(cacheDir, { recursive: true });
  }
  return cacheDir;
}

/** Best-effort file extension from the MIME type, falling back to the filename. */
function extFor(contentType: string | null, filename: string): string {
  const ct = (contentType ?? "").toLowerCase();
  if (ct.includes("pdf")) return "pdf";
  if (ct.includes("png")) return "png";
  if (ct.includes("jpeg") || ct.includes("jpg")) return "jpg";
  if (ct.includes("gif")) return "gif";
  if (ct.includes("webp")) return "webp";
  const m = filename.match(/\.(\w{2,5})$/);
  return m ? m[1].toLowerCase() : "bin";
}

/** Evict stale/oversized cached attachments. Safe — pruned files re-download on demand. */
export async function pruneAttachmentCache(): Promise<void> {
  const dir = await getCacheDir();
  const r = await pruneCacheDir(dir, { maxAgeMs: MAX_AGE_MS, maxBytes: MAX_BYTES });
  if (r.removed > 0) {
    console.log(`[attachment-cache] pruned ${r.removed} file(s), freed ${(r.freedBytes / 1e6).toFixed(1)} MB`);
  }
}

/** MIME type to serve a cached attachment with, from its extension. */
export function mimeForExt(ext: string): string {
  switch (ext) {
    case "pdf": return "application/pdf";
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    default: return "application/octet-stream";
  }
}

type CachedFile = { path: string; ext: string };

/**
 * What says a file under one attachment id has changed: Planning Center's
 * `updated_at` as milliseconds, else the file size, else "" (nothing to tell
 * versions apart by, so the id alone names the file). Only `[a-z0-9]`, so it is
 * safe in a file name and in an ETag.
 */
export function attachmentVersion(updatedAt: string | null, fileSizeBytes: number | null): string {
  if (updatedAt) {
    const ms = Date.parse(updatedAt);
    if (Number.isFinite(ms)) return `t${Math.trunc(ms)}`;
  }
  if (typeof fileSizeBytes === "number" && Number.isFinite(fileSizeBytes)) return `s${Math.trunc(fileSizeBytes)}`;
  return "";
}

/** The ETag of one attachment at one version. Strong: the bytes for a given id
 *  and version never change. */
export function attachmentEtag(id: string, version: string): string {
  return `"${safeName(id)}${version ? `.${safeName(version)}` : ""}"`;
}

/** Does an If-None-Match header name `etag`? Weak validators and `*` count. */
export function etagMatches(header: string | string[] | undefined, etag: string): boolean {
  if (header === undefined) return false;
  const list = (Array.isArray(header) ? header.join(",") : header).split(",");
  return list.some((t) => {
    const v = t.trim();
    return v === "*" || v.replace(/^W\//, "") === etag;
  });
}

function safeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "");
}

/**
 * Attachments that will not download, said once per outage. A display asks again
 * for a file it could not get, so one refused or failing attachment used to write a
 * line, and for a thrown error a stack, for every request from every display.
 * Keyed by attachment id, with the reason as the kind: a new reason for the same
 * file is news, the same one is not, and a success that holds ends the run with
 * one "loading again" line.
 */
const outage = new OutageLog();

function reportFailure(id: string, filename: string, reason: string): void {
  const d = outage.fail(id, reason, Date.now());
  if (d.log) {
    console.error(`[attachment-cache] could not get "${scrub(filename)}" (attachment ${scrub(id)}): ${scrub(reason)}${scrub(d.note)}`);
  }
}

function reportRecovered(id: string, filename: string): void {
  const d = outage.ok(id, Date.now());
  if (d.log) console.log(`[attachment-cache] "${scrub(filename)}" (attachment ${scrub(id)}) is downloading again${scrub(d.note)}`);
}

/** Downloads in flight, keyed by cache file path, so concurrent misses share one. */
const inFlight = new Map<string, Promise<CachedFile | null>>();

/** Delete every other cached version of one attachment id (`<safe>.…`), now that
 *  the current one is complete. Returns what it could not do, or null: it is only
 *  disk space, the age sweep takes the rest in the end, and the file just written
 *  is good whatever happens here. */
async function removeOtherVersions(dir: string, safe: string, keep: string): Promise<string | null> {
  if (!safe) return null; // no id to prefix by: the prefix would be "." and match scratch files
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    return `could not look for older copies (${errorMessage(err)})`;
  }
  let failed = 0;
  for (const name of names) {
    const full = path.join(dir, name);
    if (full === keep || !name.startsWith(`${safe}.`)) continue;
    try {
      await fs.rm(full, { force: true });
    } catch {
      failed += 1;
    }
  }
  return failed > 0 ? `could not remove ${plural(failed, "older copy", "older copies")}` : null;
}

/** Download to a private part file, then rename onto `filePath` — readers only
 *  ever see a complete file, and two racing writers cannot interleave. The body is
 *  read as a stream under a size cap and an idle/total watchdog. */
async function download(
  id: string,
  filename: string,
  filePath: string,
  ext: string,
  openUrl: (opts?: { fresh?: boolean }) => Promise<string>,
  limits: AttachmentLimits,
): Promise<CachedFile | null> {
  const watchdog = downloadWatchdog({ idleMs: limits.idleMs, totalMs: limits.totalMs });
  // Asking PCO for the link is part of the download: a hung open is abandoned by the
  // same watchdog, and an answer that took a while is not held against the transfer.
  const open = async (opts?: { fresh?: boolean }): Promise<string> => {
    const aborted = new Promise<never>((_, reject) => {
      const fail = (): void => reject(watchdog.signal.reason);
      if (watchdog.signal.aborted) fail();
      else watchdog.signal.addEventListener("abort", fail, { once: true });
    });
    const url = await Promise.race([openUrl(opts), aborted]);
    watchdog.touch();
    return url;
  };
  try {
    let resp = await fetch(await open(), { signal: watchdog.signal });
    if (resp.status === 401 || resp.status === 403) {
      // The cached signed link expired ahead of its TTL; one re-open, one retry.
      // Said while the file is still downloading, not while it is already in a
      // failing run: a link that is dead every time would otherwise add this line
      // to the one outage line on every request from every display.
      if (!outage.failing(id)) console.warn(`[attachment-cache] link for ${scrub(id)} rejected (HTTP ${resp.status}); re-opening`);
      await resp.body?.cancel().catch(() => {});
      resp = await fetch(await open({ fresh: true }), { signal: watchdog.signal });
    }
    if (!resp.ok) {
      await resp.body?.cancel().catch(() => {});
      reportFailure(id, filename, `the download link answered HTTP ${resp.status}`);
      return null;
    }
    if (!resp.body) {
      reportFailure(id, filename, "the download link sent no body");
      return null;
    }
    // Not under the final name's prefix, so removeOtherVersions never takes it.
    const partPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.part`);
    const written = await streamToPart(resp.body, partPath, { maxBytes: limits.maxBytes, onChunk: () => watchdog.touch() });
    if (!written.ok) {
      reportFailure(id, filename, `the file is larger than ${Math.round(limits.maxBytes / (1024 * 1024))} MB; refused`);
      return null;
    }
    await commitPart(partPath, filePath);
  } finally {
    watchdog.stop();
  }
  const leftover = await removeOtherVersions(path.dirname(filePath), safeName(id), filePath);
  if (leftover) {
    console.warn(`[attachment-cache] ${scrub(leftover)} of "${scrub(filename)}"; the age sweep will`);
  }
  reportRecovered(id, filename);
  return { path: filePath, ext };
}

/**
 * Return the cached file path + extension for an attachment at `version`,
 * downloading it from a freshly-opened PCO link on first request. `openUrl` is a thunk so we only pay
 * the `open` round-trip on a cache miss; called with `{ fresh: true }` it must
 * bypass any caller-side link cache. Returns null on download failure.
 */
export async function getAttachmentFile(
  id: string,
  contentType: string | null,
  filename: string,
  openUrl: (opts?: { fresh?: boolean }) => Promise<string>,
  version = "",
  limits: AttachmentLimits = DEFAULT_LIMITS,
): Promise<CachedFile | null> {
  try {
    const dir = await getCacheDir();
    const ext = extFor(contentType, filename);
    const safe = safeName(id);
    const filePath = path.join(dir, `${safe}${version ? `.${safeName(version)}` : ""}.${ext}`);

    try {
      await fs.access(filePath);
      // A file that is on disk is working. Once the first failure has aged past
      // the settle window, this is the call that says so and closes the run: after
      // a recovery every later request is a hit here and never reaches download().
      reportRecovered(id, filename);
      return { path: filePath, ext };
    } catch {
      // Not cached yet — open + download.
    }

    const existing = inFlight.get(filePath);
    if (existing) return await existing;

    const job = download(id, filename, filePath, ext, openUrl, limits).finally(() => inFlight.delete(filePath));
    inFlight.set(filePath, job);
    return await job;
  } catch (err) {
    // The reason, not the stack: it is the same on every request until something
    // changes, and a refused id or a failed open says everything in one line.
    reportFailure(id, filename, errorMessage(err));
    return null;
  }
}
