// Generic JSON persistence over userData. Every store is an instance of this class.

import * as fs from "fs/promises";
import * as path from "path";

import { getUserDataPath } from "./app-paths.js";
import { WriteQueue, atomicWrite } from "./write-queue.js";

export class DataStore<T> {
  private cache: T | null = null;
  private filePath: string | null = null;
  // Serializes writes so concurrent saves/updates can't interleave (the file
  // write isn't atomic) or clobber each other's read-modify-write. Critical
  // because `settings.json` is patched both by user actions and by background
  // tasks (the live poller advancing the plan), which would otherwise race.
  //
  // Shared with secrets.ts rather than duplicated: this store had the guard and
  // that one did not, which is how two concurrent saves there could splice a
  // secrets blob that no longer decrypted.
  private writes = new WriteQueue();

  constructor(
    private readonly filename: string,
    private readonly defaultValue: T,
  ) {}

  /** Run `fn` after all prior queued writes settle (success or failure). */
  private enqueue<R>(fn: () => Promise<R>): Promise<R> {
    return this.writes.enqueue(fn);
  }

  private async writeRaw(data: T): Promise<void> {
    // Atomic: a plain writeFile truncates in place first, which could corrupt the
    // store mid-write and, on the next load, look like an empty file — silently
    // destroying history. See write-queue.ts for why the temp name is unique.
    await atomicWrite(await this.getFilePath(), JSON.stringify(data, null, 2));
    // Cache only AFTER the write lands. Assigning first meant a failed write —
    // ENOSPC on a full card, EROFS once a card drops to read-only — left the
    // cache reporting a value that was never persisted: the settings UI, the API
    // and every SSE snapshot showed the edit as saved, and after the next restart
    // everything since the disk filled was gone with no error ever shown.
    this.cache = data;
  }

  private async getFilePath(): Promise<string> {
    if (!this.filePath) {
      const userDataPath = getUserDataPath();
      await fs.mkdir(userDataPath, { recursive: true });
      this.filePath = path.join(userDataPath, this.filename);
    }
    return this.filePath;
  }

  async load(): Promise<T> {
    if (this.cache !== null) return this.cache;
    const filePath = await this.getFilePath();
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch {
      // File doesn't exist yet (first run) — safe to start from defaults.
      this.cache = this.defaultValue;
      return this.cache;
    }
    try {
      this.cache = JSON.parse(raw) as T;
      return this.cache;
    } catch (err) {
      // The file EXISTS but won't parse — corruption (e.g. a truncated write from a
      // crash). Do NOT silently fall back to defaults and then overwrite it, which
      // would destroy the data permanently. Preserve the bytes for recovery and log
      // loudly before continuing from defaults. (Atomic writes above make this rare.)
      try {
        await fs.rename(filePath, `${filePath}.corrupt-${Date.now()}`);
      } catch {
        /* best-effort backup */
      }
      console.error(
        `[data-store] ${this.filename} could not be parsed (corrupt). Backed up to ${this.filename}.corrupt-* and starting fresh — recover history from that copy.`,
        err,
      );
      this.cache = this.defaultValue;
      return this.cache;
    }
  }

  async save(data: T): Promise<void> {
    await this.enqueue(() => this.writeRaw(data));
  }

  /**
   * Atomic read-modify-write, serialized against other save/update calls on this
   * store. Use this instead of load()+save() to avoid a lost-update race when two
   * writers patch the same file concurrently.
   */
  async update(mutate: (current: T) => T): Promise<T> {
    return this.enqueue(async () => {
      const current = await this.load();
      const next = mutate(current);
      await this.writeRaw(next);
      return next;
    });
  }

  /** Reload from disk, discarding the in-memory cache. */
  async reload(): Promise<T> {
    this.cache = null;
    return this.load();
  }
}
