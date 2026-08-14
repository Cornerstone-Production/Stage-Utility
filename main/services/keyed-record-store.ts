// keyed-record-store.ts — one file per service record, instead of one file for all.
//
// The history stores held every service in a single JSON document, and DataStore
// rewrites the whole document on every save. Persisting one live service therefore
// rewrote the entire history — every four seconds, for the length of the service.
// The cost grew with the archive rather than the change: about 35 MB of writes per
// service today, ~600 MB after a year, ~3 GB after five, for the same handful of
// numbers changing each time.
//
// Splitting by key makes a write O(one service). It stays that size forever, which
// is the point: the previous shape got worse every week whether or not anything
// else changed.
//
// Records are cached in memory after the first read, so `list()` is no more
// expensive than it was — the saving is entirely on the write side.

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { getUserDataPath } from "./app-paths.js";
import { registerStore, type StoreClass } from "./store-registry.js";
import { atomicWrite } from "./write-queue.js";

/** Everything this store holds is addressed by `serviceKey`. */
export interface Keyed {
  serviceKey: string;
}

/** Filename-safe token for a key. serviceKey holds colons (`st:plan:time`), which
 *  are illegal on Windows and would let a crafted key escape the directory. */
function safeName(key: string): string {
  const s = key
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[-.]+|[-.]+$/g, "");
  return `${s || "unknown"}.json`;
}

export class KeyedRecordStore<T extends Keyed> {
  private cache: Map<string, T> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  /** In-flight load, so concurrent callers share one directory scan. */
  private loading: Promise<Map<string, T>> | null = null;
  /** Bumped by invalidate(), so an in-flight load cannot install a stale cache. */
  private loadGeneration = 0;

  /**
   * @param dirName   directory under the data dir, e.g. "spl-history"
   * @param legacyFile the single-document file this replaces, migrated on first use
   * @param startedAt  sort key for `list()` — newest first
   */
  /**
   * @param classification See DataStore. Registered under the LEGACY
   *   single-document filename, which still exists on older installs — so a
   *   snapshot reading it by name would silently capture that stale document and
   *   none of the per-service files. `kind: "directory"` is what lets
   *   configSnapshot refuse that rather than write a backup missing most of its
   *   content.
   */
  constructor(
    private readonly dirName: string,
    private readonly legacyFile: string,
    private readonly startedAt: (r: T) => string,
    classification: StoreClass,
  ) {
    registerStore({ filename: legacyFile, classification, kind: "directory" });
  }

  private dir(): string {
    return path.join(getUserDataPath(), this.dirName);
  }

  /** Serialise writes, so two concurrent upserts cannot interleave. */
  private enqueue<R>(fn: () => Promise<R>): Promise<R> {
    const result = this.chain.then(fn, fn);
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Fold the old single-document file into per-key files, once.
   *
   * The legacy file is renamed rather than deleted: it is the only copy of the
   * history until the split files are known good, and a rename is cheap insurance
   * against a bug here costing someone their records.
   */
  private async migrateLegacy(into: Map<string, T>): Promise<void> {
    const legacy = path.join(getUserDataPath(), this.legacyFile);
    let raw: string;
    try {
      raw = await fs.readFile(legacy, "utf8");
    } catch {
      return; // already migrated, or nothing was ever recorded
    }
    let parsed: { services?: Record<string, T> };
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error(`[${this.dirName}] legacy ${this.legacyFile} will not parse — leaving it in place`);
      return;
    }
    const records = Object.values(parsed.services ?? {});
    await fs.mkdir(this.dir(), { recursive: true });
    for (const r of records) {
      if (!r?.serviceKey) continue;
      // Do not clobber a per-key file that already exists — it is newer.
      if (into.has(r.serviceKey)) continue;
      await this.writeOne(r);
      into.set(r.serviceKey, r);
    }
    await fs.rename(legacy, `${legacy}.migrated`);
    console.log(`[${this.dirName}] split ${records.length} record(s) out of ${this.legacyFile}`);
  }

  private async writeOne(record: T): Promise<void> {
    const dir = this.dir();
    await fs.mkdir(dir, { recursive: true });
    // Through the shared helper, which names its scratch file uniquely. The
    // fixed `${file}.tmp` this used is the exact shape write-queue.ts exists to
    // remove: two writers to one key share the temp path, writeFile is not
    // atomic, and the first rename promotes a spliced file. DataStore and
    // secrets were converted; the store holding every recorded service was
    // missed — the same fix applied to two of its three call sites.
    await atomicWrite(path.join(dir, safeName(record.serviceKey)), JSON.stringify(record, null, 2));
  }

  private async loadAll(): Promise<Map<string, T>> {
    if (this.cache) return this.cache;
    // Concurrent callers share one load. list() and get() are not on the write
    // queue, so two arriving together each ran the whole read AND migrateLegacy
    // — which renames the legacy file out from under the other and writes the
    // same per-key files twice.
    if (!this.loading) {
      this.loading = this.loadOnce().finally(() => {
        this.loading = null;
      });
    }
    return this.loading;
  }

  private async loadOnce(): Promise<Map<string, T>> {
    // Captured before the awaits. invalidate() bumps it, so a load already in
    // flight when an import rewrites the directory returns its (now stale) map
    // to whoever asked but does NOT install it as the cache — which would
    // silently undo the invalidation it raced.
    const gen = this.loadGeneration;
    const map = new Map<string, T>();
    let names: string[] = [];
    try {
      names = await fs.readdir(this.dir());
    } catch {
      /* no directory yet */
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue; // skips .tmp leftovers
      try {
        const r = JSON.parse(await fs.readFile(path.join(this.dir(), name), "utf8")) as T;
        if (r?.serviceKey) map.set(r.serviceKey, r);
      } catch {
        console.error(`[${this.dirName}] ${name} will not parse — skipped`);
      }
    }
    await this.migrateLegacy(map);
    if (gen === this.loadGeneration) this.cache = map;
    return map;
  }

  /** All records, newest first. */
  async list(): Promise<T[]> {
    const map = await this.loadAll();
    return [...map.values()].sort((a, b) => Date.parse(this.startedAt(b)) - Date.parse(this.startedAt(a)));
  }

  async get(serviceKey: string): Promise<T | null> {
    return (await this.loadAll()).get(serviceKey) ?? null;
  }

  /** Insert or replace one record — writes exactly one file. */
  async upsert(record: T): Promise<void> {
    await this.enqueue(async () => {
      const map = await this.loadAll();
      await this.writeOne(record);
      map.set(record.serviceKey, record);
    });
  }

  /** Delete one record. Returns true if it existed. */
  async delete(serviceKey: string): Promise<boolean> {
    return this.enqueue(async () => {
      const map = await this.loadAll();
      if (!map.has(serviceKey)) return false;
      map.delete(serviceKey);
      await fs.rm(path.join(this.dir(), safeName(serviceKey)), { force: true });
      return true;
    });
  }

  /** Drop the in-memory copy — used after an import writes files behind our back. */
  invalidate(): void {
    this.cache = null;
    this.loading = null;
    this.loadGeneration += 1;
  }
}
