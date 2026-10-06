// Generic JSON persistence over userData. Every store is an instance of this class.

import * as fs from "fs/promises";
import * as path from "path";

import { getUserDataPath } from "./app-paths.js";
import { adoptLegacyStoreFile } from "./store-file-adoption.js";
import { registerStore, type RenamedFrom, type StoreClass } from "./store-registry.js";
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

  /**
   * @param classification Whether a config snapshot carries this store. Required
   *   on purpose: it used to be a separate hand-maintained list, and a store
   *   omitted from it was silently missing from every backup until an operator
   *   restored one and found their work gone. Now it cannot be forgotten.
   * @param options.renamedFrom The file this store read before a release renamed
   *   it. Before the first read or write, an old file with no new one beside it is
   *   moved into place (store-file-adoption.ts), so an upgrade does not start the
   *   store empty. Also what config-snapshot maps when an old backup is restored.
   * @param options.normalize Applied to what a load parses from disk, so a shape an
   *   older build wrote is read as today's. The file keeps the old shape until the
   *   next save, which writes the new one. It must be total: it runs on whatever
   *   the file held.
   */
  constructor(
    private readonly filename: string,
    private readonly defaultValue: T,
    classification: StoreClass,
    private readonly options: { renamedFrom?: RenamedFrom; normalize?: (parsed: T) => T } = {},
  ) {
    registerStore({ filename, classification, kind: "file", renamedFrom: options.renamedFrom });
  }

  /** Run `fn` after all prior queued writes settle (success or failure). */
  private enqueue<R>(fn: () => Promise<R>): Promise<R> {
    return this.writes.enqueue(fn);
  }

  private async writeRaw(data: T): Promise<void> {
    // The cache is set BEFORE the write, and that ordering is load-bearing:
    // load() is not enqueued, so a concurrent first read of a store that has
    // never been read would otherwise see cache === null, go to disk, and install
    // the pre-write contents over the fresh value once its readFile resolved —
    // losing the save. Assigning first keeps that read returning early.
    //
    // What was actually wrong was leaving the cache populated when the write
    // FAILED: on ENOSPC when the card fills, the UI, the API and every SSE
    // snapshot went on reporting the edit as saved, and after the next restart
    // everything since the disk filled was gone with no error ever shown. So the
    // cache is dropped on failure and the error propagates — the next read
    // re-reads from disk and the caller sees the failure.
    const previous = this.cache;
    this.cache = data;
    try {
      // Atomic: a plain writeFile truncates in place first, which could corrupt
      // the store mid-write and, on the next load, look like an empty file.
      // See write-queue.ts for why the temp name is unique.
      await atomicWrite(await this.getFilePath(), JSON.stringify(data, null, 2));
    } catch (err) {
      // Only roll back if nothing else has since written — a later save that did
      // land must not be undone by an earlier one failing.
      if (this.cache === data) this.cache = previous;
      throw err;
    }
  }

  private async getFilePath(): Promise<string> {
    if (!this.filePath) {
      const userDataPath = getUserDataPath();
      await fs.mkdir(userDataPath, { recursive: true });
      if (this.options.renamedFrom) {
        await adoptLegacyStoreFile(userDataPath, this.filename, this.options.renamedFrom);
      }
      this.filePath = path.join(userDataPath, this.filename);
    }
    return this.filePath;
  }

  async load(): Promise<T> {
    if (this.cache !== null) return this.cache;
    const filePath = await this.getFilePath();
    let raw: string | null = null;
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch {
      // File doesn't exist yet (first run) — safe to start from defaults.
    }
    // A save that ran while this read was in flight has already set the cache,
    // and what it set is newer than the bytes just read. writeRaw assigning
    // first only protects a read that STARTS after it; one already waiting on
    // the disk used to finish by installing the old bytes over the save, and
    // the next save — built on that stale cache — erased the first from disk.
    if (this.cache !== null) return this.cache;
    if (raw === null) {
      this.cache = this.defaultValue;
      return this.cache;
    }
    let parsed: T;
    try {
      parsed = JSON.parse(raw) as T;
    } catch (err) {
      // The file EXISTS but won't parse — corruption (e.g. a truncated write from a
      // crash). Do NOT silently fall back to defaults and then overwrite it, which
      // would destroy the data permanently. Preserve the bytes for recovery and log
      // loudly before continuing from defaults. (Atomic writes above make this rare.)
      //
      // Defaults are installed BEFORE the rename's await, for the reason above:
      // a save landing during the rename must win, not be overwritten after it.
      this.cache = this.defaultValue;
      try {
        await fs.rename(filePath, `${filePath}.corrupt-${Date.now()}`);
      } catch {
        /* best-effort backup */
      }
      console.error(
        `[data-store] ${this.filename} could not be parsed (corrupt). Backed up to ${this.filename}.corrupt-* and starting fresh — recover history from that copy.`,
        err,
      );
      // A save's whole write-plus-rename can complete between the defaults being
      // installed above and the quarantine rename actually running: it is the
      // SAVED file, not the corrupt one, that sits at `filePath` by then, and the
      // rename moves that aside instead — disk ends up with no store file at
      // all, though memory still serves the save correctly. If the cache no
      // longer holds the defaults this load just installed, that is what
      // happened: rewrite the live cache so the file exists again. Null is not
      // a save (reload() empties the cache). Awaiting the queue here cannot
      // wait on itself: a save only lands during the rename when the queue is
      // free to run it, so a load running inside the queue never gets here.
      if (this.cache !== null && this.cache !== this.defaultValue) {
        const rescued = this.cache;
        await this.enqueue(() => this.writeRaw(rescued)).catch((rescueErr: unknown) => {
          console.error(
            "[data-store] could not rewrite the save that landed during the corrupt-file quarantine; it is still correct in memory but missing on disk until the next save:",
            this.filename,
            rescueErr,
          );
        });
      }
      // reload() empties the cache, and can do it while this waited on the
      // rename. What this load found is still the defaults, not nothing.
      return this.cache ?? this.defaultValue;
    }
    // Outside the try on purpose: a normalizer that threw would otherwise be
    // read as a corrupt file and the operator's data quarantined for a bug of ours.
    this.cache = this.options.normalize ? this.options.normalize(parsed) : parsed;
    return this.cache;
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
      // A mutator that returns the value it was handed is saying "nothing
      // changed". Several callers depend on that meaning no disk write —
      // kiosk-devices-store's recordScreen/touch/pinSecret each return the same
      // array on purpose, because a probe every two seconds and a heartbeat
      // every twenty must not be an atomic write plus fsync onto a Pi's SD card
      // that often. Those comments described this guard before it existed.
      //
      // Reference equality, not deep equality: every other caller spreads into a
      // fresh object and so is unaffected, and a deep compare would cost more
      // than the write it saves on the large stores.
      if (next === current) return current;
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
