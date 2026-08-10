// backup-scheduler.ts — unattended backups on an interval the operator picks.
//
// Writes a config snapshot and, optionally, a data archive into a destination
// directory, keeping the most recent N of each and deleting the rest.
//
// The destination is a plain path, which is what makes off-box storage possible
// without this file knowing anything about it: point it at a mounted SMB or NFS
// share and the backups land on the NAS. No credentials here, no protocol
// implementation, nothing to keep maintained.
//
// Two safeguards worth naming. The due-time is persisted, so a box that is off for
// a week runs one backup on the next boot rather than none — and equally not one
// per missed interval. And a run that fails leaves the previous backups untouched:
// pruning happens after a successful write, never before.

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { buildArchive } from "./archive/archive-bundle.js";
import { getUserDataPath } from "./app-paths.js";
import { configSnapshot } from "./config-snapshot.js";
import { settingsStore } from "./settings-store.js";

export interface BackupSchedule {
  enabled: boolean;
  /** How often to run, in days. */
  intervalDays: number;
  /** How many of each kind to keep. */
  keep: number;
  /** Also write the (much larger) data archive. */
  includeArchive: boolean;
  /** Where to write. Blank = `<data>/backups`. A mounted share puts them off-box. */
  destination: string;
  /** ISO time of the last successful run, for the UI and for scheduling. */
  lastRunAt?: string | null;
  /** Why the last run failed, or null when it succeeded. */
  lastError?: string | null;
}

export const DEFAULT_BACKUP_SCHEDULE: BackupSchedule = {
  enabled: false,
  intervalDays: 7,
  keep: 10,
  includeArchive: true,
  destination: "",
  lastRunAt: null,
  lastError: null,
};

/** How often to check whether a backup is due. Coarse on purpose — the interval
 *  is measured in days, so a missed minute never matters. */
const TICK_MS = 15 * 60_000;

const CONFIG_PREFIX = "config-";
const ARCHIVE_PREFIX = "archive-";

function clampSchedule(s: Partial<BackupSchedule>): Partial<BackupSchedule> {
  const out = { ...s };
  if (out.intervalDays != null) out.intervalDays = Math.min(365, Math.max(1, Math.round(out.intervalDays)));
  if (out.keep != null) out.keep = Math.min(100, Math.max(1, Math.round(out.keep)));
  if (out.destination != null) out.destination = out.destination.trim();
  return out;
}

/** A filename-safe stamp, so the newest sorts last and a name never collides. */
function stamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-").replace("Z", "");
}

class BackupScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  async getSchedule(): Promise<BackupSchedule> {
    const s = await settingsStore.load();
    return { ...DEFAULT_BACKUP_SCHEDULE, ...(s.backupSchedule ?? {}) };
  }

  async setSchedule(partial: Partial<BackupSchedule>): Promise<BackupSchedule> {
    const next = { ...(await this.getSchedule()), ...clampSchedule(partial) };
    await settingsStore.patch({ backupSchedule: next });
    this.start(); // pick up a changed interval without waiting for the old one
    return next;
  }

  /** Where backups are written. Blank destination keeps them in the data dir. */
  async destinationDir(): Promise<string> {
    const { destination } = await this.getSchedule();
    return destination || path.join(getUserDataPath(), "backups");
  }

  start(): void {
    this.stop();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
    void this.tick(); // catch up on a boot that missed one
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    const sched = await this.getSchedule();
    if (!sched.enabled) return;
    if (!isDue(sched, Date.now())) return;
    await this.runNow();
  }

  /**
   * Write one backup set. Also the "Back up now" button.
   *
   * `lastRunAt` advances only on success, so a failing destination — an unmounted
   * share, a full disk — is retried on the next tick instead of being silently
   * skipped for a whole interval.
   */
  async runNow(): Promise<BackupSchedule> {
    if (this.running) return this.getSchedule();
    this.running = true;
    try {
      const sched = await this.getSchedule();
      const dir = await this.destinationDir();
      await fs.mkdir(dir, { recursive: true });
      const at = stamp(new Date());

      const bundle = await configSnapshot.build(`Automatic ${at}`);
      await fs.writeFile(path.join(dir, `${CONFIG_PREFIX}${at}.json`), JSON.stringify(bundle, null, 2), "utf8");

      if (sched.includeArchive) {
        await fs.writeFile(path.join(dir, `${ARCHIVE_PREFIX}${at}.zip`), Buffer.from(await buildArchive()));
      }

      // Only after a successful write — a failed run must not delete the copies
      // that are still good.
      await prune(dir, CONFIG_PREFIX, sched.keep, ".json");
      if (sched.includeArchive) await prune(dir, ARCHIVE_PREFIX, sched.keep, ".zip");

      console.log(`[backup] wrote ${at} to ${dir}`);
      return this.persistResult(sched, { lastRunAt: new Date().toISOString(), lastError: null });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[backup] failed:", msg);
      return this.persistResult(await this.getSchedule(), { lastError: msg });
    } finally {
      this.running = false;
    }
  }

  private async persistResult(sched: BackupSchedule, patch: Partial<BackupSchedule>): Promise<BackupSchedule> {
    const next = { ...sched, ...patch };
    await settingsStore.patch({ backupSchedule: next });
    return next;
  }
}

/** Is a backup due? Never run means yes, so enabling it produces one promptly. */
export function isDue(sched: BackupSchedule, now: number): boolean {
  if (!sched.lastRunAt) return true;
  const last = Date.parse(sched.lastRunAt);
  if (!Number.isFinite(last)) return true; // unparseable — treat as never run
  return now - last >= sched.intervalDays * 24 * 60 * 60 * 1000;
}

/**
 * Files this scheduler itself wrote: prefix + the exact stamp + extension.
 *
 * A bare `startsWith(prefix)` was not good enough to delete by. The destination
 * is a plain path so it can point at a share, and an operator pointing it at an
 * existing backups folder on the NAS — which is the obvious thing to do — could
 * already hold `config-2024.json` or `archive-old.zip` from another tool. prune
 * would delete those on its first successful run, silently. The project's rule is
 * that an operator's data is never deleted to tidy something up, and a file this
 * app did not write is by definition theirs.
 */
export function ownBackupPattern(prefix: string, ext: string): RegExp {
  return new RegExp(`^${prefix}\\d{4}-\\d{2}-\\d{2}T[\\d-]+\\${ext}$`);
}

/** Delete all but the newest `keep` files this scheduler wrote with `prefix`. */
export async function prune(dir: string, prefix: string, keep: number, ext: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const pattern = ownBackupPattern(prefix, ext);
  // The stamp is lexicographically ordered, so a plain sort is newest-last.
  const mine = names.filter((n) => pattern.test(n)).sort();
  const doomed = mine.slice(0, Math.max(0, mine.length - Math.max(1, keep)));
  for (const n of doomed) await fs.rm(path.join(dir, n), { force: true });
  return doomed;
}

export const backupScheduler = new BackupScheduler();
