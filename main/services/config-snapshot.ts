// config-snapshot.ts — Save/recall + download/upload the ENTIRE server config.
//
// A snapshot bundles every persisted config store (views, custom layouts, slots,
// presets, layout templates, integration configs incl. hosts/ports/names, wireless
// + OSC targets, branding, display options). Secrets are DELIBERATELY excluded —
// `secrets.bin`/`encryption.key` never leave the box, so a downloaded/saved
// snapshot is safe to store; on recall the operator re-enters API keys/passwords.
// Recorded history (SPL/attendance/timeline, the automation log, baptism sessions) is
// runtime data rather than config, so it is excluded — see RUNTIME_FILES.
//
// Applying a snapshot writes the files then the server restarts (handled by the
// route) so every integration cleanly re-initializes from the restored config.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { getUserDataPath } from "./app-paths.js";

// main/services/config-snapshot.ts → repo root is two levels up.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Config stores included in a snapshot (allowlist — anything else is ignored on
 *  apply, which also blocks path traversal). NB: secrets.bin / encryption.key are
 *  intentionally NOT here.
 *
 *  A store missing from this list is silently excluded from export AND import, so
 *  the omission stays invisible until someone restores a backup and finds their
 *  work gone. `config-snapshot.test.ts` scans main/services for every DataStore and
 *  fails unless it appears here or in RUNTIME_FILES — adding a store without
 *  classifying it breaks CI. */
export const CONFIG_FILES = [
  "settings.json",
  "views.json",
  "slots.json",
  "layout-templates.json",
  "layout-groups.json",
  "presets.json",
  "wireless-connections.json",
  "osc-targets.json",
  "rosstalk-targets.json",
  "rosstalk-settings.json",
  "automation-rules.json",
  "automation-settings.json",
  "scriptview-layouts.json",
  "scriptview-config.json",
  "scriptview-roles.json",
  "baptism-triggers.json",
  "patch.json",
] as const;

/** Stores deliberately excluded: recorded history and logs, which are observations
 *  of what happened rather than configuration. Restoring them onto another install
 *  would fabricate services that machine never ran. Listed explicitly so the drift
 *  test can tell "considered and excluded" from "forgotten". */
export const RUNTIME_FILES = [
  "spl-history.json",
  "attendance-history.json",
  "service-timeline.json",
  "automation-log.json",
  // { current, sessions } — an in-progress session plus finished records.
  // Restoring it onto another install would fabricate baptisms that never happened.
  "baptism.json",
] as const;

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
}

/** Lightweight metadata for listing saved snapshots (no file contents). */
export interface SnapshotMeta {
  id: string;
  name: string;
  createdAt: string;
  appVersion: string;
  fileCount: number;
}

function pkgVersion(): string {
  try {
    return JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
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

  /** Build a snapshot of the live config (secrets excluded). */
  async build(name?: string): Promise<ConfigSnapshot> {
    const files: Record<string, unknown> = {};
    for (const f of CONFIG_FILES) {
      const v = await this.readFile(f);
      if (v !== undefined) files[f] = v;
    }
    return {
      kind: SNAPSHOT_KIND,
      version: SNAPSHOT_VERSION,
      appVersion: pkgVersion(),
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
    const applied: string[] = [];
    for (const [name, contents] of Object.entries(bundle.files)) {
      if (!(CONFIG_FILES as readonly string[]).includes(name)) continue; // allowlist only
      if (contents === undefined || contents === null) continue;
      const dest = path.join(getUserDataPath(), name);
      await fs.writeFile(dest, JSON.stringify(contents, null, 2), "utf8");
      applied.push(name);
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
