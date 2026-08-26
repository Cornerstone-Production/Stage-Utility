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
import { listImages, readImage, restoreImage } from "./image-files.js";
import { configFilenames, storesOfClass } from "./stores.js";
import { atomicWrite } from "./write-queue.js";

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
const IMAGE_DIRS = [BRANDING_IMAGE_DIR, "layout-images"] as const;

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
 */
const REDACTED_FIELDS: Record<string, readonly string[]> = {
  "kiosk-devices.json": ["token"],
};

/** A store's contents with its secret fields emptied, ready to leave the machine. */
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
}

/** Lightweight metadata for listing saved snapshots (no file contents). */
export interface SnapshotMeta {
  id: string;
  name: string;
  createdAt: string;
  appVersion: string;
  fileCount: number;
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

/**
 * Quiet the things that write config on a timer, before a restore lands.
 *
 * Imported lazily: config-snapshot is pulled in by the backup scheduler at boot,
 * and a static import of the controller here would make that a cycle.
 */
async function pauseBackgroundWriters(): Promise<() => void> {
  // Logged, not swallowed: if either stop is ever renamed this would otherwise
  // proceed with the writers running and still report the restore as clean.
  const failed = (what: string) => (err: unknown) => {
    console.error(`[config-snapshot] could not quiet ${what} before restoring:`, err);
    return null;
  };
  // Awaited, where these used to be fire-and-forget. The imports are lazy to
  // break a cycle, not because the timing is unimportant: not waiting meant the
  // writes below could begin before the poller had actually stopped, which is
  // the race the stop exists to remove.
  const undos = await Promise.all([
    import("./live-poller.js")
      .then((m) => m.livePoller.pause())
      .catch(failed("the live poller")),
    import("./stage-controller.js")
      .then((m) => m.stageController.pauseBackgroundWork())
      .catch(failed("the stage controller")),
  ]);
  return () => {
    for (const undo of undos) undo?.();
  };
}

class ConfigSnapshotService {
  private snapshotsDir(): string {
    return path.join(getUserDataPath(), "snapshots");
  }

  /** Read + parse a config store file, or undefined if absent/unreadable. */
  private async readFile(name: string): Promise<unknown | undefined> {
    try {
      const raw = await fs.readFile(path.join(getUserDataPath(), name), "utf8");
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }

  /** Every uploaded image, as `<dir>/<file>` → base64. */
  private async readImages(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const dir of IMAGE_DIRS) {
      for (const file of await listImages(dir)) {
        const img = await readImage(dir, file);
        if (img) out[`${dir}/${file}`] = img.data.toString("base64");
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
    const images = await this.readImages();
    return {
      ...(Object.keys(images).length ? { images } : {}),
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
   * Write a snapshot's config files back to the data dir. Only allowlisted
   * filenames are written (ignores anything else — prevents path traversal and
   * stray writes). Returns the filenames applied. Caller restarts to apply.
   */
  async apply(bundle: unknown): Promise<string[]> {
    this.validate(bundle);

    // Nothing may write config while a restore is landing. The process exits
    // ~1.2s after this returns, and inside that window the live poller ticks
    // every 1–4s: an auto-advance calling settingsStore.patch() would read its
    // still-warm cache and write it straight back over the file just restored,
    // reporting success. Stopping the background writers first removes the race
    // at its source rather than trying to win it.
    const resumeBackgroundWriters = await pauseBackgroundWriters();
    try {
      return await this.writeSnapshot(bundle);
    } catch (err) {
      // Only on the failure path. A successful restore does not resume anything
      // because the process exits ~1.2s later — but a failed one returns to a
      // box that keeps serving, and leaving it with no poller froze every
      // display and stopped the recorders for good.
      resumeBackgroundWriters();
      throw err;
    }
  }

  /** The write half of `apply`, split out so the resume can wrap all of it. */
  private async writeSnapshot(bundle: ConfigSnapshot): Promise<string[]> {
    const applied: string[] = [];
    for (const [name, contents] of Object.entries(bundle.files)) {
      if (!configFiles().includes(name)) continue; // allowlist only
      if (contents === undefined || contents === null) continue;
      const dest = path.join(getUserDataPath(), name);
      // Atomic, for the reason data-store.ts spells out: a plain writeFile
      // truncates in place, so a power cut here leaves a short settings.json that
      // the next boot cannot parse, quarantines, and replaces with defaults —
      // losing the settings the operator restored this bundle to recover.
      await atomicWrite(dest, JSON.stringify(contents, null, 2));
      applied.push(name);
    }
    // Uploaded images, restored under their content-hashed names. The directory is
    // allowlisted the same way the store filenames are, so a crafted bundle cannot
    // write outside the image dirs.
    for (const [ref, b64] of Object.entries(bundle.images ?? {})) {
      const slash = ref.indexOf("/");
      const dir = slash > 0 ? ref.slice(0, slash) : "";
      const file = slash > 0 ? ref.slice(slash + 1) : "";
      if (!(IMAGE_DIRS as readonly string[]).includes(dir)) continue;
      if (await restoreImage(dir, file, Buffer.from(b64, "base64"))) applied.push(ref);
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
    await fs.writeFile(path.join(this.snapshotsDir(), `${id}.json`), JSON.stringify(bundle, null, 2), "utf8");
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
  async recall(id: string): Promise<string[]> {
    return this.apply(await this.get(id));
  }
}

export const configSnapshot = new ConfigSnapshotService();
