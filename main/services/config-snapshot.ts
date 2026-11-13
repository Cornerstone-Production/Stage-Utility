// config-snapshot.ts — Save/recall + download/upload the ENTIRE server config.
//
// A snapshot bundles every persisted config store (views, custom layouts, slots,
// presets, layout templates, integration configs incl. hosts/ports/names, wireless
// + OSC targets, branding, display options). Secrets are DELIBERATELY excluded —
// `secrets.bin`/`encryption.key` never leave the box, so a downloaded/saved
// snapshot is safe to store; on recall the operator re-enters API keys/passwords.
// Recorded history (SPL/attendance/timeline, the automation log, baptism sessions) is
// runtime data rather than config, so it is excluded — see runtimeFiles().
//
// Applying a snapshot writes the files then the server restarts (handled by the
// route) so every integration cleanly re-initializes from the restored config.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { APP_ROOT } from "./app-root.js";

import { getUserDataPath } from "./app-paths.js";
import { BRANDING_IMAGE_DIR } from "./branding-image-store.js";
import { listImages, readImage, restoreImage, storedImageProblem, type ContentRule } from "./image-files.js";
import { LAYOUT_IMAGE_DIR, LAYOUT_IMAGE_RULE } from "./layout-image-store.js";
import {
  STAGEPLOT_IMAGE_DIR,
  STAGEPLOT_IMAGE_RULE,
  STAGEPLOT_ORIGINAL_DIR,
  listStagePlotOriginals,
  readStagePlotOriginal,
  restoreStagePlotOriginal,
  storedOriginalProblem,
} from "./stageplots-files.js";
import { configFilenames, renamedStores, restoreCheckFor, storesOfClass } from "./stores.js";
import { initialFloor, type IdKind } from "./id-allocator.js";
import { scrub } from "./scrub.js";
import { plural } from "./plural.js";
import { mergeRestoredStagePlots, type RestoreMode } from "./stageplots-doc.js";
import type { StagePlotsDoc } from "../types/stageplots.js";
import { atomicWrite } from "./write-queue.js";
import { StoreReadError } from "./data-store.js";
import { MAX_CONFIG_BODY_BYTES } from "./routes/context.js";
import { errorMessage, isNotFound } from "./errors.js";

// main/services/config-snapshot.ts → repo root is two levels up.
const REPO_ROOT = APP_ROOT;

/**
 * Config stores a snapshot carries — derived from the store registry, not
 * hand-maintained.
 *
 * This was a literal array, guarded by a test that scanned the source for
 * `new DataStore<…>(`. The regex could not cross a `>`, so signal-store's nested
 * generic was invisible and the scan found 22 of 23 stores; CI was green only
 * because someone had independently classified that one. The read was also not
 * recursive, so a store under archive/ or routes/ could never be seen.
 *
 * Classification is now a constructor argument, so a store cannot exist without
 * declaring which half it belongs to. See store-registry.ts.
 */
export function configFiles(): string[] {
  return configFilenames();
}

/** Stores deliberately excluded: recorded history and logs — observations of what
 *  happened rather than configuration. Restoring them onto another install would
 *  fabricate services that machine never ran. */
export function runtimeFiles(): string[] {
  return storesOfClass("runtime").map((s) => s.filename);
}

/** Image directories carried in a snapshot. Allowlisted for the same reason
 *  CONFIG_FILES is: it bounds what an applied bundle can write. */
const IMAGE_DIRS = [BRANDING_IMAGE_DIR, LAYOUT_IMAGE_DIR, STAGEPLOT_IMAGE_DIR] as const;

/** What saving an image into each folder checks, which is what a restore holds
 *  that folder's images to: branding uploads check content, layout uploads never
 *  have, and a backup of a layout image a build stored must restore. */
const IMAGE_RULES: Record<(typeof IMAGE_DIRS)[number], ContentRule> = {
  [BRANDING_IMAGE_DIR]: { checkContent: true },
  [LAYOUT_IMAGE_DIR]: LAYOUT_IMAGE_RULE,
  [STAGEPLOT_IMAGE_DIR]: STAGEPLOT_IMAGE_RULE,
};

/** Folders of uploaded originals that are not images (stage-plot PDFs), carried
 *  in a snapshot's `originals` beside its images. Kept apart so the image rules
 *  (types, the 12 MB cap) never widen to them. */
const ORIGINAL_DIRS = [STAGEPLOT_ORIGINAL_DIR] as const;

/**
 * Fields stripped from a snapshot, by file.
 *
 * A snapshot's own header says "Secrets are DELIBERATELY excluded", and the UI
 * presents one as safe to keep on a drive or hand to somebody. That held while
 * every secret lived in secrets.bin -- and then kiosk-devices.json, classified
 * "config" so bindings survive a rebuild, started carrying each screen's token.
 * The file that writes it calls that token "the ONLY thing separating a claimed
 * display from anything else on the LAN", and ships withoutTokens() to keep it
 * out of HTTP listings; the export copied it verbatim. Anyone holding a bundle
 * who can reach the LAN could GET /enroll?device=…&token=….
 *
 * Emptied rather than deleted, because "" is MEANINGFUL: authorise() treats an
 * empty token as unpinned and pins the first secret the screen presents. So a
 * restored binding still works -- the display re-pins on its next enrolment --
 * while the bundle carries nothing worth stealing.
 *
 * ONLY FOR AN ARRAY-SHAPED STORE, and only for fields one row deep. This is not
 * the mechanism for a credential nested inside settings.json -- an entry for an
 * object-shaped file used to be accepted and do NOTHING, which is a redaction
 * rule that reads like a fix and is not one. It is also the wrong shape for a
 * credential outright: it empties the value at EXPORT time, so a restore puts
 * back "", which for a kiosk token means "unpinned" and for anything else means
 * the feature silently switched off. A credential belongs in secrets.bin, which
 * a snapshot does not carry at all -- see SECRET_KEYS in integration-manager.ts.
 */
const REDACTED_FIELDS: Record<string, readonly string[]> = {
  "kiosk-devices.json": ["token"],
};

/**
 * A store's contents with its secret fields emptied, ready to leave the machine.
 *
 * A shape it cannot walk passes through UNCHANGED and is not an error -- see
 * "does not choke on an unexpected shape" in snapshot-redaction.test.ts, which
 * is the deliberate decision that redaction must never be the thing that breaks
 * an export. That is also why this is not a mechanism a credential may rely on:
 * see the note on REDACTED_FIELDS above.
 */
export function redactForExport(filename: string, value: unknown): unknown {
  const fields = REDACTED_FIELDS[filename];
  if (!fields || !Array.isArray(value)) return value;
  return value.map((row) =>
    row && typeof row === "object"
      ? Object.fromEntries(
          Object.entries(row as Record<string, unknown>).map(([k, v]) =>
            fields.includes(k) ? [k, ""] : [k, v],
          ),
        )
      : row,
  );
}

/** A restore refused: one `file: reason` per failure, for the route to show.
 *  Nothing was written. */
export class RestoreRefusedError extends Error {
  readonly status = 400;
  constructor(readonly failures: string[]) {
    super(`The backup was not restored, and nothing was changed. ${failures.join("; ")}`);
    this.name = "RestoreRefusedError";
  }
}

/** An image a restore writes, already checked. */
interface RestoredImage {
  dir: string;
  file: string;
  bytes: Buffer;
}

/** What a restore writes, every part of it checked. */
interface CheckedBundle {
  files: Map<string, NonNullable<unknown>>;
  images: RestoredImage[];
  originals: RestoredImage[];
}

/** The most images a restore takes. Deliberately a cap no real install meets:
 *  the bundle's size limit allows thousands of small ones. */
const MAX_RESTORE_IMAGES = 2000;

/** The most files a restore's bundle may list. Bounds a crafted bundle only:
 *  a backup from a newer build lists stores this one lacks, which are ignored,
 *  so the cap is not tied to how many stores this build keeps. */
const MAX_RESTORE_FILES = 500;

/** The most originals a restore takes: twice the 50 backgrounds an install can
 *  hold, for originals a delete has not yet tidied away. */
const MAX_RESTORE_ORIGINALS = 100;

/** A folder a snapshot carries files from. */
interface FileSource {
  dir: string;
  list: () => Promise<string[]>;
  read: (file: string) => Promise<Buffer | null>;
}

const IMAGE_SOURCES: readonly FileSource[] = IMAGE_DIRS.map((dir) => ({
  dir,
  list: () => listImages(dir),
  read: async (file: string) => (await readImage(dir, file))?.data ?? null,
}));

const ORIGINAL_SOURCES: readonly FileSource[] = [
  { dir: STAGEPLOT_ORIGINAL_DIR, list: listStagePlotOriginals, read: readStagePlotOriginal },
];

/** How a restore checks one of a bundle's two kinds of file, and names it. */
interface FileKind {
  label: string;
  things: string;
  unit: string;
  folders: string;
  max: number;
  /** Each folder this build keeps, and the rule a file there is held to. */
  problemFor: ReadonlyMap<string, (file: string, bytes: Buffer) => string | null>;
}

const IMAGES: FileKind = {
  label: "images",
  things: "images",
  unit: "image",
  folders: "the image folders",
  max: MAX_RESTORE_IMAGES,
  problemFor: new Map(IMAGE_DIRS.map((dir) => [dir, (file: string, bytes: Buffer) => storedImageProblem(file, bytes, IMAGE_RULES[dir])])),
};

const ORIGINALS: FileKind = {
  label: "originals",
  things: "files",
  unit: "original",
  folders: "the folders of originals",
  max: MAX_RESTORE_ORIGINALS,
  problemFor: new Map(ORIGINAL_DIRS.map((dir) => [dir, storedOriginalProblem])),
};

/**
 * What to say when a snapshot's images and originals, base64'd as they travel,
 * pass what POST /api/config/import reads (MAX_CONFIG_BODY_BYTES): restoring
 * that backup from a downloaded file would be refused. Null when it fits.
 */
export function restoreCeilingNote(base64Bytes: number): string | null {
  if (base64Bytes <= MAX_CONFIG_BODY_BYTES) return null;
  const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `this backup carries ${mb(base64Bytes)} of uploaded images and originals as it travels, past the ${mb(MAX_CONFIG_BODY_BYTES)} a downloaded backup can restore: restoring it from the file will be refused (a saved snapshot recalled on this server is not limited)`;
}

const SNAPSHOT_KIND = "stage-utility-config";
const SNAPSHOT_VERSION = 1;

export interface ConfigSnapshot {
  kind: typeof SNAPSHOT_KIND;
  version: number;
  /** App version that produced it (informational). */
  appVersion: string;
  createdAt: string;
  /** Optional friendly name (set for saved snapshots). */
  name?: string;
  /** filename → parsed JSON contents, for each present config store. */
  files: Record<string, unknown>;
  /** `<dir>/<file>` → base64 bytes, for uploaded images.
   *
   *  Branding logos and custom-layout images are files, not JSON, so listing the
   *  stores was no longer enough to describe the config. Logos in particular used
   *  to be base64 inside settings.json and so rode along for free; moving them to
   *  files would have quietly dropped them from every backup. Layout images were
   *  never captured at all — this fixes that too. Absent on older snapshots. */
  images?: Record<string, string>;
  /** `<dir>/<file>` → base64 bytes, for uploaded originals kept but never
   *  served: a stage-plot background's PDF. Absent when there are none, and
   *  on snapshots from before StagePlots. */
  originals?: Record<string, string>;
}

/** Lightweight metadata for listing saved snapshots (no file contents). */
export interface SnapshotMeta {
  id: string;
  name: string;
  createdAt: string;
  appVersion: string;
  fileCount: number;
  /** The id of the server it was saved on, or null. A recall asks whether to take
   *  it when it is not this server's own. */
  serverId: string | null;
  /** Whether it brings screens (settings.json) and screen bindings
   *  (kiosk-devices.json): what decides whether a recall releases this server's. */
  carriesScreens: boolean;
  carriesBindings: boolean;
}

/** This build's version, for stamping a bundle. Exported so a view export
 *  carries the same value a config snapshot does rather than reading
 *  package.json a second way. */
export function appVersion(): string {
  try {
    return JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** A settings blob, read far enough to reach its id floors and no further. */
type FloorsOnly = { idFloors?: Record<string, unknown> };

/** What a restore keeps from the settings.json it is about to replace. */
interface LiveSettings {
  /** The id floors, or null when there are none that can be read. */
  idFloors: Record<string, unknown> | null;
  /** This server's own id, or null when it has none or it cannot be read. */
  serverId: string | null;
}

/** A server id read from a settings blob: a non-empty string, or null. */
function serverIdIn(settings: unknown): string | null {
  const v = (settings as { serverId?: unknown } | null)?.serverId;
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** The `id` of every entry in a restored `View[]` / `Output[]`, ignoring anything
 *  that is not shaped like one. A bundle's contents are whatever the file says. */
function idsIn(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (entry as { id?: unknown } | null)?.id)
    .filter((id): id is string => typeof id === "string");
}

/** The live floors and server id, from one read of the settings.json a restore replaces. */
async function liveSettings(dest: string): Promise<LiveSettings> {
  let raw: string;
  try {
    raw = await fs.readFile(dest, "utf8");
  } catch (err) {
    // No live settings.json at all — a restore onto a fresh install. Not a
    // failure: there are simply no spent ids to carry forward, and no id of its
    // own to keep. Anything else is rethrown rather than treated as "nothing there".
    if (isNotFound(err)) return { idFloors: null, serverId: null };
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as FloorsOnly;
    return { idFloors: parsed.idFloors ?? {}, serverId: serverIdIn(parsed) };
  } catch {
    // The file exists but does not parse. This restore is about to replace it
    // anyway, and there is no floor or id to be read out of it — that IS the
    // answer here, not a swallowed error. Said out loud because it means ids
    // issued since the snapshot was taken could be handed out again, and that
    // this server's own id is gone unless the config's is taken.
    console.warn(
      "[config-snapshot] the existing settings.json does not parse, so its id floors and server id could not be carried forward — ids created since this snapshot may be reissued, and unless the config's server id is taken a new one is made when discovery starts",
    );
    return { idFloors: null, serverId: null };
  }
}

/**
 * The live stage plots document a restore is about to replace, read off disk (never through
 * the store, whose cache a restart must find cold). Undefined when there is none. One that
 * fails the store's check is read for its links alone, so a restore never strands one; one
 * that does not parse holds no link anyone can read, and is said so.
 */
async function liveStagePlots(file: string): Promise<StagePlotsDoc | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    console.warn("[config-snapshot] the live stageplots.json does not parse, so its published links could not be carried into this restore");
    return undefined;
  }
  // Imported lazily for the reason pauseBackgroundWriters is.
  const { checkStagePlotsDoc } = await import("./stageplots-store.js");
  try {
    return checkStagePlotsDoc(json);
  } catch {
    return linksOnly(json);
  }
}

/** A stage plots document that fails the check, cut down to its venues' links and its queue: all a restore needs to know of it. */
function linksOnly(json: unknown): StagePlotsDoc {
  const o = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
  const d = o(json);
  const link = (x: Record<string, unknown> | null) => (x && typeof x.secret === "string" && typeof x.origin === "string" ? { secret: x.secret, origin: x.origin } : null);
  const venues = (Array.isArray(d?.venues) ? d.venues : []).map((raw, i) => {
    const p = link(o(o(raw)?.publish));
    return { id: `live-${i}`, name: "", kind: "home" as const, notes: "", plotIds: [], defaultPlotId: null, ...(p ? { publish: { ...p, publishedAt: "", lastError: null, publishedImages: [], unpublishedImages: [] } } : {}) };
  });
  const pendingRemovals = (Array.isArray(d?.pendingRemovals) ? d.pendingRemovals : []).flatMap((raw) => {
    const l = link(o(raw));
    return l ? [{ ...l, since: new Date().toISOString(), reason: "restored over" as const }] : [];
  });
  return { venues, backgrounds: [], plots: [], overrides: [], pendingRemovals };
}

/** What the operator chose about the server the config was saved on. */
export interface RestoreOptions {
  /** This box replaces that server: take its server id, and with it its screens
   *  and Mac outputs. Anything other than an explicit yes keeps this server's own. */
  replacesOriginal: boolean;
}

/** The default for every caller that does not ask: a second box that also runs
 *  must never come up answering discovery as the first. */
const KEEP_OWN_ID: RestoreOptions = { replacesOriginal: false };

/** The screen bindings a restore may leave as they are. Bindings are to a server
 *  id: they go wherever the config's id goes. */
const BINDINGS_FILE = "kiosk-devices.json";

/** The stage plots store, whose venues' publish links follow the server id (see writeSnapshot). */
const STAGEPLOTS_FILE = "stageplots.json";

/**
 * Whether a restore takes the config's server id, and with it the config's screen
 * bindings (kiosk-devices.json). The one decision both follow.
 *
 * Kiosks and Mac output helpers bind to a server by this id. The config's id is
 * the id of the server it was saved on, so writing it onto a second box that also
 * runs makes two servers answer discovery as one, and every screen bound to it
 * flips between them. It is right only for this server's own config, or for a box
 * that REPLACES that server, which only the operator knows.
 *
 * A config with no id says nothing about identity: this server keeps its own.
 * Written verbatim, the missing key used to leave settings.json with no id at all:
 * the next start minted a new one, and every screen bound here was orphaned.
 */
export function takesConfigId(configId: string | null, ownId: string | null, replacesOriginal: boolean): boolean {
  return configId !== null && (configId === ownId || replacesOriginal);
}

/**
 * Release every screen binding on this server, for a restore that keeps its id
 * but writes the config's screens: a device bound to display-2 here would
 * otherwise show the config's display-2, whatever that is, and say nothing. Each
 * released device probes as not set up here (decideProbe rule 3) and shows under
 * Not set up yet, to be set up again. Each is named on [config-snapshot].
 *
 * Bindings that cannot be read are left as they are and said so: releasing means
 * writing over the file, and a file nobody can read is not one to overwrite.
 */
async function releaseBindings(toRestore: Map<string, NonNullable<unknown>>): Promise<void> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(getUserDataPath(), BINDINGS_FILE), "utf8");
  } catch (err) {
    if (isNotFound(err)) return;
    throw err;
  }
  let bound: unknown;
  try {
    bound = JSON.parse(raw);
  } catch {
    bound = null;
  }
  if (!Array.isArray(bound)) {
    console.warn(`[config-snapshot] restore: this server's screen bindings (${BINDINGS_FILE}) could not be read, so they were not released; any screen still bound may show the config's screen of the same id`);
    return;
  }
  if (bound.length === 0) return;
  for (const d of bound as { id?: unknown; label?: unknown; outputId?: unknown }[]) {
    const label = typeof d?.label === "string" && d.label ? ` ("${scrub(d.label)}")` : "";
    console.log(
      `[config-snapshot] restore: released ${scrub(String(d?.id))}${label} from screen ${scrub(String(d?.outputId))}: this server's screens are now the config's, so set it up again from Screens`,
    );
  }
  toRestore.set(BINDINGS_FILE, []);
}

/** settings.json as a restore writes it: id floors merged, server id decided, and
 *  the decision said on [config-snapshot] whenever the two ids differ. */
function restoredSettings(contents: object, live: LiveSettings, files: Record<string, unknown>, take: boolean): unknown {
  const merged = mergeIdFloors(contents, live.idFloors, files) as Record<string, unknown>;
  const configId = serverIdIn(contents);
  const serverId = take ? configId : live.serverId;
  if (configId !== null && configId !== live.serverId) {
    const own = scrub(live.serverId ?? "none");
    console.log(
      take
        ? `[config-snapshot] restore: took the config's server id ${scrub(configId)} in place of ${own}, as its replacement; screens set up on that server follow this one`
        : `[config-snapshot] restore: kept this server's id ${own}; the config's ${scrub(configId)} stays with the server it came from`,
    );
  }
  // null is "none yet": the server mints one when discovery first starts. A
  // config with no key and no id to keep is left as it came, so a restore of a
  // config this server made writes back exactly what it read.
  if (serverId === null && !Object.hasOwn(merged, "serverId")) return merged;
  return { ...merged, serverId };
}

/**
 * Work out the id floors the restored settings.json should carry.
 *
 * Everything else in a restore is meant to go back to what the snapshot held —
 * that is the point of a restore. Id floors are the exception: they are not a
 * setting the operator chose, they are the record of which ids have been SPENT,
 * and a floor below an id that exists hands that id out again. slots.json is
 * keyed by output id, with Pis, bookmarks and QR codes pointing at `/<id>`.
 *
 * So the answer is the highest of three numbers, because each knows something
 * the others do not:
 *
 *   THE LIVE FLOOR knows about ids this box spent and then DELETED. Nothing else
 *   can see those — they are gone from every file.
 *
 *   THE SNAPSHOT'S FLOOR is the same knowledge from the box the snapshot came
 *   from, which may be a different install entirely.
 *
 *   THE IDS IN THE SNAPSHOT are the only candidate a PRE-FEATURE snapshot has,
 *   and they are why this cannot be left to the seeding pass at the next boot.
 *   Such a snapshot carries no floors, so the live floor — a number belonging to
 *   the box being restored ONTO, which knows nothing about what just arrived —
 *   would win by being the only number available, and land below every id in the
 *   bundle. Correcting it here makes the floor right the moment the restore
 *   lands, with no boot required: kill the box in the seconds between apply()
 *   and the restart it triggers, and the floor on disk is still correct.
 */
function mergeIdFloors(contents: object, live: Record<string, unknown> | null, files: Record<string, unknown>): unknown {
  const incoming = (contents as FloorsOnly).idFloors ?? {};
  // Views are their own file; outputs live in the settings.json being written.
  const restoredIds: Record<IdKind, string[]> = {
    view: idsIn(files["views.json"]),
    output: idsIn((contents as { outputs?: unknown }).outputs),
  };

  /**
   * A floor is a number or it is nothing.
   *
   * The value comes out of a snapshot file — hand-edited, corrupted or hostile —
   * and validate() checks only `kind` and `files`. Anything else is dropped to 0
   * and SAID SO below rather than coerced: falling back to the collision walk
   * gives an id nothing else is using, where a coerced floor would hand out one
   * that is.
   */
  const asNumber = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  // A Map, and Object.fromEntries at the end: the keys are snapshot-controlled,
  // and this way nothing is ever written to a computed property name.
  const merged = new Map<string, number>();
  const ignored: string[] = [];
  for (const kind of new Set([...Object.keys(live ?? {}), ...Object.keys(incoming), ...Object.keys(restoredIds)])) {
    // Unknown kinds are carried through — a snapshot from a newer build knows
    // about ids this one cannot allocate — but never these three. They are not
    // id kinds, they are the names an attacker reaches for, and the same set is
    // refused by notes-store and checklist-ticks-store for the same reason.
    if (kind === "__proto__" || kind === "constructor" || kind === "prototype") {
      ignored.push(kind);
      continue;
    }
    // hasOwn rather than `in`: the key is untrusted, and "constructor" is `in`
    // every object — which is not theoretical here. A snapshot holding
    // `"idFloors": {"view": 3, "constructor": 1}` made this branch true, handed
    // initialFloor Object.prototype.constructor, and threw
    // "TypeError: function is not iterable" out of nextId's `new Set(...)`.
    // writeSnapshot writes one file at a time, so views.json was already on disk
    // when the loop died: a half-restored box, with views referencing output ids
    // the un-restored settings.json does not have. routes/context.ts:60 carries
    // the same note for the same reason.
    const fromRestored = Object.hasOwn(restoredIds, kind)
      ? initialFloor(kind as IdKind, restoredIds[kind as IdKind])
      : 0;
    if (Object.hasOwn(incoming, kind) && asNumber(incoming[kind]) === 0 && incoming[kind] !== 0) {
      ignored.push(kind);
    }
    const best = Math.max(asNumber(live?.[kind]), asNumber(incoming[kind]), fromRestored);
    if (best > 0) merged.set(kind, best);
  }
  if (ignored.length > 0) {
    console.warn(
      `[config-snapshot] ignored ${ignored.length} id floor(s) the snapshot could not supply — ` +
        `not a number, or not a usable name: ${scrub(ignored.join(", "))}. ` +
        "Ids for those kinds fall back to the collision walk.",
    );
  }
  if (merged.size === 0) return contents;
  return { ...(contents as Record<string, unknown>), idFloors: Object.fromEntries(merged) };
}

/**
 * Quiet the things that write config on a timer, before a restore lands.
 *
 * Imported lazily: config-snapshot is pulled in by the backup scheduler at boot,
 * and a static import of the controller here would make that a cycle.
 */
async function pauseBackgroundWriters(): Promise<() => void> {
  // Awaited, where these used to be fire-and-forget. The imports are lazy to
  // break a cycle, not because the timing is unimportant: not waiting meant the
  // writes below could begin before the poller had actually stopped, which is
  // the race the stop exists to remove.
  const writers = [
    ["the live poller", () => import("./live-poller.js").then((m) => m.livePoller.pause())],
    ["the stage controller", () => import("./stage-controller.js").then((m) => m.stageController.pauseBackgroundWork())],
    // Waits for any publish in flight, then holds every stage plots write until a refused
    // restore resumes it: a debounced republish must not write over the restored file.
    ["the stage plots publisher", () => import("./stageplots-publish-instance.js").then((m) => m.stageplotsPublisher.pause())],
  ] as const;
  const settled = await Promise.allSettled(writers.map(([, pause]) => pause()));
  const undos = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  const resume = () => {
    for (const undo of undos) undo();
  };
  // One that could not be quieted would write over the restored file and the restore would still
  // report itself clean: refused instead, with what was paused resumed and the box as it was.
  const failed = settled.flatMap((r, i) => (r.status === "rejected" ? [`${writers[i]![0]} (${errorMessage(r.reason)})`] : []));
  if (failed.length > 0) {
    resume();
    const message = `The restore was refused: ${failed.join(" and ")} could not be paused, and would have written over the restored files. Nothing was changed.`;
    console.error(`[config-snapshot] ${scrub(message, 600)}`);
    throw new Error(message);
  }
  return resume;
}

class ConfigSnapshotService {
  private snapshotsDir(): string {
    return path.join(getUserDataPath(), "snapshots");
  }

  /**
   * Read + parse a config store file, or undefined if it is absent or does not
   * parse. A file that is there and cannot be read throws: left out, it made a
   * backup that reported success without the operator's work in it, and the
   * scheduler then pruned the older copies that still had it.
   */
  private async readFile(name: string): Promise<unknown | undefined> {
    let raw: string;
    try {
      raw = await fs.readFile(path.join(getUserDataPath(), name), "utf8");
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw new StoreReadError(name, err, "could not be read for the backup");
    }
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }

  /**
   * Every file `sources` list, as `<dir>/<file>` → base64. A listing or a read
   * that fails is named and fails the backup, the same way a store file does:
   * the backup must not succeed without it.
   */
  private async readFiles(sources: readonly FileSource[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const orFail = <R>(name: string, read: Promise<R>) =>
      read.catch((err: unknown) => {
        throw new StoreReadError(name, err, "could not be read for the backup");
      });
    for (const { dir, list, read } of sources) {
      for (const file of await orFail(dir, list())) {
        const bytes = await orFail(`${dir}/${file}`, read(file));
        if (bytes) out[`${dir}/${file}`] = bytes.toString("base64");
      }
    }
    return out;
  }

  /** Build a snapshot of the live config (secrets excluded). */
  async build(name?: string): Promise<ConfigSnapshot> {
    // A keyed store classified "config" would be read by its legacy filename and
    // capture the stale pre-split document instead of the per-service files —
    // a backup that succeeds and is mostly empty. Refuse rather than write it.
    const keyed = storesOfClass("config").filter((s) => s.kind === "directory");
    if (keyed.length > 0) {
      throw new Error(
        `[config-snapshot] cannot back up keyed store(s) by filename: ${keyed.map((s) => s.filename).join(", ")}`,
      );
    }
    const files: Record<string, unknown> = {};
    for (const f of configFiles()) {
      const v = await this.readFile(f);
      if (v !== undefined) files[f] = redactForExport(f, v);
    }
    const images = await this.readFiles(IMAGE_SOURCES);
    const originals = await this.readFiles(ORIGINAL_SOURCES);
    const note = restoreCeilingNote(Object.values({ ...images, ...originals }).reduce((n, b64) => n + b64.length, 0));
    if (note) console.warn(`[config-snapshot] ${note}`);
    return {
      ...(Object.keys(images).length ? { images } : {}),
      ...(Object.keys(originals).length ? { originals } : {}),
      kind: SNAPSHOT_KIND,
      version: SNAPSHOT_VERSION,
      appVersion: appVersion(),
      createdAt: new Date().toISOString(),
      ...(name ? { name } : {}),
      files,
    };
  }

  /** Validate a bundle is a snapshot we can apply. Throws on mismatch. */
  private validate(bundle: unknown): asserts bundle is ConfigSnapshot {
    const b = bundle as Partial<ConfigSnapshot> | null;
    if (!b || typeof b !== "object") throw new Error("Not a config snapshot.");
    if (b.kind !== SNAPSHOT_KIND) throw new Error("Unrecognized file — not a Stage Utility config snapshot.");
    if (!b.files || typeof b.files !== "object") throw new Error("Snapshot has no config data.");
  }

  /**
   * Write a snapshot's config files and images back to the data dir, once every
   * one of them has passed its check (see checkBundle). Returns what was
   * applied. Caller restarts to apply.
   */
  async apply(bundle: unknown, opts: RestoreOptions = KEEP_OWN_ID): Promise<string[]> {
    this.validate(bundle);
    // Every file and image checked before anything is paused, cleared or
    // written: a refusal leaves the box exactly as it was.
    const checked = await this.checkBundle(bundle);

    // Nothing may write config while a restore is landing. The process exits
    // ~1.2s after this returns, and inside that window the live poller ticks
    // every 1–4s: an auto-advance calling settingsStore.patch() would read its
    // still-warm cache and write it straight back over the file just restored,
    // reporting success. Stopping the background writers first removes the race
    // at its source rather than trying to win it.
    const resumeBackgroundWriters = await pauseBackgroundWriters();
    try {
      const applied = await this.writeSnapshot(bundle, checked, opts);
      console.log(`[config-snapshot] restore accepted: ${scrub(applied.join(", "), 600)}`);
      return applied;
    } catch (err) {
      // Only on the failure path. A successful restore does not resume anything
      // because the process exits ~1.2s later — but a failed one returns to a
      // box that keeps serving, and leaving it with no poller froze every
      // display and stopped the recorders for good.
      resumeBackgroundWriters();
      throw err;
    }
  }

  /**
   * What a restore will write, every file and image already checked — or a
   * RestoreRefusedError naming each that failed, with nothing touched.
   *
   * Files go through their store's restore check (restore-check.ts): a restore
   * can come from any device on the LAN, and must do nothing the settings pages
   * cannot. Images are held to what saving one writes (storedImageProblem).
   */
  private async checkBundle(bundle: ConfigSnapshot): Promise<CheckedBundle> {
    const known = configFiles();
    // A backup taken before a store was renamed lists it under the file it had
    // then. Mapped to today's name rather than skipped, because the allowlist
    // below would otherwise drop it without a word and the restore would report
    // success having put none of that work back.
    const renamedTo = new Map(renamedStores().map((s) => [s.renamedFrom.filename, s.filename]));
    const listed = Object.keys(bundle.files);
    if (listed.length > MAX_RESTORE_FILES) {
      return this.refuse([`the backup lists ${listed.length} files; a restore takes at most ${MAX_RESTORE_FILES}`]);
    }
    const ignored: string[] = [];
    const empty: string[] = [];
    const toCheck = new Map<string, NonNullable<unknown>>();
    for (const [listedName, contents] of Object.entries(bundle.files)) {
      const name = renamedTo.get(listedName) ?? listedName;
      if (name !== listedName && Object.hasOwn(bundle.files, name)) {
        // Both spellings in one file: only a hand-merged bundle can do this. The
        // one under today's name is the one to trust.
        console.warn(`[config-snapshot] this backup lists both ${scrub(listedName)} and ${scrub(name)}; restored ${scrub(name)} and ignored ${scrub(listedName)}`);
        continue;
      }
      // Not a refusal: a backup from a newer build carries stores this one does
      // not have, and the rest of it still restores.
      if (!known.includes(name)) ignored.push(listedName);
      else if (contents === undefined || contents === null) empty.push(name);
      else toCheck.set(name, contents);
    }
    if (ignored.length > 0) {
      console.warn(`[config-snapshot] restore: ignored ${ignored.length} file(s) this build does not keep: ${scrub(ignored.join(", "), 400)}`);
    }
    if (empty.length > 0) {
      console.warn(`[config-snapshot] restore: ${scrub(empty.join(", "), 400)} listed with no contents; left as they are`);
    }
    const failures: string[] = [];
    const files = new Map<string, NonNullable<unknown>>();
    for (const [name, contents] of toCheck) {
      const result = await this.runCheck(name, contents);
      if (!result.ok) failures.push(`${name}: ${result.reason}`);
      else files.set(name, result.value);
    }
    const images = this.checkFiles(bundle.images, IMAGES, failures);
    const originals = this.checkFiles(bundle.originals, ORIGINALS, failures);
    if (failures.length > 0) return this.refuse(failures);
    return { files, images, originals };
  }

  /**
   * A store's restore check, run. Fails closed: a config store with no check
   * (the type checker does not let one be built), or a check that answers with
   * nothing to write, is a refusal rather than a file written unchecked.
   */
  private async runCheck(name: string, contents: unknown): Promise<{ ok: true; value: NonNullable<unknown> } | { ok: false; reason: string }> {
    const check = restoreCheckFor(name);
    if (!check) return { ok: false, reason: "this build has no check for it" };
    const result = await check(contents);
    if (!result.ok) return result;
    if (result.value === undefined || result.value === null) return { ok: false, reason: "its check returned nothing to write" };
    return { ok: true, value: result.value };
  }

  /**
   * A bundle's images or originals, each decoded and held to what storing one
   * checks. A folder this build does not keep is skipped, and said so: a backup
   * from a newer build still restores the rest.
   */
  private checkFiles(raw: unknown, kind: FileKind, failures: string[]): RestoredImage[] {
    if (raw === undefined) return [];
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      failures.push(`${kind.label}: must be an object of ${kind.things}`);
      return [];
    }
    const entries = Object.entries(raw);
    if (entries.length > kind.max) {
      failures.push(`${kind.label}: the backup lists ${entries.length}; a restore takes at most ${kind.max}`);
      return [];
    }
    const out: RestoredImage[] = [];
    const skipped: string[] = [];
    for (const [ref, b64] of entries) {
      const slash = ref.indexOf("/");
      const dir = slash > 0 ? ref.slice(0, slash) : "";
      const file = slash > 0 ? ref.slice(slash + 1) : "";
      const problemFor = kind.problemFor.get(dir);
      if (!problemFor) {
        skipped.push(ref);
        continue;
      }
      if (typeof b64 !== "string") {
        failures.push(`${ref}: is not base64 text`);
        continue;
      }
      const bytes = Buffer.from(b64, "base64");
      if (bytes.toString("base64") !== b64) {
        failures.push(`${ref}: is not base64`);
        continue;
      }
      const problem = problemFor(file, bytes);
      if (problem) failures.push(`${ref}: ${problem}`);
      else out.push({ dir, file, bytes });
    }
    if (skipped.length > 0) {
      console.warn(`[config-snapshot] restore: skipped ${skipped.length} ${kind.unit}(s) outside ${kind.folders}: ${scrub(skipped.join(", "), 400)}`);
    }
    return out;
  }

  private refuse(failures: string[]): never {
    console.warn(`[config-snapshot] restore refused, nothing written: ${scrub(failures.join("; "), 800)}`);
    throw new RestoreRefusedError(failures);
  }

  /**
   * Run every config file on disk through the check a restore would apply, and
   * say on [config-snapshot] which do not pass. Nothing is changed: a file that
   * fails is served as it is, because it is the operator's and quarantining it
   * would take their setup out of service for a rule that may be newer than the
   * file. Run at boot, before the stores are read. Returns what failed.
   */
  async checkOnDisk(): Promise<string[]> {
    const failures: string[] = [];
    for (const name of configFiles()) {
      let value: unknown;
      try {
        value = await this.readFile(name);
      } catch (err) {
        // Returned with the rest, not swallowed: the store's own load says the
        // same on [data-store] and refuses saves to it.
        failures.push(`${name}: ${errorMessage(err)}`);
        continue;
      }
      if (value === undefined || value === null) continue;
      const result = await this.runCheck(name, value);
      if (!result.ok) failures.push(`${name}: ${result.reason}`);
    }
    for (const f of failures) {
      console.warn(`[config-snapshot] ${scrub(f, 400)} -- a save would refuse this; left in use as it is`);
    }
    return failures;
  }

  /** The write half of `apply`, split out so the resume can wrap all of it. */
  private async writeSnapshot(bundle: ConfigSnapshot, checked: CheckedBundle, opts: RestoreOptions): Promise<string[]> {
    const applied: string[] = [];
    const toRestore = new Map(checked.files);
    // Read once, before anything is written, because two files depend on it:
    // settings.json takes its server id from it, and the screen bindings follow
    // whichever id that turns out to be.
    const configSettings = toRestore.get("settings.json");
    const live = configSettings ? await liveSettings(path.join(getUserDataPath(), "settings.json")) : null;
    const take = live !== null && takesConfigId(serverIdIn(configSettings), live.serverId, opts.replacesOriginal);
    if (!take) {
      // The config's bindings are to the server it was saved on, or to none it
      // names: never this one's. And once the config's screens replace this
      // server's, its own bindings point at screen ids (display-N, counters that
      // collide across servers) that are now somebody else's screens.
      toRestore.delete(BINDINGS_FILE);
      if (configSettings) await releaseBindings(toRestore);
    } else if (live && serverIdIn(configSettings) !== live.serverId && !toRestore.has(BINDINGS_FILE)) {
      // Taken from another server that never set up a device: there are no
      // bindings of its to write, but its screens still replace this server's,
      // so this server's bindings name screens that are no longer theirs.
      await releaseBindings(toRestore);
    }
    // Published stage plots: merged with the live file this restore replaces, so no link that
    // may be live on a page is left unknown and none that was revoked comes back
    // (mergeRestoredStagePlots has the rules). Two servers never publish one link: a config of
    // another server's keeps its links with that server, unless this box replaces it.
    if (toRestore.has(STAGEPLOTS_FILE)) {
      const mode: RestoreMode = !take ? "keep-own" : serverIdIn(configSettings) === live?.serverId ? "same-id" : "replace";
      const merged = mergeRestoredStagePlots({
        restored: toRestore.get(STAGEPLOTS_FILE) as StagePlotsDoc,
        live: await liveStagePlots(path.join(getUserDataPath(), STAGEPLOTS_FILE)),
        mode,
        now: new Date().toISOString(),
      });
      toRestore.set(STAGEPLOTS_FILE, merged.doc);
      if (merged.unpublished > 0 || merged.queued > 0) {
        console.log(
          `[config-snapshot] restore: ${plural(merged.unpublished, "stage plots venue comes", "stage plots venues come")} back unpublished and ${plural(merged.queued, "link is", "links are")} queued for removal from its page, so none is left live and unknown`,
        );
      }
    }
    // A bundle carries addresses and no secrets, so a stored credential would
    // follow whatever address it names. Cleared before anything is written: a
    // write that then fails costs the operator a password typed again, where
    // the other order could send one to an address it was never entered for.
    // Imported lazily for the reason pauseBackgroundWriters is.
    const { clearCredentialsARestoreMoves } = await import("./restore-credentials.js");
    await clearCredentialsARestoreMoves(toRestore);
    for (const [name, contents] of toRestore) {
      const dest = path.join(getUserDataPath(), name);
      const toWrite =
        name === "settings.json" && typeof contents === "object" && !Array.isArray(contents)
          ? restoredSettings(contents, live!, bundle.files, take)
          : contents;
      // Atomic, for the reason data-store.ts spells out: a plain writeFile
      // truncates in place, so a power cut here leaves a short settings.json that
      // the next boot cannot parse, quarantines, and replaces with defaults —
      // losing the settings the operator restored this bundle to recover.
      await atomicWrite(dest, JSON.stringify(toWrite, null, 2));
      applied.push(name);
    }
    // Uploaded images, under the content-hashed names checkImages confirmed.
    for (const { dir, file, bytes } of checked.images) {
      if (await restoreImage(dir, file, bytes)) applied.push(`${dir}/${file}`);
    }
    for (const { dir, file, bytes } of checked.originals) {
      await restoreStagePlotOriginal(file, bytes);
      applied.push(`${dir}/${file}`);
    }
    return applied;
  }

  // ── Saved (named) snapshots ────────────────────────────────────────────

  private metaOf(id: string, b: ConfigSnapshot): SnapshotMeta {
    return {
      id,
      name: b.name || "Untitled",
      createdAt: b.createdAt,
      appVersion: b.appVersion,
      fileCount: Object.keys(b.files ?? {}).length,
      serverId: serverIdIn(b.files?.["settings.json"]),
      carriesScreens: Object.hasOwn(b.files ?? {}, "settings.json"),
      carriesBindings: Object.hasOwn(b.files ?? {}, BINDINGS_FILE),
    };
  }

  async list(): Promise<SnapshotMeta[]> {
    let entries: string[];
    try {
      entries = (await fs.readdir(this.snapshotsDir())).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }
    const out: SnapshotMeta[] = [];
    for (const file of entries) {
      try {
        const b = JSON.parse(await fs.readFile(path.join(this.snapshotsDir(), file), "utf8")) as ConfigSnapshot;
        out.push(this.metaOf(file.replace(/\.json$/, ""), b));
      } catch {
        /* skip unreadable */
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async save(name: string): Promise<SnapshotMeta> {
    const id = randomUUID();
    const bundle = await this.build(name.trim() || "Untitled");
    await fs.mkdir(this.snapshotsDir(), { recursive: true });
    await atomicWrite(path.join(this.snapshotsDir(), `${id}.json`), JSON.stringify(bundle, null, 2));
    return this.metaOf(id, bundle);
  }

  async get(id: string): Promise<ConfigSnapshot> {
    if (!/^[A-Za-z0-9-]+$/.test(id)) throw new Error("Invalid snapshot id.");
    const raw = await fs.readFile(path.join(this.snapshotsDir(), `${id}.json`), "utf8");
    return JSON.parse(raw) as ConfigSnapshot;
  }

  async delete(id: string): Promise<void> {
    if (!/^[A-Za-z0-9-]+$/.test(id)) throw new Error("Invalid snapshot id.");
    await fs.rm(path.join(this.snapshotsDir(), `${id}.json`), { force: true });
  }

  /** Apply a saved snapshot by id (caller restarts after). */
  async recall(id: string, opts: RestoreOptions = KEEP_OWN_ID): Promise<string[]> {
    return this.apply(await this.get(id), opts);
  }
}

export const configSnapshot = new ConfigSnapshotService();
