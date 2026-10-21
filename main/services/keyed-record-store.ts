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
//
// A record file that is there and cannot be read (or parsed) is never replaced.
// Taken for absent, a recorder restarted mid-service found no record, began a
// fresh one, and its first save renamed over the file holding everything
// recorded before the restart. Its saves go to a `.held-<stamp>` file beside
// it instead, so the recording carries on and both copies survive.

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { getUserDataPath } from "./app-paths.js";
import { StoreReadError } from "./data-store.js";
import { errorMessage, isNotFound } from "./errors.js";
import { scrub } from "./scrub.js";
import { registerStore, type StoreClass } from "./store-registry.js";
import { atomicWrite } from "./write-queue.js";

/** One stamp per server run, so a held save from this run never replaces one
 *  an earlier run held for the same service. */
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, "-");

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
  /** The directory could not be listed, so any record may be one not read. */
  private dirFailure: StoreReadError | null = null;
  /** The legacy single-document file could not be read, so its records are
   *  missing from list(). Writes are unaffected: they never touch it. */
  private legacyFailure: StoreReadError | null = null;
  /** Record files, by filename, that are there and could not be read or
   *  parsed. Kept until the server restarts, even once a file reads again: the
   *  record saved since was built without it. */
  private unread = new Map<string, StoreReadError>();
  /** Files a save has already been held beside, so that is said once. */
  private heldLogged = new Set<string>();

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
    } catch (err) {
      if (isNotFound(err)) return; // already migrated, or nothing was ever recorded
      this.legacyUnread(new StoreReadError(this.legacyFile, err));
      return;
    }
    // The split files are written into a directory that could not be listed,
    // over files that may be there unread. Left for a start that can list it.
    if (this.dirFailure) return;
    let parsed: { services?: Record<string, T> };
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.legacyUnread(new StoreReadError(this.legacyFile, err, "will not parse"));
      return;
    }
    const records = Object.values(parsed.services ?? {});
    await fs.mkdir(this.dir(), { recursive: true });
    let leftUnread = 0;
    for (const r of records) {
      if (!r?.serviceKey) continue;
      // Do not clobber a per-key file that already exists — it is newer.
      if (into.has(r.serviceKey)) continue;
      // Nor one that is there and could not be read, which may be newer too.
      if (this.unread.has(safeName(r.serviceKey))) {
        leftUnread++;
        continue;
      }
      await this.writeOne(r);
      into.set(r.serviceKey, r);
    }
    // Kept under its own name while it holds a record not split out, so the
    // next start tries that one again.
    if (leftUnread > 0) return;
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
    } catch (err) {
      if (!isNotFound(err) && !this.dirFailure) {
        this.dirFailure = new StoreReadError(`The ${this.dirName} folder`, err);
        console.error(
          `[${this.dirName}] ${this.dirFailure.message}: ${errorMessage(err)}. History from it is missing, and every save to it goes to a .held file beside the one it would replace until the server restarts. Fix the permissions or the disk, then restart.`,
        );
      }
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue; // skips .tmp and .held leftovers
      let raw: string;
      try {
        raw = await fs.readFile(path.join(this.dir(), name), "utf8");
      } catch (err) {
        if (isNotFound(err)) continue; // removed since the listing
        this.markUnread(name, new StoreReadError(`${name} in ${this.dirName}`, err));
        continue;
      }
      try {
        const r = JSON.parse(raw) as T;
        if (r?.serviceKey) map.set(r.serviceKey, r);
      } catch (err) {
        this.markUnread(name, new StoreReadError(`${name} in ${this.dirName}`, err, "will not parse"));
      }
    }
    await this.migrateLegacy(map);
    if (gen === this.loadGeneration) this.cache = map;
    return map;
  }

  private markUnread(name: string, failure: StoreReadError): void {
    if (!this.unread.has(name)) {
      console.error(
        `[${this.dirName}] ${failure.message}: ${errorMessage(failure.cause)}. Left as it is, missing from history, and a save for that service goes to a .held file beside it until the server restarts. Fix the file, then restart.`,
      );
    }
    this.unread.set(name, failure);
  }

  /** The legacy file could not be read or parsed: left in place, and the
   *  history is incomplete without it. Said once. */
  private legacyUnread(failure: StoreReadError): void {
    if (this.legacyFailure) return;
    this.legacyFailure = failure;
    console.error(
      `[${this.dirName}] ${failure.message}: ${errorMessage(failure.cause)}. The services in it are missing from history, and it is left in place. Fix it, then restart.`,
    );
  }

  /** Why a save for this key may not replace its file, or null when it may. */
  private unreadFor(serviceKey: string): StoreReadError | null {
    return this.dirFailure ?? this.unread.get(safeName(serviceKey)) ?? null;
  }

  /**
   * Why this store's history is incomplete, or null when every file read: the
   * directory, the legacy file, or the first record file that could not be
   * read or parsed. list() answers from what did read; a caller whose answer
   * goes somewhere else (an export, an import deciding what is new) checks
   * this, or uses listStrict().
   */
  unreadable(): StoreReadError | null {
    return this.dirFailure ?? this.legacyFailure ?? this.unread.values().next().value ?? null;
  }

  /** list(), for a caller that must not answer from part of the history:
   *  throws the StoreReadError instead while any of it could not be read. */
  async listStrict(): Promise<T[]> {
    const out = await this.list();
    const failure = this.unreadable();
    if (failure) throw failure;
    return out;
  }

  /** Throws when this key's record could not be read, for an operator edit
   *  that would rewrite or remove it. */
  async assertReadable(serviceKey: string): Promise<void> {
    await this.loadAll();
    const failure = this.unreadFor(serviceKey);
    if (failure) throw failure;
  }

  /** All records, newest first. */
  async list(): Promise<T[]> {
    const map = await this.loadAll();
    return [...map.values()].sort((a, b) => Date.parse(this.startedAt(b)) - Date.parse(this.startedAt(a)));
  }

  async get(serviceKey: string): Promise<T | null> {
    return (await this.loadAll()).get(serviceKey) ?? null;
  }

  /**
   * Insert or replace one record — writes exactly one file.
   *
   * Beside it, never over it, when that file could not be read: see unread.
   * Not refused, because the recorders save through here and a recording must
   * carry on. The held copy is what list() and get() answer with from then on.
   */
  async upsert(record: T): Promise<void> {
    await this.enqueue(async () => {
      const map = await this.loadAll();
      const unread = this.unreadFor(record.serviceKey);
      if (unread) await this.writeHeld(record, unread);
      else await this.writeOne(record);
      map.set(record.serviceKey, record);
    });
  }

  private async writeHeld(record: T, unread: StoreReadError): Promise<void> {
    const name = safeName(record.serviceKey);
    const held = `${name}.held-${RUN_STAMP}`;
    await fs.mkdir(this.dir(), { recursive: true });
    await atomicWrite(path.join(this.dir(), held), JSON.stringify(record, null, 2));
    if (!this.heldLogged.has(name)) {
      this.heldLogged.add(name);
      console.error(
        `[${this.dirName}] saving ${scrub(record.serviceKey)} to ${held} rather than over ${name}, because ${unread.message}. Both are kept: fix the file, restart, and compare them.`,
      );
    }
  }

  /** Delete one record. Returns true if it existed. Throws, removing nothing,
   *  when its file could not be read. */
  async delete(serviceKey: string): Promise<boolean> {
    return this.enqueue(async () => {
      const map = await this.loadAll();
      const unread = this.unreadFor(serviceKey);
      if (unread) {
        throw new StoreReadError(
          `${safeName(serviceKey)} in ${this.dirName}`,
          unread.cause,
          "was not deleted: it could not be read since this server started",
        );
      }
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
