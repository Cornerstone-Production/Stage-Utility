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

  test("an unchanged mutator does not touch the file", async () => {
    const { store, file } = freshStore();
    await store.save({ count: 1, items: ["a"] });
    const before = (await fs.stat(file)).mtimeMs;

    // Long enough that a real write could not land inside the same mtime tick.
    await new Promise((r) => setTimeout(r, 25));
    const returned = await store.update((current) => current);

    const after = (await fs.stat(file)).mtimeMs;
    assert.equal(after, before, "returning the same reference must not rewrite the file");
    assert.deepEqual(returned, { count: 1, items: ["a"] }, "the current value is still returned");
  });

  test("a changed mutator still writes", async () => {
    // The other half: the skip must not swallow a real edit.
    const { store, file } = freshStore();
    await store.save({ count: 1, items: ["a"] });
    const before = (await fs.stat(file)).mtimeMs;

    await new Promise((r) => setTimeout(r, 25));
    await store.update((current) => ({ ...current, count: 2 }));

    const after = (await fs.stat(file)).mtimeMs;
    assert.notEqual(after, before, "a real change must reach the disk");
    assert.equal(JSON.parse(await fs.readFile(file, "utf8")).count, 2);
  });
});
