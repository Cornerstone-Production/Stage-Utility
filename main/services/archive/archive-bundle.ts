// archive-bundle.ts — the data archive: export, inspect, import.
//
// Separate from the config snapshot on purpose. History is excluded from that
// bundle because restoring it onto another install would fabricate services the
// machine never ran — true when cloning onto someone else's box, not true when
// rebuilding your own, which is what this exists for. Two bundles, two file names,
// two importers, so neither can be mistaken for the other; handing one to the
// other is refused by name.
//
// Import merges and never overwrites: a serviceKey already here is skipped and
// reported. See `importArchive` for the ordering that keeps a corrupt file from
// leaving half a year behind.

import { errorMessage } from "../errors.js";
import { readFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { APP_ROOT } from "../app-root.js";

import { strToU8, unzipSync, zipSync } from "fflate";

import { getUserDataPath } from "../app-paths.js";
import { attendanceStore } from "../attendance-store.js";
import { baptismStore } from "../baptism-store.js";
import { serviceTimelineStore } from "../service-timeline-store.js";
import { splHistoryStore } from "../spl-history-store.js";
import { archiveRoot, isInside, serviceDirName } from "./archive-paths.js";
import { encodeRow, parseRows } from "../csv.js";
import {
  mergeAttendanceRecord,
  mergeCsv,
  mergeSplRecord,
  mergeTimelineRecord,
} from "./merge-records.js";

// main/services/archive/archive-bundle.ts → repo root is three levels up.
const REPO_ROOT = APP_ROOT;

export const ARCHIVE_KIND = "stage-utility-archive";
export const ARCHIVE_VERSION = 1;

/** Records keyed by serviceKey — the shape the bundle has always used, kept stable
 *  across the move to per-service files so old archives still import. */
function byKey<T extends { serviceKey: string }>(records: T[]): Record<string, T> {
  return Object.fromEntries(records.map((r) => [r.serviceKey, r]));
}

export interface ArchiveServiceMeta {
  serviceKey: string;
  serviceDate: string;
  /** Plan title, so a readout can name the service rather than show a PCO id triple. */
  label?: string | null;
  /** Raw directory inside the zip, or null when the service predates the archive. */
  dir: string | null;
}

export interface ArchiveManifest {
  kind: typeof ARCHIVE_KIND;
  version: number;
  appVersion: string;
  createdAt: string;
  services: ArchiveServiceMeta[];
}

export interface ImportPlan {
  manifest: ArchiveManifest;
  /** Not on this box at all — imported. */
  newServices: ArchiveServiceMeta[];
  /** Here already and the archive's copy matches — nothing to do, not worth a decision. */
  identicalServices: ArchiveServiceMeta[];
  /** Here already but the two copies disagree — the only case worth asking about. */
  differingServices: ArchiveServiceMeta[];
  newBaptismSessions: number;
}

/** What to do with a service this box already has.
 *  - skip    keep what is here, ignore the archive's copy (the default)
 *  - merge   fill the gaps: take what is missing, never overwrite what is here
 *  - replace discard the local copy entirely in favour of the archive's */
export type ServiceDisposition = "skip" | "merge" | "replace";

export interface ImportResult {
  added: string[];
  skipped: string[];
  merged: string[];
  replaced: string[];
  baptismSessionsAdded: number;
  /**
   * Raw archive files this import could not write, with the reason.
   *
   * A per-file failure must not abort an import whose summary records are
   * already applied — but it must not be invisible either. On a full card every
   * write throws and the operator would otherwise be told the import succeeded,
   * with the raw sample layer silently absent and the bundle possibly deleted by
   * the time anyone notices. Empty on a clean import.
   */
  rawFilesFailed: { file: string; reason: string }[];
}

function pkgVersion(): string {
  try {
    return JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** serviceKey → date + a human label, for everything this box knows about. The three
 *  keyed stores are unioned: a service may have SPL but no attendance, or vice versa. */
async function localServices(): Promise<Map<string, { serviceDate: string; label: string | null }>> {
  const out = new Map<string, { serviceDate: string; label: string | null }>();
  const put = (r: { serviceKey: string; serviceDate: string; planTitle?: string | null }) => {
    const prev = out.get(r.serviceKey);
    out.set(r.serviceKey, { serviceDate: r.serviceDate, label: prev?.label ?? r.planTitle ?? null });
  };
  for (const r of await splHistoryStore.list()) put(r);
  for (const r of await attendanceStore.list()) put(r);
  for (const r of await serviceTimelineStore.list()) put(r);
  return out;
}

async function readDirInto(root: string, prefix: string, into: Record<string, Uint8Array>): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return; // no archive dir yet — a box that has not recorded since this shipped
  }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) await readDirInto(full, `${prefix}${e.name}/`, into);
    else into[`${prefix}${e.name}`] = new Uint8Array(await fs.readFile(full));
  }
}

export async function buildArchive(): Promise<Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  await readDirInto(archiveRoot(), "archive/", files);

  // Built from the stores rather than read off disk, so the bundle format stays
  // the same shape regardless of how the stores lay themselves out. (They are one
  // file per service now; they used to be one document for all of them.)
  const encode = (v: unknown) => strToU8(JSON.stringify(v, null, 2));
  files["stores/spl-history.json"] = encode({ services: byKey(await splHistoryStore.list()) });
  files["stores/attendance-history.json"] = encode({ services: byKey(await attendanceStore.list()) });
  files["stores/service-timeline.json"] = encode({ services: byKey(await serviceTimelineStore.list()) });
  try {
    files["stores/baptism.json"] = new Uint8Array(await fs.readFile(path.join(getUserDataPath(), "baptism.json")));
  } catch {
    /* nothing recorded yet */
  }

  const local = await localServices();
  const services: ArchiveServiceMeta[] = [...local.entries()]
    .map(([serviceKey, { serviceDate, label }]) => {
      const dir = serviceDirName(serviceKey, serviceDate);
      const hasRaw = Object.keys(files).some((n) => n.startsWith(`archive/${dir}/`));
      return { serviceKey, serviceDate, label, dir: hasRaw ? dir : null };
    })
    .sort((a, b) => a.serviceDate.localeCompare(b.serviceDate) || a.serviceKey.localeCompare(b.serviceKey));

  const manifest: ArchiveManifest = {
    kind: ARCHIVE_KIND,
    version: ARCHIVE_VERSION,
    appVersion: pkgVersion(),
    createdAt: new Date().toISOString(),
    services,
  };
  files["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));

  return zipSync(files, { level: 6 });
}

/** Is this the config snapshot — plain JSON with the snapshot's kind? Read only the
 *  head: a year of config is megabytes and the marker is in the first object. */
function looksLikeConfigSnapshot(bytes: Uint8Array): boolean {
  const head = new TextDecoder().decode(bytes.subarray(0, 512));
  return head.includes('"stage-utility-config"');
}

/** Unpack + validate. Throws a readable reason rather than half-reading. */
function open(zip: Uint8Array): { files: Record<string, Uint8Array>; manifest: ArchiveManifest } {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(zip);
  } catch {
    // The realistic mistake is the config snapshot, which is a .json rather than a
    // zip and so never gets as far as the kind check below. Name it here instead of
    // leaving the operator with "not a readable zip" and nowhere to go.
    throw new Error(
      looksLikeConfigSnapshot(zip)
        ? "That is a config snapshot, not a Stage Utility data archive. Restore it under Backup & restore."
        : "That file is not a readable zip.",
    );
  }
  const raw = files["manifest.json"];
  if (!raw) throw new Error("That archive has no manifest — it was not produced by Stage Utility.");
  let manifest: ArchiveManifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new Error("That archive's manifest is unreadable.");
  }
  if (manifest.kind !== ARCHIVE_KIND) {
    throw new Error(
      manifest.kind === "stage-utility-config"
        ? "That is a config snapshot, not a Stage Utility data archive. Restore it under Backup & restore."
        : "Unrecognized file — not a Stage Utility data archive.",
    );
  }
  if (manifest.version > ARCHIVE_VERSION) {
    throw new Error(
      `That archive is version ${manifest.version}; this build reads up to ${ARCHIVE_VERSION}. Update first.`,
    );
  }
  return { files, manifest };
}

/** The shape the three keyed history stores share on disk. */
interface KeyedFile {
  services?: Record<string, { serviceKey: string }>;
}

/** The records out of a keyed store file, or none when it was absent. */
function keyedRecords(file: KeyedFile | null): { serviceKey: string }[] {
  return Object.values(file?.services ?? {});
}

/** Parse a store member, throwing rather than importing nothing from a corrupt one. */
function requireStore<T>(files: Record<string, Uint8Array>, name: string): T | null {
  const raw = files[`stores/${name}`];
  if (!raw) return null;
  try {
    return JSON.parse(new TextDecoder().decode(raw)) as T;
  } catch {
    throw new Error(`The archive's ${name} is unreadable — nothing was imported.`);
  }
}

/** Stable JSON: keys sorted at every depth, so two records that differ only in the
 *  order their producer happened to emit fields compare as equal. */
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(",")}}`;
}

/** Every record this box holds for a serviceKey, across the three keyed stores. */
async function localRecordsByKey(): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  const put = (store: string, r: { serviceKey: string }) => {
    const e = out.get(r.serviceKey) ?? {};
    e[store] = r;
    out.set(r.serviceKey, e);
  };
  for (const r of await splHistoryStore.list()) put("spl", r);
  for (const r of await attendanceStore.list()) put("attendance", r);
  for (const r of await serviceTimelineStore.list()) put("timeline", r);
  return out;
}

/** The same, for the records inside an archive. */
function archiveRecordsByKey(files: Record<string, Uint8Array>): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  const put = (store: string, r: { serviceKey: string }) => {
    const e = out.get(r.serviceKey) ?? {};
    e[store] = r;
    out.set(r.serviceKey, e);
  };
  for (const r of keyedRecords(requireStore<KeyedFile>(files, "spl-history.json"))) put("spl", r);
  for (const r of keyedRecords(requireStore<KeyedFile>(files, "attendance-history.json"))) put("attendance", r);
  for (const r of keyedRecords(requireStore<KeyedFile>(files, "service-timeline.json"))) put("timeline", r);
  return out;
}

/** What an import would do. Writes nothing. */
export async function inspectArchive(zip: Uint8Array): Promise<ImportPlan> {
  const { files, manifest } = open(zip);
  const local = await localServices();
  const services = manifest.services ?? [];

  // A service already here is not automatically uninteresting: the archive's copy
  // may hold a longer recording of the same service (a box that stayed up through
  // the whole thing, against one that restarted). Comparing content is what turns
  // "41 already here" into the one number worth acting on.
  const mine = await localRecordsByKey();
  const theirs = archiveRecordsByKey(files);
  const differs = (key: string) => canonical(mine.get(key) ?? {}) !== canonical(theirs.get(key) ?? {});

  const present = services.filter((s) => local.has(s.serviceKey));
  const localIds = new Set((await baptismStore.listSessions()).map((s) => s.id));
  const incoming = requireStore<{ sessions?: { id: string }[] }>(files, "baptism.json");

  return {
    manifest,
    newServices: services.filter((s) => !local.has(s.serviceKey)),
    identicalServices: present.filter((s) => !differs(s.serviceKey)),
    differingServices: present.filter((s) => differs(s.serviceKey)),
    newBaptismSessions: (incoming?.sessions ?? []).filter((s) => !localIds.has(s.id)).length,
  };
}

/**
 * Merge an archive into this install.
 *
 * Read and validate everything first, then write. A corrupt member found halfway
 * through must not leave half a year imported, which is the failure this ordering
 * exists to prevent — so every parse happens above the first upsert.
 */
export async function importArchive(
  zip: Uint8Array,
  opts: { mode?: ServiceDisposition; replace?: string[]; merge?: string[] } = {},
): Promise<ImportResult> {
  const { files, manifest } = open(zip);
  const local = await localServices();

  // `mode` is the choice for the whole import; the key lists are a per-service
  // override. The UI sends only the mode — one choice covers everything, and a list
  // of every key would grow past the HTTP header limit on a big archive.
  //
  // Mode applies only to services whose content actually DIFFERS. A service already
  // here and identical has nothing to merge or replace, so it stays skipped — which
  // is also what keeps the result matching the readout the operator agreed to
  // ("50 differ" must not come back as "merged 56").
  const mode = opts.mode ?? "skip";
  const explicitReplace = new Set(opts.replace ?? []);
  const explicitMerge = new Set(opts.merge ?? []);
  const mineByKey = await localRecordsByKey();
  const theirsByKey = archiveRecordsByKey(files);
  const contentDiffers = (key: string) =>
    canonical(mineByKey.get(key) ?? {}) !== canonical(theirsByKey.get(key) ?? {});
  const dispositionOf = (key: string): ServiceDisposition => {
    if (explicitReplace.has(key)) return "replace"; // replace wins over merge
    if (explicitMerge.has(key)) return "merge";
    return contentDiffers(key) ? mode : "skip";
  };
  const replace = { has: (k: string) => dispositionOf(k) === "replace" };
  const merge = { has: (k: string) => dispositionOf(k) === "merge" };

  // ── Read phase: parse every member. Throws before anything is written. ──
  // The three keyed stores share one shape: { services: { [serviceKey]: record } }.
  const spl = keyedRecords(requireStore<KeyedFile>(files, "spl-history.json"));
  const attendance = keyedRecords(requireStore<KeyedFile>(files, "attendance-history.json"));
  const timeline = keyedRecords(requireStore<KeyedFile>(files, "service-timeline.json"));
  const baptisms = requireStore<{ sessions?: { id: string }[] }>(files, "baptism.json");

  const services = manifest.services ?? [];
  const isNew = (k: string) => !local.has(k);
  const touched = services.filter((s) => isNew(s.serviceKey) || replace.has(s.serviceKey) || merge.has(s.serviceKey));
  const touchedKeys = new Set(touched.map((s) => s.serviceKey));

  const added = services.filter((s) => isNew(s.serviceKey)).map((s) => s.serviceKey);
  const replaced = services.filter((s) => !isNew(s.serviceKey) && replace.has(s.serviceKey)).map((s) => s.serviceKey);
  const merged = services.filter((s) => !isNew(s.serviceKey) && merge.has(s.serviceKey)).map((s) => s.serviceKey);
  const skipped = services
    .filter((s) => !isNew(s.serviceKey) && !replace.has(s.serviceKey) && !merge.has(s.serviceKey))
    .map((s) => s.serviceKey);

  const localBaptismIds = new Set((await baptismStore.listSessions()).map((s) => s.id));
  const freshSessions = (baptisms?.sessions ?? []).filter((s) => !localBaptismIds.has(s.id));

  // ── Write phase: everything below is known-good. ──
  // A merged service fills its gaps from the archive; a new or replaced one takes
  // the archive's record wholesale. See merge-records.ts for what "fill" means.
  const write = async <T extends { serviceKey: string }>(
    incoming: T[],
    get: (k: string) => Promise<T | null>,
    upsert: (r: T) => Promise<void>,
    mergeOne: (mine: T, theirs: T) => T,
  ) => {
    for (const r of incoming) {
      if (!touchedKeys.has(r.serviceKey)) continue;
      if (!merge.has(r.serviceKey)) {
        await upsert(r);
        continue;
      }
      const mine = await get(r.serviceKey);
      await upsert(mine ? mergeOne(mine, r) : r);
    }
  };

  await write(
    spl,
    (k) => splHistoryStore.get(k) as never,
    (r) => splHistoryStore.upsert(r as never),
    (a, b) => mergeSplRecord(a as never, b as never) as never,
  );
  await write(
    attendance,
    (k) => attendanceStore.get(k) as never,
    (r) => attendanceStore.upsert(r as never),
    (a, b) => mergeAttendanceRecord(a as never, b as never) as never,
  );
  await write(
    timeline,
    (k) => serviceTimelineStore.get(k) as never,
    (r) => serviceTimelineStore.upsert(r as never),
    (a, b) => mergeTimelineRecord(a as never, b as never) as never,
  );

  // Raw files. A null dir means the service predates the archive and has none.
  // Merging unions rows by timestamp; replacing overwrites the file outright.
  const rawFilesFailed: { file: string; reason: string }[] = [];
  for (const s of touched) {
    if (!s.dir) continue;
    // `s.dir` is the uploaded manifest's claim about where its files go — it is
    // attacker-controlled and never used as a path. The export side always writes
    // serviceDirName(serviceKey, serviceDate), so recomputing it here is identical
    // for any real bundle and immune to a crafted one; `..` in the manifest can no
    // longer walk out of the archive root and drop a file anywhere the service user
    // can write. It stays a plain string match against the zip's entry names.
    const prefix = `archive/${s.dir}/`;
    const dirName = serviceDirName(s.serviceKey, s.serviceDate);
    for (const [name, bytes] of Object.entries(files)) {
      if (!name.startsWith(prefix)) continue;
      // basename() alone is not a safe filename. An entry ending in `/..` yields
      // "..", whose join is the archive ROOT — which isInside accepts, and writing
      // to it throws EISDIR partway through an import that has already upserted
      // records, breaking this function's own "validate everything, then write"
      // contract. An entry ending in `/.` yields ".", which writes a FILE where the
      // service's directory belongs, so every later recording for that key fails
      // at mkdir with ENOTDIR. A NUL byte throws outright. None of these need to
      // traverse anywhere to do damage.
      const leaf = path.basename(name);
      if (leaf === "" || leaf === "." || leaf === ".." || leaf.includes("\0")) {
        console.warn(`[archive] skipped a bundle entry with an unusable name: ${JSON.stringify(name)}`);
        continue;
      }
      const dest = path.join(archiveRoot(), dirName, leaf);
      // Belt and braces: whatever the pieces above did, the result is under root —
      // and strictly under it, never the root itself.
      if (!isInside(archiveRoot(), dest) || path.resolve(dest) === path.resolve(archiveRoot())) continue;
      try {
        await fs.mkdir(path.dirname(dest), { recursive: true });
        let out = new TextDecoder().decode(bytes);
        if (merge.has(s.serviceKey) && name.endsWith(".csv")) {
          let existing = "";
          try {
            existing = await fs.readFile(dest, "utf8");
          } catch {
            /* nothing here yet — take theirs whole */
          }
          // A null merge means the column sets disagree, so the rows cannot be
          // interleaved. Keep what is here rather than produce a ragged file.
          if (existing) out = mergeCsv(existing, out, parseRows, encodeRow) ?? existing;
        }
        await fs.writeFile(dest, name.endsWith(".csv") ? out : bytes);
      } catch (err) {
        // One unwritable member must not abort an import whose records are already
        // applied — but swallowing it reported success for work that did not
        // happen. On a full card every write here throws, and the operator was
        // told the import succeeded while the raw sample layer was absent. Record
        // it and let the caller decide what to say.
        const reason = errorMessage(err);
        // `dest` carries a name out of the uploaded bundle. Out of the format
        // string: a `%s` in it would consume `err` and leave the operator with
        // "could not write" and no reason.
        console.error("[archive] could not write from the bundle:", dest, err);
        rawFilesFailed.push({ file: path.relative(archiveRoot(), dest), reason });
      }
    }
  }

  // Baptism sessions dedupe on id, not serviceKey: the id is a UUID and one service
  // can hold several sessions.
  //
  // One call, not one per session. addSession re-applies its live cap on every
  // call, so looping here silently deleted the operator's OWN oldest sessions —
  // importing 45 into a box holding 80 destroyed 25 of them, while the result
  // reported only what had been added.
  const baptismSessionsAdded = await baptismStore.addSessions(freshSessions as never);

  return { added, skipped, merged, replaced, baptismSessionsAdded, rawFilesFailed };
}
