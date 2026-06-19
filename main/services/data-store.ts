// Generic JSON persistence over userData. Every store is an instance of this class.

import * as fs from "fs/promises";
import * as path from "path";

import { getUserDataPath } from "./app-paths.js";

export class DataStore<T> {
  private cache: T | null = null;
  private filePath: string | null = null;
  // Serializes writes so concurrent saves/updates can't interleave (the file
  // write isn't atomic) or clobber each other's read-modify-write. Critical
  // because `settings.json` is patched both by user actions and by background
  // tasks (the live poller advancing the plan), which would otherwise race.
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly filename: string,
    private readonly defaultValue: T,
  ) {}

  /** Run `fn` after all prior queued writes settle (success or failure). */
  private enqueue<R>(fn: () => Promise<R>): Promise<R> {
    const result = this.writeChain.then(fn, fn);
    // Keep the chain alive even if a write rejects.
    this.writeChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async writeRaw(data: T): Promise<void> {
    this.cache = data;
    const filePath = await this.getFilePath();
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
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
    try {
      const filePath = await this.getFilePath();
      const data = await fs.readFile(filePath, "utf-8");
      this.cache = JSON.parse(data) as T;
      return this.cache;
    } catch {
      // File doesn't exist yet — return defaults.
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
