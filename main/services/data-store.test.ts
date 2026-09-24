// Tests for the JSON store that every persisted setting sits on.
//
// This is the highest-consequence pure-ish module in the app: it holds settings,
// slot layouts, patch sheets, and recorded service history. The three properties
// that matter are (1) a concurrent read-modify-write never loses an update,
// (2) an interrupted write never leaves a half-file, and (3) a corrupt file is
// preserved rather than silently replaced by defaults.

import assert from "node:assert/strict";
import { test, describe, after } from "node:test";
import * as fs from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";

// Point the store at a scratch dir BEFORE importing it — getUserDataPath()
// memoises on first access, so this cannot be changed later in the process.
//
// TMP itself exists (mkdtemp), but the data dir is a NOT-yet-created path beneath
// it, so every write here also exercises the recursive mkdir. HOME is pinned into
// the scratch dir as well: app-paths scans ~/.stage-display and ~/.stage-monitor
// for legacy config to migrate forward, and a developer's real home dir would
// otherwise leak into the tests.
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-utility-datastore-"));
const DATA_DIR = path.join(TMP, "nested", "deeper");
process.env.STAGE_UTILITY_DATA = DATA_DIR;
process.env.HOME = path.join(TMP, "home");

const { DataStore } = await import("./data-store.js");

after(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

interface Doc {
  count: number;
  items: string[];
}
const DEFAULTS: Doc = { count: 0, items: [] };

let n = 0;
/** A store backed by a filename unique to the calling test. */
function freshStore() {
  const name = `store-${n++}.json`;
  return { store: new DataStore<Doc>(name, DEFAULTS, "runtime"), file: path.join(DATA_DIR, name) };
}

describe("DataStore", () => {
  test("returns defaults when the file does not exist yet", async () => {
    const { store } = freshStore();
    assert.deepEqual(await store.load(), DEFAULTS);
  });

  test("saves and reads back through a fresh instance", async () => {
    const { store, file } = freshStore();
    await store.save({ count: 7, items: ["a"] });

    const reread = new DataStore<Doc>(path.basename(file), DEFAULTS, "runtime");
    assert.deepEqual(await reread.load(), { count: 7, items: ["a"] });
  });

  test("writes valid, pretty-printed JSON to disk", async () => {
    const { store, file } = freshStore();
    await store.save({ count: 1, items: ["x"] });
    const raw = await fs.readFile(file, "utf8");
    assert.deepEqual(JSON.parse(raw), { count: 1, items: ["x"] });
    assert.ok(raw.includes("\n"), "expected indented JSON for hand-editability");
  });

  test("leaves no .tmp file behind after a write", async () => {
    const { store, file } = freshStore();
    await store.save({ count: 1, items: [] });
    await assert.rejects(fs.access(`${file}.tmp`), "the temp file must be renamed away, not left on disk");
  });

  test("update applies a read-modify-write", async () => {
    const { store } = freshStore();
    await store.save({ count: 1, items: [] });
    const next = await store.update((c) => ({ ...c, count: c.count + 1 }));
    assert.equal(next.count, 2);
    assert.equal((await store.load()).count, 2);
  });

  // The reason update() exists instead of load()+save() at each call site.
  test("concurrent updates do not lose writes", async () => {
    const { store } = freshStore();
    await store.save({ count: 0, items: [] });

    await Promise.all(Array.from({ length: 50 }, () => store.update((c) => ({ ...c, count: c.count + 1 }))));

    assert.equal((await store.load()).count, 50, "a lost update means a dropped setting in production");
  });

  test("concurrent appends all survive", async () => {
    const { store } = freshStore();
    await store.save({ count: 0, items: [] });

    await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.update((c) => ({ ...c, items: [...c.items, `item-${i}`] }))),
    );

    const { items } = await store.load();
    assert.equal(items.length, 20);
    assert.equal(new Set(items).size, 20, "every concurrent append must be distinct and present");
  });

  // A store's first read is not on the write queue, so a save can land while the
  // read is still in flight. The read used to finish by installing the bytes it
  // had read — older than the save — as the cache, and the store served that
  // stale copy from then on. The NEXT save, built on it, erased the first from
  // disk as well. Found when a baptism session saved while the round-trip
  // harness first read the store vanished from both.
  test("a save that lands during the store's first read is not undone by it", async () => {
    for (let i = 0; i < 10; i++) {
      const { store, file } = freshStore();
      await fs.mkdir(DATA_DIR, { recursive: true });
      await fs.writeFile(file, JSON.stringify({ count: 1, items: ["old"] }), "utf8");

      const read = store.load(); // the first read, still in flight when...
      const write = store.save({ count: 2, items: ["saved"] }); // ...this lands
      await Promise.all([read, write]);

      assert.deepEqual(
        await store.load(),
        { count: 2, items: ["saved"] },
        "the store serves the save, not the bytes its first read began with",
      );
      await store.update((c) => ({ ...c, count: c.count + 1 }));
      assert.deepEqual(
        JSON.parse(await fs.readFile(file, "utf8")),
        { count: 3, items: ["saved"] },
        "the next save builds on the first, rather than erasing it from disk",
      );
    }
  });

  test("a failed write does not wedge the queue for later writers", async () => {
    const { store } = freshStore();
    await store.save({ count: 0, items: [] });

    await assert.rejects(store.update(() => {
      throw new Error("mutator blew up");
    }));

    // The chain must still accept work after a rejection.
    const next = await store.update((c) => ({ ...c, count: c.count + 1 }));
    assert.equal(next.count, 1);
  });

  test("a corrupt file is quarantined, not silently overwritten", async () => {
    const { store, file } = freshStore();
    await store.save({ count: 42, items: ["precious"] });

    // Simulate a truncated write from a crash, and drop the memo so we re-read.
    await fs.writeFile(file, '{"count": 42, "items": ["prec', "utf8");
    const reread = new DataStore<Doc>(path.basename(file), DEFAULTS, "runtime");

    assert.deepEqual(await reread.load(), DEFAULTS, "load must not throw on corruption");

    const backups = (await fs.readdir(DATA_DIR)).filter(
      (f) => f.startsWith(`${path.basename(file)}.corrupt-`),
    );
    assert.equal(backups.length, 1, "the corrupt bytes must be preserved for recovery");
    assert.ok(
      (await fs.readFile(path.join(DATA_DIR, backups[0]), "utf8")).includes("prec"),
      "the backup must contain the original bytes, not the defaults",
    );
  });

  test("reload discards the in-memory cache and re-reads from disk", async () => {
    const { store, file } = freshStore();
    await store.save({ count: 1, items: [] });

    // An out-of-band writer (another process) changes the file.
    await fs.writeFile(file, JSON.stringify({ count: 99, items: ["external"] }), "utf8");

    assert.equal((await store.load()).count, 1, "load should still serve the cache");
    assert.equal((await store.reload()).count, 99, "reload should see the external write");
  });

  test("the data directory is created on demand", async () => {
    // DATA_DIR is two levels below the scratch root and was never created by the
    // test, so the stores above only worked because the store mkdir -p's it.
    const st = await fs.stat(DATA_DIR);
    assert.ok(st.isDirectory(), "the store must create its data dir recursively");
  });
});

// A save racing the store's first read, on each path load() can take. The test
// above lets the race happen naturally, which reaches only the parse path; these
// hold one of the store's own fs calls open at the moment that matters, so each
// window is hit every run rather than by luck.
//
// data-store.ts imports `node:fs/promises` as an ES namespace, which Node re-reads
// from the builtin's CommonJS object only on syncBuiltinESMExports(). Replacing a
// method on that object and syncing is how a test reaches inside the store.
describe("a save racing the store's first read, on every path load() takes", () => {
  const fsp = createRequire(import.meta.url)("node:fs/promises") as Record<string, (...args: unknown[]) => Promise<unknown>>;

  function opened() {
    let open!: () => void;
    const promise = new Promise<void>((resolve) => (open = resolve));
    return { promise, open };
  }

  /**
   * Hold the first fs[method] call that `matches`. `after: true` holds it once
   * the real call has finished, so the store is parked between its disk access
   * and the code after it; `after: false` holds it before the call runs.
   * `reached` resolves when the call is being held.
   */
  function hold(method: "readFile" | "rename", matches: (args: unknown[]) => boolean, opts: { after: boolean }) {
    const real = fsp[method]!;
    const reached = opened();
    const gate = opened();
    let taken = false;
    fsp[method] = async (...args: unknown[]) => {
      if (taken || !matches(args)) return real(...args);
      taken = true;
      if (!opts.after) {
        reached.open();
        await gate.promise;
        return real(...args);
      }
      let result: unknown;
      let failure: unknown = null;
      try {
        result = await real(...args);
      } catch (err) {
        failure = err;
      }
      reached.open();
      await gate.promise;
      if (failure) throw failure;
      return result;
    };
    syncBuiltinESMExports();
    return {
      reached: reached.promise,
      release: () => gate.open(),
      restore: () => {
        fsp[method] = real;
        syncBuiltinESMExports();
      },
    };
  }

  const SAVED: Doc = { count: 2, items: ["saved"] };

  /** After the race: the store serves the save, and the next save builds on it. */
  async function assertSaveSurvives(store: InstanceType<typeof DataStore<Doc>>, file: string) {
    assert.deepEqual(await store.load(), SAVED, "the store serves the save, not what its first read found");
    await store.update((c) => ({ ...c, count: c.count + 1 }));
    assert.deepEqual(
      JSON.parse(await fs.readFile(file, "utf8")),
      { count: 3, items: ["saved"] },
      "the next save builds on the first, rather than erasing it from disk",
    );
  }

  test("no file yet: the first read's ENOENT does not install defaults over the save", async () => {
    const { store, file } = freshStore();
    await fs.mkdir(DATA_DIR, { recursive: true });
    const read = hold("readFile", (a) => a[0] === file, { after: true });
    try {
      const first = store.load();
      await read.reached; // the read has failed ENOENT and is parked there
      await store.save(SAVED);
      read.release();
      await first;
    } finally {
      read.restore();
    }
    await assertSaveSurvives(store, file);
  });

  test("a corrupt file: a save that replaced it during the read is not quarantined as corrupt", async () => {
    // Main quarantined the SAVE here: the read found the corrupt bytes, the save
    // renamed a good file over them, and the parse failure then moved that good
    // file aside and served defaults.
    const { store, file } = freshStore();
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(file, '{"count": 42, "items": ["prec', "utf8");
    const read = hold("readFile", (a) => a[0] === file, { after: true });
    try {
      const first = store.load();
      await read.reached; // the corrupt bytes are read, and the read is parked
      await store.save(SAVED);
      read.release();
      await first;
    } finally {
      read.restore();
    }
    // Read tolerantly: a file renamed aside is the defect, and should fail as this
    // assertion rather than as an ENOENT thrown before it.
    const onDisk = await fs.readFile(file, "utf8").catch(() => null);
    assert.deepEqual(
      onDisk === null ? null : JSON.parse(onDisk),
      SAVED,
      "the save's file is still in place — not renamed aside as corrupt",
    );
    await assertSaveSurvives(store, file);
  });

  test("a corrupt file: a save landing during the quarantine rename is not overwritten by defaults", async () => {
    const { store, file } = freshStore();
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(file, '{"count": 42, "items": ["prec', "utf8");
    const quarantine = hold("rename", (a) => String(a[1]).includes(".corrupt-"), { after: false });
    try {
      const first = store.load();
      await quarantine.reached; // the parse failed; the rename aside is held
      await store.save(SAVED);
      quarantine.release();
      await first;
    } finally {
      quarantine.restore();
    }
    await assertSaveSurvives(store, file);
  });

  test("reload() during the quarantine rename does not make the first load resolve null", async () => {
    // reload() empties the cache while the first load waits on its rename; that
    // load then finished by returning the emptied cache — null, from a method
    // typed never to return it.
    const { store, file } = freshStore();
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(file, '{"count": 42, "items": ["prec', "utf8");
    const quarantine = hold("rename", (a) => String(a[1]).includes(".corrupt-"), { after: false });
    let reread: ReturnType<typeof hold> | null = null;
    try {
      const first = store.load();
      await quarantine.reached;
      reread = hold("readFile", (a) => a[0] === file, { after: true });
      const reloading = store.reload();
      await reread.reached; // reload() has emptied the cache and is mid-read
      quarantine.release();
      const resolved = await first;
      reread.release();
      await reloading;
      assert.deepEqual(resolved, DEFAULTS, "a corrupt file's first load resolves to the defaults, never null");
    } finally {
      quarantine.restore();
      reread?.restore();
    }
  });
});

describe("update() skips the write when the mutator changed nothing", () => {
  // The kiosk device store is built on this contract and says so three times in
  // prose: recordScreen, touch and pinSecret each return the IDENTICAL array
  // when nothing changed, and kiosk-devices-store.ts:265 states outright that
  // "the store skips the write for an unchanged value".
  //
  // It did not. update() called writeRaw() unconditionally, so a device probing
  // every two seconds and heartbeating every twenty was an atomic write plus
  // fsync each time, per device, onto the SD card a Pi boots from. The comments
  // described a guard that was never written.
  //
  // Every other caller spreads into a fresh object ({...cur}, {...file}) and so
  // can never hit this path — checked across all thirteen update() call sites in
  // main/. Only the kiosk mutators return the same reference, deliberately.

  // Proven by CONTENT, not by mtime. An earlier version of these compared
  // stat().mtimeMs before and after, which needed a 25ms sleep to outrun the
  // timestamp granularity -- a sleep in a test is a hint that the signal is a
  // proxy -- and CodeQL read the stat-then-read as a TOCTOU race, correctly, in
  // the sense that a file checked and then read is two different moments.
  //
  // Writing a sentinel out-of-band is both race-free and a STRICTER test: the
  // store's cache means update() never re-reads the file, so if it writes at all
  // it writes its cached value over the sentinel. The sentinel surviving is
  // direct evidence that nothing was written, rather than evidence that nothing
  // was written within a timestamp tick.

  test("an unchanged mutator does not touch the file", async () => {
    const { store, file } = freshStore();
    await store.save({ count: 1, items: ["a"] });

    // Out-of-band, behind the store's back. It never reads this -- load() serves
    // the cache -- so only a WRITE can destroy it.
    await fs.writeFile(file, '{"sentinel":true}', "utf8");

    const returned = await store.update((current) => current);

    assert.equal(
      await fs.readFile(file, "utf8"),
      '{"sentinel":true}',
      "returning the same reference must not rewrite the file",
    );
    assert.deepEqual(returned, { count: 1, items: ["a"] }, "the current value is still returned");
  });

  test("a changed mutator still writes", async () => {
    // The other half: the skip must not swallow a real edit.
    const { store, file } = freshStore();
    await store.save({ count: 1, items: ["a"] });
    await fs.writeFile(file, '{"sentinel":true}', "utf8");

    await store.update((current) => ({ ...current, count: 2 }));

    const written = JSON.parse(await fs.readFile(file, "utf8")) as Doc;
    assert.equal(written.count, 2, "a real change must reach the disk");
    assert.deepEqual(written.items, ["a"], "and must carry the rest of the record with it");
  });
});
