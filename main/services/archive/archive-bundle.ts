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

import { readFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { strToU8, unzipSync, zipSync } from "fflate";

import { getUserDataPath } from "../app-paths.js";
import { attendanceStore } from "../attendance-store.js";
import { baptismStore } from "../baptism-store.js";
import { serviceTimelineStore } from "../service-timeline-store.js";
import { splHistoryStore } from "../spl-history-store.js";
import { archiveRoot, serviceDirName } from "./archive-paths.js";

// main/services/archive/archive-bundle.ts → repo root is three levels up.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export const ARCHIVE_KIND = "stage-utility-archive";
export const ARCHIVE_VERSION = 1;

/** The derived history stores this bundle carries beside the raw layer. These are
 *  RUNTIME_FILES in config-snapshot.ts — deliberately absent from a config backup
 *  and deliberately present here. */
const STORE_FILES = [
  "spl-history.json",
  "attendance-history.json",
  "service-timeline.json",
  "baptism.json",
] as const;

export interface ArchiveServiceMeta {
  serviceKey: string;
  serviceDate: string;
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
  newServices: ArchiveServiceMeta[];
  presentServices: ArchiveServiceMeta[];
  newBaptismSessions: number;
}

export interface ImportResult {
  added: string[];
  skipped: string[];
  replaced: string[];
  baptismSessionsAdded: number;
}

function pkgVersion(): string {
  try {
    return JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** serviceKey → serviceDate for everything this box knows about. The three keyed
 *  stores are unioned: a service may have SPL but no attendance, or vice versa. */
async function localServices(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const r of await splHistoryStore.list()) out.set(r.serviceKey, r.serviceDate);
  for (const r of await attendanceStore.list()) out.set(r.serviceKey, r.serviceDate);
  for (const r of await serviceTimelineStore.list()) out.set(r.serviceKey, r.serviceDate);
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

  for (const name of STORE_FILES) {
    try {
      files[`stores/${name}`] = new Uint8Array(await fs.readFile(path.join(getUserDataPath(), name)));
    } catch {
      /* store absent — nothing of that kind recorded yet */
    }
  }

  const local = await localServices();
  const services: ArchiveServiceMeta[] = [...local.entries()]
    .map(([serviceKey, serviceDate]) => {
      const dir = serviceDirName(serviceKey, serviceDate);
      const hasRaw = Object.keys(files).some((n) => n.startsWith(`archive/${dir}/`));
      return { serviceKey, serviceDate, dir: hasRaw ? dir : null };
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

/** What an import would do. Writes nothing. */
export async function inspectArchive(zip: Uint8Array): Promise<ImportPlan> {
  const { files, manifest } = open(zip);
  const local = await localServices();
  const services = manifest.services ?? [];

  const localIds = new Set((await baptismStore.listSessions()).map((s) => s.id));
  const incoming = requireStore<{ sessions?: { id: string }[] }>(files, "baptism.json");

  return {
    manifest,
    newServices: services.filter((s) => !local.has(s.serviceKey)),
    presentServices: services.filter((s) => local.has(s.serviceKey)),
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
export async function importArchive(zip: Uint8Array, opts: { replace?: string[] } = {}): Promise<ImportResult> {
  const { files, manifest } = open(zip);
  const replace = new Set(opts.replace ?? []);
  const local = await localServices();

  // ── Read phase: parse every member. Throws before anything is written. ──
  // The three keyed stores share one shape: { services: { [serviceKey]: record } }.
  const spl = keyedRecords(requireStore<KeyedFile>(files, "spl-history.json"));
  const attendance = keyedRecords(requireStore<KeyedFile>(files, "attendance-history.json"));
  const timeline = keyedRecords(requireStore<KeyedFile>(files, "service-timeline.json"));
  const baptisms = requireStore<{ sessions?: { id: string }[] }>(files, "baptism.json");

  const services = manifest.services ?? [];
  const wanted = services.filter((s) => !local.has(s.serviceKey) || replace.has(s.serviceKey));
  const wantedKeys = new Set(wanted.map((s) => s.serviceKey));
  const added = wanted.filter((s) => !local.has(s.serviceKey)).map((s) => s.serviceKey);
  const replaced = wanted.filter((s) => local.has(s.serviceKey)).map((s) => s.serviceKey);
  const skipped = services
    .filter((s) => local.has(s.serviceKey) && !replace.has(s.serviceKey))
    .map((s) => s.serviceKey);

  const localBaptismIds = new Set((await baptismStore.listSessions()).map((s) => s.id));
  const freshSessions = (baptisms?.sessions ?? []).filter((s) => !localBaptismIds.has(s.id));

  // ── Write phase: everything below is known-good. ──
  for (const r of spl) if (wantedKeys.has(r.serviceKey)) await splHistoryStore.upsert(r as never);
  for (const r of attendance) if (wantedKeys.has(r.serviceKey)) await attendanceStore.upsert(r as never);
  for (const r of timeline) if (wantedKeys.has(r.serviceKey)) await serviceTimelineStore.upsert(r as never);

  // Raw files for the services being brought in. A null dir means the service
  // predates the archive and simply has none — its derived record is enough.
  for (const s of wanted) {
    if (!s.dir) continue;
    const prefix = `archive/${s.dir}/`;
    for (const [name, bytes] of Object.entries(files)) {
      if (!name.startsWith(prefix)) continue;
      const dest = path.join(archiveRoot(), s.dir, path.basename(name));
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, bytes);
    }
  }

  // Baptism sessions dedupe on id, not serviceKey: the id is a UUID and one service
  // can hold several sessions.
  for (const s of freshSessions) await baptismStore.addSession(s as never);

  return { added, skipped, replaced, baptismSessionsAdded: freshSessions.length };
}
